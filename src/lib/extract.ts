import "server-only";
import type JSZipType from "jszip";
import { OFFICE } from "./file-types";

// Wyciąganie pełnego tekstu (i osadzonych obrazów) z materiałów autora.

// --- Kodowania i encje ---

/** Tekst z pliku: BOM UTF-8/UTF-16, a gdy to nie jest poprawny UTF-8 - polskie Windows-1250. */
export function decodeText(data: Buffer): string {
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return data.subarray(3).toString("utf8");
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data.subarray(2));
  // UTF-16 bez BOM: co drugi bajt zerowy w pierwszych znakach.
  const sample = data.subarray(0, 200);
  const zeros = sample.filter((b, i) => i % 2 === 1 && b === 0).length;
  if (sample.length >= 20 && zeros > sample.length / 2 - 4) return new TextDecoder("utf-16le").decode(data);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1250").decode(data);
  }
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»",
  bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", sbquo: "‚", deg: "°", plusmn: "±", times: "×", divide: "÷",
  middot: "·", bull: "•", euro: "€", copy: "©", reg: "®", trade: "™", frac12: "½", frac14: "¼", frac34: "¾", le: "≤", ge: "≥",
  ne: "≠", asymp: "≈", larr: "←", rarr: "→", uarr: "↑", darr: "↓", sup2: "²", sup3: "³", micro: "µ", para: "¶", sect: "§",
};

const codePoint = (n: number) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "");

/** Dekoduje encje XML/HTML w jednym przebiegu (bez podwójnego dekodowania "&amp;lt;"). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") return codePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) || m;
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
}

/** Excel zapisuje znaki sterujące jako _xHHHH_. */
const unescapeOoxml = (s: string) => s.replace(/_x([0-9a-f]{4})_/gi, (_, h) => (h === "000D" || h === "000d" ? "" : codePoint(parseInt(h, 16))));

// --- HTML ---

export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title|noscript|template|svg)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<\/(p|div|h[1-6]|li|tr|table|section|article|blockquote|pre|dt|dd|header|footer)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<img[^>]*alt="([^"]+)"[^>]*>/gi, "[obraz: $1]")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\| *\n/g, "\n")
    .replace(/\n /g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- RTF ---

/** Prosty odczyt RTF: tekst, polskie znaki (\'xx w Windows-1250/\uN), akapity; pomija obrazy i tabele stylów. */
export function rtfToText(rtf: string): string {
  const cp = rtf.match(/\\ansicpg(\d+)/)?.[1];
  const decoder = new TextDecoder(cp === "1250" || !cp ? "windows-1250" : `windows-${cp}`, { fatal: false });
  let out = "";
  let i = 0;
  const skipStack: boolean[] = [false];
  let ucSkip = 1;
  let pendingSkip = 0;
  const bytes: number[] = [];
  const flush = () => {
    if (bytes.length) {
      out += decoder.decode(Uint8Array.from(bytes));
      bytes.length = 0;
    }
  };
  while (i < rtf.length) {
    const ch = rtf[i];
    const skipping = skipStack[skipStack.length - 1];
    if (ch === "{") {
      flush();
      // Grupy "ignorowalne" ({\*\...}) i techniczne (czcionki, kolory, style, obrazy, metadane).
      const head = rtf.slice(i + 1, i + 14);
      skipStack.push(skipping || /^\\\*|^\\(fonttbl|colortbl|stylesheet|pict|info|listtable|listoverridetable|rsidtbl|themedata|datastore|latentstyles|generator|xmlnstbl|mmathPr)/.test(head));
      i++;
      continue;
    }
    if (ch === "}") {
      flush();
      if (skipStack.length > 1) skipStack.pop();
      i++;
      continue;
    }
    if (ch === "\\") {
      const next = rtf[i + 1];
      if (next === "'") {
        const hex = rtf.slice(i + 2, i + 4);
        if (!skipping) {
          if (pendingSkip > 0) pendingSkip--;
          else bytes.push(parseInt(hex, 16));
        }
        i += 4;
        continue;
      }
      if (next === "\\" || next === "{" || next === "}") {
        flush();
        if (!skipping) out += next;
        i += 2;
        continue;
      }
      const m = /^\\([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(i, i + 40));
      if (!m) {
        i += 2;
        continue;
      }
      const [token, word, arg] = m;
      i += token.length;
      flush();
      if (skipping) continue;
      if (word === "par" || word === "line" || word === "row") out += "\n";
      else if (word === "tab" || word === "cell") out += word === "cell" ? " | " : "\t";
      else if (word === "uc") ucSkip = Number(arg ?? 1);
      else if (word === "u") {
        let n = Number(arg);
        if (n < 0) n += 65536;
        out += codePoint(n);
        pendingSkip = ucSkip;
      } else if (word === "emdash") out += "—";
      else if (word === "endash") out += "–";
      else if (word === "bullet") out += "•";
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      i++;
      continue;
    }
    if (!skipping) {
      flush();
      if (pendingSkip > 0) pendingSkip--;
      else out += ch;
    }
    i++;
  }
  flush();
  return out.replace(/ *\| *\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// --- Pakiety Office (ZIP + XML) ---

async function loadZip(data: Buffer): Promise<JSZipType> {
  const JSZip = (await import("jszip")).default;
  return JSZip.loadAsync(data);
}

const readXml = async (zip: JSZipType, name: string) => (await zip.file(name)?.async("string")) ?? "";

/** Relacje części (r:id -> ścieżka w paczce), np. ppt/_rels/presentation.xml.rels. */
async function readRels(zip: JSZipType, partPath: string): Promise<Map<string, { target: string; type: string }>> {
  const dir = partPath.slice(0, partPath.lastIndexOf("/"));
  const relsPath = `${dir}/_rels/${partPath.slice(partPath.lastIndexOf("/") + 1)}.rels`;
  const xml = await readXml(zip, relsPath);
  const map = new Map<string, { target: string; type: string }>();
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const id = attrs.match(/\bId="([^"]+)"/)?.[1];
    const target = attrs.match(/\bTarget="([^"]+)"/)?.[1];
    const type = attrs.match(/\bType="([^"]+)"/)?.[1] ?? "";
    if (!id || !target || /TargetMode="External"/.test(attrs)) continue;
    map.set(id, { target: resolvePart(dir, decodeEntities(target)), type });
  }
  return map;
}

