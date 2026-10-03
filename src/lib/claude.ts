import "server-only";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { z } from "zod";
import { ClaudeRefusalError, ClaudeTruncatedError, UserError } from "./errors";

export const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";

const client = new Anthropic();

export { ClaudeRefusalError, ClaudeTruncatedError } from "./errors";

function requireKey() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new UserError("Brak klucza API Anthropic - ustaw ANTHROPIC_API_KEY w pliku .env.local i uruchom aplikację ponownie.", 503);
  }
}

/** Wgrywa plik do Anthropic Files API (raz) - potem wskazujemy go w zapytaniach przez file_id. */
export async function uploadToFilesApi(data: Buffer, filename: string, type: string): Promise<string> {
  requireKey();
  // Nazwa pliku w Files API nie może zawierać m.in. / \ : * ? " < > |
  const safeName = filename.replace(/[<>:"|?*\\/\u0000-\u001f]/g, "_").slice(0, 200) || "plik";
  const uploaded = await client.files.upload({ file: await toFile(data, safeName, { type }) });
  return uploaded.id;
}

export async function deleteFromFilesApi(fileId: string) {
  try {
    await client.files.delete(fileId);
  } catch {
    // Plik mógł już nie istnieć (inny klucz API / usunięty) - nic do zrobienia.
  }
}

/** Właściwy komunikat z treści odpowiedzi API (err.message SDK zawiera też status i całe JSON-y). */
export function apiErrorMessage(err: unknown): string {
  if (!(err instanceof Anthropic.APIError)) return "";
  const body = err.error as { error?: { message?: unknown }; message?: unknown } | undefined;
  const msg = body?.error?.message ?? body?.message;
  return typeof msg === "string" ? msg : err.message;
}

/** Błąd zapytania o plik z Files API, którego już nie ma (np. zmiana klucza API na inny workspace). */
export function isMissingFileError(err: unknown): boolean {
  if (!(err instanceof Anthropic.NotFoundError || err instanceof Anthropic.BadRequestError)) return false;
  const msg = apiErrorMessage(err);
  return /\bfile/i.test(msg) && /not found|does not exist|no such|was deleted|has expired|expired/i.test(msg);
}

/**
 * Zapytanie odrzucone, bo jest za duże: za długi kontekst, za dużo obrazów/stron/dokumentów, za duży rozmiar.
 * Nie łapie innych błędów 400 (np. limity wydatków, nieprawidłowe max_tokens) - te mają dotrzeć do użytkownika.
 */
export function isRequestLimitError(err: unknown): boolean {
  if (err instanceof Anthropic.APIError && err.status === 413) return true;
  if (!(err instanceof Anthropic.BadRequestError)) return false;
  const msg = apiErrorMessage(err);
  if (/max_tokens|spend|credit|billing|balance|rate limit|quota/i.test(msg)) return false;
  return /prompt is too long|input is too long|too many (images|pages|documents|files|media)|context (window|length)|request (is )?too large|exceeds? the (maximum|max|limit)|many-image|maximum (number|of) (\d+ )?(images|pages|documents)|pdf pages/i.test(
    msg,
  );
}

/** Dokładny rozmiar zapytania w tokenach (bez wysyłania go do modelu). */
export async function countTokens(system: string, content: Anthropic.Beta.BetaContentBlockParam[]): Promise<number> {
  requireKey();
  const res = await client.beta.messages.countTokens({ model: MODEL, system, messages: [{ role: "user", content }] });
  return res.input_tokens;
}

/** Schemat Zod -> JSON Schema dla structured outputs (z zachowaniem enumów i bez dodatkowych pól). */
function toOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "output", unrepresentable: "throw" }) as Record<string, unknown>;
  delete json.$schema;
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (obj.type === "object") obj.additionalProperties = false;
      Object.values(obj).forEach(visit);
    }
  };
  visit(json);
  return json;
}

/**
 * Jedno wywołanie Claude ze strukturalną odpowiedzią (JSON zgodny ze schematem Zod).
 * Streaming, żeby długie odpowiedzi nie trafiały na timeout HTTP.
 */
export async function structuredCall<S extends z.ZodType>(opts: {
  schema: S;
  system: Anthropic.Beta.BetaTextBlockParam[];
  content: Anthropic.Beta.BetaContentBlockParam[];
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /** Wywoływane z kolejnymi fragmentami odpowiedzi (do pokazywania postępu) */
  onText?: (chunk: string) => void;
}): Promise<z.infer<S>> {
  requireKey();
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 64000,
    // Przy odmowie przez filtry bezpieczeństwa API samo ponawia zapytanie na zalecanym modelu zapasowym.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: opts.effort ?? "high", format: { type: "json_schema", schema: toOutputSchema(opts.schema) } },
    system: opts.system,
    messages: [{ role: "user", content: opts.content }],
  });
  if (opts.onText) stream.on("text", opts.onText);
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new ClaudeRefusalError("Model odmówił przetworzenia tego materiału.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new ClaudeTruncatedError("Odpowiedź modelu została ucięta (za dużo danych naraz).");
  }
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return opts.schema.parse(JSON.parse(text));
  } catch {
    throw new Error("Model nie zwrócił poprawnej odpowiedzi JSON.");
  }
}

/** Błąd po stronie zapytania (400/404/413) - np. problem z którymś z dołączonych plików. */
export function isClientRequestError(err: unknown): boolean {
  return err instanceof Anthropic.APIError && [400, 404, 413].includes(err.status ?? 0);
}
