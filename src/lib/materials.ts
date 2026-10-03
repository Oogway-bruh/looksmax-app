import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { KnowledgeSource } from "./schema";
import { readSourceFile } from "./store";

type Block = Anthropic.Beta.BetaContentBlockParam;

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

const TEXT_EXT = [".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".html", ".htm", ".rtf", ".xml", ".yaml", ".yml"];

/** Rozpoznaje rodzaj materiału po typie MIME i rozszerzeniu. */
export function detectKind(filename: string, mediaType: string): { kind: KnowledgeSource["kind"]; mediaType: string } | null {
  const name = filename.toLowerCase();
  const ext = name.slice(name.lastIndexOf("."));
  if ((IMAGE_TYPES as readonly string[]).includes(mediaType)) return { kind: "image", mediaType };
  if (ext === ".jpg" || ext === ".jpeg") return { kind: "image", mediaType: "image/jpeg" };
  if (ext === ".png") return { kind: "image", mediaType: "image/png" };
  if (ext === ".webp") return { kind: "image", mediaType: "image/webp" };
  if (mediaType === "application/pdf" || ext === ".pdf") return { kind: "pdf", mediaType: "application/pdf" };
  if (ext === ".docx") return { kind: "text", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  if (mediaType.startsWith("text/") || TEXT_EXT.includes(ext)) return { kind: "text", mediaType: mediaType || "text/plain" };
  return null;
}

async function docxToText(data: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: data });
  return value;
}

/** Treść jednego materiału jako bloki dla Claude (cały plik, bez skracania). */
export async function sourceBlocks(source: KnowledgeSource): Promise<Block[]> {
  const data = await readSourceFile(source.storedAs);
  const label = `Materiał: ${source.filename}`;
  if (!data) return [{ type: "text", text: `<material plik="${source.filename}">[brak pliku na dysku]</material>` }];
  if (source.kind === "image") {
    return [
      { type: "text", text: `${label} (obraz - odczytaj cały tekst, tabele, schematy i oznaczenia):` },
      { type: "image", source: { type: "base64", media_type: source.mediaType as ImageType, data: data.toString("base64") } },
    ];
  }
  if (source.kind === "pdf") {
    return [{ type: "document", title: source.filename, source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") } }];
  }
  const text = source.mediaType.includes("wordprocessingml") ? await docxToText(data) : data.toString("utf8");
  return [{ type: "text", text: `<material plik="${source.filename}">\n${text}\n</material>` }];
}

export async function allSourceBlocks(sources: KnowledgeSource[]): Promise<Block[]> {
  return (await Promise.all(sources.map(sourceBlocks))).flat();
}