function resolvePart(dir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = dir ? dir.split("/") : [];
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** Tekst z XML-a DrawingML/WordprocessingML: akapity, łamania linii, tabele. */
function drawingXmlToText(xml: string): string {
  let out = "";
  const re = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:t\s*\/>|<a:br\b[^>]*\/>|<\/a:p>|<\/a:tc>|<\/a:tr>|<a:tab\b[^>]*\/>/g;
  for (const m of xml.matchAll(re)) {
    const tag = m[0];
    if (m[1] !== undefined) out += decodeEntities(m[1]);
    else if (tag.startsWith("<a:br")) out += "\n";
    else if (tag.startsWith("<a:tab")) out += "\t";
    else if (tag === "</a:p>") out += "\n";
    else if (tag === "</a:tc>") out += " | ";
    else if (tag === "</a:tr>") out += "\n";
  }
  // Koniec akapitu tuż przed końcem komórki to nie nowa linia, tylko granica komórek.
  return out
    .replace(/\n \| /g, " | ")
    .replace(/ \| \n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type EmbeddedImage = { path: string; label: string };

/** Slajdy w kolejności prezentacji (presentation.xml), z notatkami prelegenta i listą obrazów. */
async function pptx(zip: JSZipType): Promise<{ text: string; images: EmbeddedImage[] }> {
  const presRels = await readRels(zip, "ppt/presentation.xml");
  const pres = await readXml(zip, "ppt/presentation.xml");
  let slides = [...pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((m) => presRels.get(m[1])?.target).filter((t): t is string => Boolean(t));
  if (slides.length === 0) {
    // Zapas: numeracja plików.
    const num = (n: string) => Number(n.match(/(\d+)\.xml$/)?.[1] ?? 0);
    slides = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => num(a) - num(b));
  }
  const parts: string[] = [];
  const images: EmbeddedImage[] = [];
  for (const [i, slide] of slides.entries()) {
    const xml = await readXml(zip, slide);
    const rels = await readRels(zip, slide);
    let text = `--- Slajd ${i + 1} ---\n${drawingXmlToText(xml)}`;
    const notesRel = [...rels.values()].find((r) => r.type.endsWith("/notesSlide"));
    if (notesRel) {
      const notes = drawingXmlToText(await readXml(zip, notesRel.target))
        .split("\n")
        .filter((l) => l.trim() && !/^\d+$/.test(l.trim()))
        .join(" ");
      if (notes) text += `\n[notatki prelegenta: ${notes}]`;
    }
    parts.push(text);
    // Obrazy w kolejności występowania na slajdzie.
    let n = 0;
    for (const m of xml.matchAll(/r:embed="([^"]+)"/g)) {
      const rel = rels.get(m[1]);
      if (rel && rel.type.endsWith("/image") && !images.some((im) => im.path === rel.target)) images.push({ path: rel.target, label: `slajd ${i + 1}, obraz ${++n}` });
    }
  }
  return { text: parts.join("\n\n"), images };
}

/** Arkusze w kolejności skoroszytu, komórki na właściwych kolumnach (puste komórki nie przesuwają danych). */
async function xlsx(zip: JSZipType): Promise<{ text: string; images: EmbeddedImage[] }> {
  const shared: string[] = [];
  const sst = await readXml(zip, "xl/sharedStrings.xml");
  for (const si of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    // Bez <rPh> (fonetyka) - tylko właściwy tekst, także z formatowanych fragmentów <r>.
    const body = si[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    shared.push(unescapeOoxml([...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decodeEntities(m[1])).join("")));
  }
  const wbRels = await readRels(zip, "xl/workbook.xml");
  const wb = await readXml(zip, "xl/workbook.xml");
  let sheets = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({
    name: decodeEntities(m[1].match(/\bname="([^"]*)"/)?.[1] ?? ""),
    target: wbRels.get(m[1].match(/\br:id="([^"]+)"/)?.[1] ?? "")?.target,
  }));
  if (!sheets.some((s) => s.target)) {
    // Zapas dla nietypowych plików bez relacji: arkusze wg numeracji plików.
    const num = (n: string) => Number(n.match(/(\d+)\.xml$/)?.[1] ?? 0);
    sheets = Object.keys(zip.files)
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => num(a) - num(b))
      .map((target, i) => ({ name: sheets[i]?.name || String(i + 1), target }));
  }
  const colIndex = (ref: string) => {
    const letters = ref.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? "A";
    return [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
  };
  const out: string[] = [];
  for (const sheet of sheets) {
    if (!sheet.target || !/worksheets\//.test(sheet.target)) continue; // arkusze z wykresami nie mają danych
    const xml = await readXml(zip, sheet.target);
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      let auto = 0;
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] ?? "";
        const ref = attrs.match(/\br="([A-Z]+)\d+"/i)?.[1];
        const col = ref ? colIndex(ref) : auto;
        auto = col + 1;
        const t = attrs.match(/\bt="([^"]+)"/)?.[1];
        const v = inner.match(/<v>([^<]*)<\/v>/)?.[1];
        let value = "";
        if (t === "s" && v != null) value = shared[Number(v)] ?? "";
        else if (t === "inlineStr") value = unescapeOoxml([...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((x) => decodeEntities(x[1])).join(""));
        else if (t === "b") value = v === "1" ? "PRAWDA" : "FAŁSZ";
        else if (v != null) value = unescapeOoxml(decodeEntities(v));
        cells[col] = value;
      }
      const filled = Array.from(cells, (x) => x ?? "");
      while (filled.length && !filled[filled.length - 1].trim()) filled.pop();
      if (filled.some((x) => x.trim())) rows.push(filled.join(" | "));
    }
    out.push(`--- Arkusz: ${sheet.name} ---\n${rows.join("\n")}`);
  }
  // Obrazy osadzone w arkuszach (rysunki).
  const images = Object.keys(zip.files)
    .filter((n) => /^xl\/media\//.test(n))
    .sort()
    .map((p, i) => ({ path: p, label: `obraz ${i + 1}` }));
  return { text: out.join("\n\n"), images };
}

/** Word: tekst przez HTML (akapity, listy, tabele, przypisy), obrazy w kolejności w dokumencie. */
async function docx(zip: JSZipType, data: Buffer): Promise<{ text: string; images: EmbeddedImage[] }> {
  const mammoth = await import("mammoth");
  const { value: html } = await mammoth.convertToHtml({ buffer: data }, { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) });
  const rels = await readRels(zip, "word/document.xml");
  const doc = await readXml(zip, "word/document.xml");
  const images: EmbeddedImage[] = [];
  for (const m of doc.matchAll(/r:(?:embed|id)="([^"]+)"/g)) {
    const rel = rels.get(m[1]);
    if (rel && rel.type.endsWith("/image") && !images.some((im) => im.path === rel.target)) images.push({ path: rel.target, label: `obraz ${images.length + 1}` });
  }
  return { text: htmlToText(html), images };
}

