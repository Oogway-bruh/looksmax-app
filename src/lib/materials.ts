import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { extractContent } from "./extract";
import { buildTree, treeText } from "./file-types";
import { imageTokens } from "./images";
import type { KnowledgeSource } from "./schema";
import { readSourceFile } from "./store";

type Block = Anthropic.Beta.BetaContentBlockParam;

export { detectKind } from "./file-types";
export { extractText } from "./extract";

/** Tokeny na stronę PDF (tekst + obraz strony) - z zapasem. */
const PDF_PAGE_TOKENS = 4500;
/** Maks. tekstu w jednej porcji (~100 tys. tokenów) - dłuższe pliki dzielimy na części. */
const TEXT_CHUNK_CHARS = 300_000;
/** Maks. obrazów z jednego dokumentu w jednej porcji. */
const IMAGES_PER_ITEM = 50;

/** Porcja materiału do wysłania: cały plik albo jego część (długi tekst, wiele obrazów). */
export type MaterialItem = {
  key: string;
  source: KnowledgeSource;
  blocks: Block[];
  tokens: number;
  images: number;
  pages: number;
};

const textTokens = (chars: number) => Math.ceil(chars / 3) + 30;

/** Dzieli długi tekst po akapitach (a w ostateczności po znakach) na części ≤ limit. */
export function splitText(text: string, limit = TEXT_CHUNK_CHARS): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const para of text.split(/\n(?=\s*\n)/)) {
    if (current && current.length + para.length > limit) {
      chunks.push(current);
      current = "";
    }
    if (para.length > limit) {
      for (let i = 0; i < para.length; i += limit) chunks.push(para.slice(i, i + limit));
      continue;
    }
    current += para;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/** Bloki obrazów (z file_id, jeśli są - inaczej base64 z dysku). Zwraca null, gdy brak pliku. */
async function partBlocks(source: KnowledgeSource, from: number, to: number, header: string): Promise<Block[]> {
  const parts = source.parts ?? [];
  const blocks: Block[] = [];
  for (let i = from; i < Math.min(to, parts.length); i++) {
    const p = parts[i];
    blocks.push({ type: "text", text: `${header}${parts.length > 1 ? ` - ${p.label}` : ""}:` });
    if (p.fileId) {
      blocks.push({ type: "image", source: { type: "file", file_id: p.fileId } });
    } else {
      const data = await readSourceFile(p.storedAs);
      if (data) blocks.push({ type: "image", source: { type: "base64", media_type: p.mediaType, data: data.toString("base64") } });
      else blocks.push({ type: "text", text: "[brak pliku obrazu na dysku]" });
    }
  }
  return blocks;
}

/** Porcje jednego materiału - cały plik, bez skracania (długie teksty i duże zbiory obrazów w kilku porcjach). */
export async function sourceItems(source: KnowledgeSource): Promise<MaterialItem[]> {
  const missing = (): MaterialItem[] => [
    { key: source.id, source, blocks: [{ type: "text", text: `<material plik="${source.path}">[brak pliku na dysku]</material>` }], tokens: 30, images: 0, pages: 0 },
  ];

  if (source.kind === "image") {
    const parts = source.parts ?? [];
    if (parts.length === 0) return missing();
    const header = `Materiał: ${source.path} (obraz - odczytaj cały tekst, tabele, schematy i oznaczenia)`;
    return [
      {
        key: source.id,
        source,
        blocks: await partBlocks(source, 0, parts.length, header),
        tokens: parts.reduce((n, p) => n + imageTokens(p.width, p.height), 0),
        images: parts.length,
        pages: 0,
      },
    ];
  }

  if (source.kind === "pdf") {
    const pages = source.pages ?? 1;
    if (source.fileId) {
      return [{ key: source.id, source, blocks: [{ type: "document", title: source.path, source: { type: "file", file_id: source.fileId } }], tokens: pages * PDF_PAGE_TOKENS, images: 0, pages }];
    }
    const data = await readSourceFile(source.storedAs);
    if (!data) return missing();
    return [
      {
        key: source.id,
        source,
        blocks: [{ type: "document", title: source.path, source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") } }],
        tokens: pages * PDF_PAGE_TOKENS,
        images: 0,
        pages,
      },
    ];
  }

  const data = await readSourceFile(source.storedAs);
  if (!data) return missing();
  const { text } = await extractContent(source, data);
  const chunks = splitText(text);
  const items: MaterialItem[] = chunks.map((chunk, i) => {
    const part = chunks.length > 1 ? ` czesc="${i + 1}/${chunks.length}"` : "";
    const body = `<material plik="${source.path}"${part}>\n${chunk}\n</material>`;
    return { key: `${source.id}#t${i}`, source, blocks: [{ type: "text", text: body }], tokens: textTokens(body.length), images: 0, pages: 0 };
  });
  // Obrazy osadzone w dokumencie (slajdy, Word, Excel) - po tekście, w porcjach.
  const parts = source.parts ?? [];
  for (let from = 0; from < parts.length; from += IMAGES_PER_ITEM) {
    const to = Math.min(parts.length, from + IMAGES_PER_ITEM);
    items.push({
      key: `${source.id}#i${from}`,
      source,
      blocks: await partBlocks(source, from, to, `Obraz osadzony w materiale ${source.path}`),
      tokens: parts.slice(from, to).reduce((n, p) => n + imageTokens(p.width, p.height), 0),
      images: to - from,
      pages: 0,
    });
  }
  return items;
}

/** Struktura folderów autora - na początek zapytania, żeby model znał jego sposób uporządkowania wiedzy. */
export function folderStructureBlock(sources: KnowledgeSource[]): Block {
  const tree = treeText(buildTree(sources.map((s) => ({ id: s.id, path: s.path }))));
  return { type: "text", text: `<struktura_folderow_autora>\n${tree}\n</struktura_folderow_autora>` };
}

export async function allItems(sources: KnowledgeSource[]): Promise<MaterialItem[]> {
  const sorted = [...sources].sort((a, b) => a.path.localeCompare(b.path, "pl"));
  return (await Promise.all(sorted.map(sourceItems))).flat();
}
