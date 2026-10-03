// Rozpoznawanie formatów materiałów i ścieżek folderów - wspólne dla przeglądarki i serwera.

export type SourceKind = "text" | "image" | "pdf";

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** Formaty czytane jako tekst (bezpośrednio albo po wyciągnięciu tekstu z pliku). */
const TEXT_EXT = [".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".html", ".htm", ".rtf", ".xml", ".yaml", ".yml", ".srt", ".vtt"];
export const OFFICE = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

export const ACCEPT_ATTR =
  ".txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.rtf,.xml,.yaml,.yml,.srt,.vtt,.docx,.docm,.pptx,.pptm,.ppsx,.ppsm,.xlsx,.xlsm,.pdf,.jpg,.jpeg,.png,.webp,.gif,.tif,.tiff,.avif,.heic,.heif";

export function extOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}

/** Rozpoznaje rodzaj materiału po typie MIME i rozszerzeniu (null = nieobsługiwany). */
export function detectKind(filename: string, mediaType = ""): { kind: SourceKind; mediaType: string } | null {
  const ext = extOf(filename);
  if ((IMAGE_TYPES as readonly string[]).includes(mediaType)) return { kind: "image", mediaType };
  if (ext === ".jpg" || ext === ".jpeg") return { kind: "image", mediaType: "image/jpeg" };
  if (ext === ".png") return { kind: "image", mediaType: "image/png" };
  if (ext === ".webp") return { kind: "image", mediaType: "image/webp" };
  if (ext === ".gif") return { kind: "image", mediaType: "image/gif" };
  // Pozostałe obrazy (TIFF, AVIF) - serwer zamienia je na PNG/JPG.
  if ([".tif", ".tiff", ".avif"].includes(ext)) return { kind: "image", mediaType: ext === ".avif" ? "image/avif" : "image/tiff" };
  if (mediaType === "application/pdf" || ext === ".pdf") return { kind: "pdf", mediaType: "application/pdf" };
  // Warianty z makrami/pokazy mają tę samą budowę - czytamy je tak samo.
  if (ext === ".docx" || ext === ".docm") return { kind: "text", mediaType: OFFICE.docx };
  if ([".pptx", ".pptm", ".ppsx", ".ppsm"].includes(ext)) return { kind: "text", mediaType: OFFICE.pptx };
  if (ext === ".xlsx" || ext === ".xlsm") return { kind: "text", mediaType: OFFICE.xlsx };
  if (TEXT_EXT.includes(ext)) return { kind: "text", mediaType: mediaType.startsWith("text/") ? mediaType : "text/plain" };
  if (mediaType.startsWith("text/")) return { kind: "text", mediaType };
  return null;
}

/** Zdjęcia z iPhone'a - przeglądarka zamienia je na JPG przed wysłaniem. */
export function isHeic(name: string, type = ""): boolean {
  return /\.(heic|heif)$/i.test(name) || /image\/hei[cf]/i.test(type);
}

/**
 * Pliki systemowe i tymczasowe, które pomijamy bez pytania: ukryte pliki i foldery (.DS_Store, .obsidian, .Trashes),
 * __MACOSX, Thumbs.db, desktop.ini, pliki blokad Office (~$plik.docx), ikonki folderów macOS ("Icon\r").
 */
export function isJunkFile(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1] ?? "";
  if (parts.some((p) => p.startsWith(".") || p === "__MACOSX" || p === "node_modules" || p === "$RECYCLE.BIN" || p === "System Volume Information")) return true;
  if (name.startsWith("~$") || name === "Icon\r" || name === "Icon") return true;
  return ["thumbs.db", "desktop.ini", "ehthumbs.db"].includes(name.toLowerCase());
}

/** Podpowiedź dla nieobsługiwanych formatów. */
export function unsupportedHint(name: string): string {
  const ext = extOf(name);
  if (ext === ".doc") return "stary format Word - zapisz jako .docx lub PDF";
  if (ext === ".ppt") return "stary format PowerPoint - zapisz jako .pptx lub PDF";
  if (ext === ".xls") return "stary format Excel - zapisz jako .xlsx lub .csv";
  if ([".odt", ".pages", ".key", ".numbers"].includes(ext)) return "zapisz jako PDF";
  if ([".mp4", ".mov", ".avi", ".mkv", ".webm", ".mp3", ".m4a", ".wav"].includes(ext)) return "wideo/audio nie są obsługiwane - dodaj transkrypcję jako .txt";
  if ([".zip", ".rar", ".7z"].includes(ext)) return "rozpakuj archiwum i wgraj folder";
  return "nieobsługiwany format";
}

/** Krótki, stabilny skrót tekstu (FNV-1a) - do skracania długich nazw bez kolizji. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

const MAX_SEGMENT = 150;

/** Zbyt długą nazwę skracamy, zachowując rozszerzenie i dodając skrót całej nazwy (różne nazwy się nie zleją). */
function shortenSegment(seg: string): string {
  if (seg.length <= MAX_SEGMENT) return seg;
  const dot = seg.lastIndexOf(".");
  const ext = dot > 0 && seg.length - dot <= 10 ? seg.slice(dot) : "";
  return `${seg.slice(0, MAX_SEGMENT - ext.length - 9)}~${shortHash(seg).padStart(7, "0").slice(0, 7)}${ext}`;
}

/**
 * Bezpieczna ścieżka względna "Folder/Podfolder/plik.ext": bez "..", ukośników na początku i znaków sterujących.
 * Unicode w postaci NFC - ten sam folder z macOS (NFD) i z Windows daje tę samą ścieżkę.
 */
export function sanitizePath(raw: string): string {
  const parts = raw
    .normalize("NFC")
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => shortenSegment(p.replace(/[\u0000-\u001f\u007f]/g, "").trim()))
    .filter((p) => p && p !== "." && p !== "..");
  return parts.join("/") || "plik";
}

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export type TreeNode = { name: string; path: string; folders: TreeNode[]; files: { name: string; path: string; id: string }[] };

/** Drzewo folderów z listy ścieżek (foldery i pliki alfabetycznie). */
export function buildTree(items: { id: string; path: string }[]): TreeNode {
  const root: TreeNode = { name: "", path: "", folders: [], files: [] };
  for (const item of items) {
    const parts = item.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.find((f) => f.name === part);
      if (!next) {
        next = { name: part, path: node.path ? `${node.path}/${part}` : part, folders: [], files: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.files.push({ name: parts[parts.length - 1], path: item.path, id: item.id });
  }
  const sort = (n: TreeNode) => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name, "pl"));
    n.files.sort((a, b) => a.name.localeCompare(b.name, "pl"));
    n.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** Tekstowy podgląd struktury folderów (dla modelu). */
export function treeText(node: TreeNode, indent = ""): string {
  const lines: string[] = [];
  for (const f of node.folders) {
    lines.push(`${indent}${f.name}/`);
    lines.push(treeText(f, `${indent}  `));
  }
  for (const f of node.files) lines.push(`${indent}${f.name}`);
  return lines.filter(Boolean).join("\n");
}

export function countFiles(node: TreeNode): number {
  return node.files.length + node.folders.reduce((s, f) => s + countFiles(f), 0);
}
