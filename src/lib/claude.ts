import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";

const client = new Anthropic();

export class ClaudeRefusalError extends Error {}

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
}): Promise<z.infer<S>> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("Brak klucza API Anthropic - ustaw ANTHROPIC_API_KEY w pliku .env.local.");
  }
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    // Przy odmowie przez filtry bezpieczeństwa API samo ponawia zapytanie na zalecanym modelu zapasowym.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: opts.effort ?? "high", format: { type: "json_schema", schema: toOutputSchema(opts.schema) } },
    system: opts.system,
    messages: [{ role: "user", content: opts.content }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new ClaudeRefusalError("Model odmówił przetworzenia tego materiału.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Odpowiedź modelu została ucięta (za dużo danych naraz) - podziel materiał na mniejsze części.");
  }
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return opts.schema.parse(JSON.parse(text));
  } catch {
    throw new Error("Model nie zwrócił poprawnej odpowiedzi JSON.");
  }
}
