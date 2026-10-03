"use client";

// Zbieranie plików z wybranych/przeciągniętych folderów (z zachowaniem ścieżek) i przygotowanie ich do wysłania.
import { detectKind, isHeic, isJunkFile, sanitizePath, unsupportedHint } from "./file-types";

export type PickedFile = { file: File; path: string };
export type Skipped = { path: string; reason: string };

export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

/** Pliki z <input type="file"> (także z wyborem folderu - wtedy mają webkitRelativePath). */
export function filesFromInput(list: FileList | null, prefix = ""): PickedFile[] {
  return Array.from(list ?? []).map((file) => ({ file, path: sanitizePath(`${prefix ? `${prefix}/` : ""}${file.webkitRelativePath || file.name}`) }));
}

/**
 * Wpisy z przeciągnięcia - także całe foldery z podfolderami.
 * webkitGetAsEntry trzeba wywołać od razu w obsłudze zdarzenia, zanim lista elementów wygaśnie.
 */
export function entriesFromDrop(dt: DataTransfer): { entries: FileSystemEntry[]; files: File[] } {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  // Przeglądarki bez webkitGetAsEntry - tylko płaska lista plików.
  return { entries, files: entries.length ? [] : Array.from(dt.files ?? []) };
}

/** Rekurencyjne odczytanie przeciągniętych folderów; nieczytelne pozycje trafiają do `failed` zamiast przerywać całość. */
export async function filesFromEntries(entries: FileSystemEntry[], prefix = ""): Promise<{ files: PickedFile[]; failed: Skipped[] }> {
  const files: PickedFile[] = [];
  const failed: Skipped[] = [];
  const walk = async (entry: FileSystemEntry, dir: string): Promise<void> => {
    const path = `${dir}${entry.name}`;
    try {
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        files.push({ file, path: sanitizePath(path) });
        return;
      }
      if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        // readEntries zwraca wyniki porcjami (np. po 100) - czytamy aż do pustej porcji.
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
          if (batch.length === 0) break;
          for (const child of batch) await walk(child, `${path}/`);
        }
      }
    } catch {
      failed.push({ path: sanitizePath(path), reason: "nie udało się odczytać (brak dostępu lub plik w chmurze, niepobrany na dysk)" });
    }
  };
  for (const e of entries) await walk(e, prefix ? `${prefix}/` : "");
  return { files, failed };
}

/** Odrzuca pliki systemowe (bez komunikatu), nieobsługiwane formaty i zbyt duże pliki (z podpowiedzią). */
export function classify(files: PickedFile[]): { accepted: PickedFile[]; skipped: Skipped[]; junk: number } {
  const accepted: PickedFile[] = [];
  const skipped: Skipped[] = [];
  let junk = 0;
  for (const f of files) {
    if (isJunkFile(f.path)) junk++;
    else if (f.file.size === 0) skipped.push({ path: f.path, reason: "pusty plik" });
    else if (!(isHeic(f.path, f.file.type) || detectKind(f.path, f.file.type))) skipped.push({ path: f.path, reason: unsupportedHint(f.path) });
    else if (f.file.size > MAX_UPLOAD_BYTES && !detectKind(f.path, f.file.type)?.kind.startsWith("image")) {
      skipped.push({ path: f.path, reason: `plik większy niż ${MAX_UPLOAD_BYTES / 1024 / 1024} MB - podziel go na mniejsze części` });
    } else accepted.push(f);
  }
  return { accepted, skipped, junk };
}

/** SHA-256 oryginalnego pliku (null, gdy przeglądarka nie udostępnia crypto.subtle - np. strona po http z innego komputera). */
export async function hashFile(file: Blob): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** Obrazy wysyłamy z szerokością ≤ 2000 px (wysokość bez limitu - długie zrzuty serwer tnie na czytelne kawałki). */
const MAX_UPLOAD_WIDTH = 2000;
const MAX_UPLOAD_HEIGHT = 24000;

export type PreparedFile = { file: File; path: string };

const basenameOf = (path: string) => path.split("/").pop() || "plik";

/**
 * Przygotowanie do wysłania: HEIC → JPG (serwer nie odczyta HEIC), duże zdjęcia zmniejszone, żeby nie wysyłać
 * kilkunastu MB na plik. Ostateczną normalizację (≤ 2000 px, kawałki długich zrzutów) i tak robi serwer.
 * Ścieżka zostaje oryginalna - ponowne wgranie tego samego folderu rozpozna te same pliki.
 */
export async function prepareForUpload({ file, path }: PickedFile): Promise<PreparedFile> {
  let blob: Blob = file;
  if (isHeic(path, file.type)) {
    try {
      const heic2any = (await import("heic2any")).default;
      const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
      blob = Array.isArray(converted) ? converted[0] : converted;
    } catch {
      // Safari odczytuje HEIC sama; bywa też, że ".heic" to w rzeczywistości JPG.
      const bmp = await createImageBitmap(file).catch(() => null);
      if (!bmp) throw new Error("nie udało się przekonwertować zdjęcia HEIC - zapisz je jako JPG");
      blob = await bitmapToJpeg(bmp, 1);
    }
  }
  const kind = detectKind(path, blob.type || file.type);
  if (kind?.kind !== "image" || kind.mediaType === "image/gif") return { file: blob === file ? file : new File([blob], basenameOf(path), { type: blob.type }), path };

  const bitmap = await createImageBitmap(blob).catch(() => null);
  // Nie da się odczytać w przeglądarce - wysyłamy oryginał, serwer sprawdzi i ewentualnie zgłosi błąd.
  if (!bitmap) return { file: blob === file ? file : new File([blob], basenameOf(path), { type: blob.type }), path };
  const scale = Math.min(1, MAX_UPLOAD_WIDTH / bitmap.width, MAX_UPLOAD_HEIGHT / bitmap.height);
  if (scale === 1 && blob.size < 8 * 1024 * 1024) {
    bitmap.close();
    return { file: blob === file ? file : new File([blob], basenameOf(path), { type: blob.type }), path };
  }
  const keepPng = kind.mediaType === "image/png";
  const out = keepPng ? await bitmapToBlob(bitmap, scale, "image/png") : await bitmapToJpeg(bitmap, scale);
  if (keepPng && out.size > 8 * 1024 * 1024) {
    const bmp2 = await createImageBitmap(out);
    return { file: new File([await bitmapToJpeg(bmp2, 1)], basenameOf(path), { type: "image/jpeg" }), path };
  }
  return { file: new File([out], basenameOf(path), { type: out.type }), path };
}

async function bitmapToBlob(bitmap: ImageBitmap, scale: number, type: "image/png" | "image/jpeg"): Promise<Blob> {
  const canvas = document.createElement("canvas");
  try {
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("nie udało się przygotować obrazu");
    if (type === "image/jpeg") {
      // JPG nie ma przezroczystości - białe tło zamiast czarnego.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.92));
    if (!blob) throw new Error("nie udało się przygotować obrazu");
    return blob;
  } finally {
    bitmap.close();
    // Zwolnienie pamięci płótna (ważne w Safari przy setkach zdjęć).
    canvas.width = 0;
    canvas.height = 0;
  }
}

const bitmapToJpeg = (bitmap: ImageBitmap, scale: number) => bitmapToBlob(bitmap, scale, "image/jpeg");

/** Foldery główne wgrania (pierwszy fragment ścieżek) - do wykrywania plików usuniętych z tych folderów. */
export function uploadRoots(files: PickedFile[]): string[] {
  return [...new Set(files.filter((f) => f.path.includes("/")).map((f) => f.path.split("/")[0]))];
}
