import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { OFFICE, buildTree, treeText, type ImageType } from "./file-types";
import type { KnowledgeSource } from "./schema";
import { readSourceFile } from "./store";

type Block = Anthropic.Beta.BetaContentBlockParam;

export { detectKind } from "./file-types";

// --- Wyciąganie tekstu z plików biurowych ---

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

async function docxToText(data: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: data });
  return value;
}

/** Tekst ze slajdów PowerPointa (w kolejności slajdów), z notatkami prelegenta. */
async function pptxToText(data: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(data);
  const num = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  const out: string[] = [];
  for (const name of slides) {
    const xml = await zip.file(name)!.async("string");
    const paragraphs = xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).join(""));
    let text = `--- Slajd ${num(name)} ---\n${paragraphs.filter((p) => p.trim()).join("\n")}`;
    const notes = zip.file(`ppt/notesSlides/notesSlide${num(name)}.xml`);
    if (notes) {
      const nx = await notes.async("string");
      const nt = [...nx.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).join(" ").trim();
      if (nt) text += `\n[notatki: ${nt}]`;
    }
    out.push(text);
  }
  return out.join("\n\n");
}

/** Arkusze Excela jako tekst (wiersze, komórki oddzielone " | "). */
async function xlsxToText(data: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(data);
  const shared: string[] = [];
  const sst = zip.file("xl/sharedStrings.xml");
  if (sst) {
    const xml = await sst.async("string");
    for (const si of xml.split(/<\/si>/)) {
      const t = [...si.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => decodeXml(m[1])).join("");
      if (si.includes("<si")) shared.push(t);
    }
  }
  // Nazwy arkuszy z workbook.xml (kolejność jak w pliku).
  const wb = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const sheetNames = [...wb.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1]));
  const sheets = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
  const out: string[] = [];
  for (const [i, name] of sheets.entries()) {
    const xml = await zip.file(name)!.async("string");
    const rows = xml.split(/<\/row>/).flatMap((row) => {
      const cells = [...row.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((m) => {
        const attrs = m[1];
        const inner = m[2] ?? "";
        const v = inner.match(/<v>([^<]*)<\/v>/)?.[1];
        if (/t="s"/.test(attrs) && v != null) return shared[Number(v)] ?? "";
        if (/t="inlineStr"/.test(attrs)) return [...inner.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => decodeXml(x[1])).join("");
        return v != null ? decodeXml(v) : "";
      });
      return cells.some((c) => c.trim()) ? [cells.join(" | ")] : [];
    });
    out.push(`--- Arkusz: ${sheetNames[i] ?? i + 1} ---\n${rows.join("\n")}`);
  }
  return out.join("\n\n");
}

function htmlToText(html: string): string {
  return decodeXml(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " "),
  ).replace(/\n{3,}/g, "\n\n");
}

/** Cały tekst materiału tekstowego (dla Word/PowerPoint/Excel/HTML - wyciągnięty z pliku). */
export async function extractText(source: Pick<KnowledgeSource, "mediaType" | "path">, data: Buffer): Promise<string> {
  if (source.mediaType === OFFICE.docx) return docxToText(data);
  if (source.mediaType === OFFICE.pptx) return pptxToText(data);
  if (source.mediaType === OFFICE.xlsx) return xlsxToText(data);
  const text = data.toString("utf8").replace(/^﻿/, "");
  if (/\.html?$/i.test(source.path)) return htmlToText(text);
  return text;
}

/** Przybliżona liczba stron PDF (do pilnowania limitu 600 stron na zapytanie). */
export function estimatePdfPages(data: Buffer): number {
  const s = data.toString("latin1");
  const pages = s.match(/\/Type\s*\/Page(?![s\w])/g)?.length ?? 0;
  // PDF-y ze skompresowanymi obiektami nie pokazują stron wprost - szacujemy z rozmiaru (~100 KB/strona).
  return Math.max(1, pages || Math.ceil(data.length / 100_000));
}

// --- Szacowanie rozmiaru w tokenach (do dzielenia dużych zbiorów na części) ---

export function estimateTokens(source: KnowledgeSource, textLength?: number): number {
  if (source.kind === "image") {
    // ⌈w/28⌉ × ⌈h/28⌉, maks. 4784 (modele wysokiej rozdzielczości).
    if (source.width && source.height) return Math.min(4784, Math.ceil(source.width / 28) * Math.ceil(source.height / 28)) + 30;
    return 4784;
  }
  if (source.kind === "pdf") return (source.pages ?? 1) * 4500;
  return Math.ceil((textLength ?? source.size) / 3) + 30;
}

// --- Bloki treści dla Claude ---

/**
 * Treść jednego materiału jako bloki dla Claude (cały plik, bez skracania).
 * Obrazy i PDF-y idą przez Files API (fileId), jeśli jest - wtedy zapytanie nie przekracza limitu 32 MB.
 */
export async function sourceBlocks(source: KnowledgeSource): Promise<Block[]> {
  const label = `Materiał: ${source.path}`;
  if (source.kind === "image") {
    if (source.fileId) {
      return [{ type: "text", text: `${label} (obraz - odczytaj cały tekst, tabele, schematy i oznaczenia):` }, { type: "image", source: { type: "file", file_id: source.fileId } }];
    }
    const data = await readSourceFile(source.storedAs);
    if (!data) return [{ type: "text", text: `<material plik="${source.path}">[brak pliku na dysku]</material>` }];
    return [
      { type: "text", text: `${label} (obraz - odczytaj cały tekst, tabele, schematy i oznaczenia):` },
      { type: "image", source: { type: "base64", media_type: source.mediaType as ImageType, data: data.toString("base64") } },
    ];
  }
  if (source.kind === "pdf") {
    if (source.fileId) return [{ type: "document", title: source.path, source: { type: "file", file_id: source.fileId } }];
    const data = await readSourceFile(source.storedAs);
    if (!data) return [{ type: "text", text: `<material plik="${source.path}">[brak pliku na dysku]</material>` }];
    return [{ type: "document", title: source.path, source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") } }];
  }
  const data = await readSourceFile(source.storedAs);
  if (!data) return [{ type: "text", text: `<material plik="${source.path}">[brak pliku na dysku]</material>` }];
  return [{ type: "text", text: `<material plik="${source.path}">\n${await extractText(source, data)}\n</material>` }];
}

/** Struktura folderów autora - na początek zapytania, żeby model znał jego sposób uporządkowania wiedzy. */
export function folderStructureBlock(sources: KnowledgeSource[]): Block {
  const tree = treeText(buildTree(sources.map((s) => ({ id: s.id, path: s.path }))));
  return { type: "text", text: `<struktura_folderow_autora>\n${tree}\n</struktura_folderow_autora>` };
}

export async function allSourceBlocks(sources: KnowledgeSource[]): Promise<Block[]> {
  const sorted = [...sources].sort((a, b) => a.path.localeCompare(b.path, "pl"));
  return [folderStructureBlock(sorted), ...(await Promise.all(sorted.map(sourceBlocks))).flat()];
}