export type Extracted = { text: string; images: { data: Buffer; label: string }[] };

/** Pełny tekst materiału tekstowego (+ obrazy osadzone w plikach Office). */
export async function extractContent(source: { mediaType: string; path: string }, data: Buffer): Promise<Extracted> {
  const office = Object.values(OFFICE).includes(source.mediaType as (typeof OFFICE)[keyof typeof OFFICE]);
  if (office) {
    const zip = await loadZip(data);
    const { text, images } =
      source.mediaType === OFFICE.pptx ? await pptx(zip) : source.mediaType === OFFICE.xlsx ? await xlsx(zip) : await docx(zip, data);
    const files = [];
    for (const im of images) {
      const f = zip.file(im.path);
      if (f) files.push({ data: Buffer.from(await f.async("uint8array")), label: im.label });
    }
    return { text, images: files };
  }
  const raw = decodeText(data);
  if (/\.html?$/i.test(source.path)) return { text: htmlToText(raw), images: [] };
  if (/\.rtf$/i.test(source.path) || raw.startsWith("{\\rtf")) return { text: rtfToText(raw), images: [] };
  return { text: raw, images: [] };
}

export async function extractText(source: { mediaType: string; path: string }, data: Buffer): Promise<string> {
  return (await extractContent(source, data)).text;
}
