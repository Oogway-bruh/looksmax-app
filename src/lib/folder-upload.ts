"use client";

// Zbieranie plików z wybranych/przeciągniętych folderów (z zachowaniem ścieżek) i przygotowanie ich do wysłania.
import { detectKind, isHeic, isJunkFile, sanitizePath, unsupportedHint } from "./file-types";

export type PickedFile = { file: File; path: string };
export type Skipped = { path: string; reason: string };

/** Pliki z <input type="file"> (także z wyborem folderu - wtedy mają webkitRelativePath). */
export function filesFromInput(list: FileList | null): PickedFile[] {
  return Array.from(list ?? []).map((file) => ({ file, path: sanitizePath(file.webkitRelativePath || file.name) }));
}

/**
 * Pliki z przeciągnięcia - także całe foldery z podfolderami.
 * Wpisy (webkitGetAsEntry) trzeba pobrać od razu w obsłudze zdarzenia, zanim lista elementów wygaśnie.
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

export async function filesFromEntries(entries: FileSystemEntry[]): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, path: sanitizePath(`${prefix}${entry.name}`) });
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries zwraca wyniki porcjami (np. po 100) - czytamy aż do pustej porcji.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

/** Odrzuca pliki systemowe (bez komunikatu) i nieobsługiwane formaty (z podpowiedzią). */
export function classify(files: PickedFile[]): { accepted: PickedFile[]; skipped: Skipped[]; junk: number } {
  const accepted: PickedFile[] = [];
  const skipped: Skipped[] = [];
  let junk = 0;
  for (const f of files) {
    if (isJunkFile(f.path)) junk++;
    else if (f.file.size === 0) skipped.push({ path: f.path, reason: "pusty plik" });
    else if (isHeic(f.path, f.file.type) || detectKind(f.path, f.file.type)) accepted.push(f);
    else skipped.push({ path: f.path, reason: unsupportedHint(f.path) });
  }
  return { accepted, skipped, junk };
}

/** Maks. wymiar obrazu: przy więcej niż 20 obrazach w jednym zapytaniu API wymaga ≤ 2000 px. */
const MAX_IMAGE_SIDE = 2000;

export type PreparedFile = { file: File; path: string; width?: number; height?: number };

/**
 * Obrazy: HEIC → JPG, zmniejszenie do 2000 px (z zachowaniem orientacji z EXIF).
 * Pozostałe pliki bez zmian. Ścieżka zostaje oryginalna (typ treści niesie MIME pliku),
 * żeby ponowne wgranie tego samego folderu rozpoznało te same pliki.
 */
export async function prepareForUpload({ file, path }: PickedFile): Promise<PreparedFile> {
  let blob: Blob = file;
  if (isHeic(path, file.type)) {
    const heic2any = (await import("heic2any")).default;
    const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
    blob = Array.isArray(converted) ? converted[0] : converted;
  }
  const kind = detectKind(path, blob.type || file.type);
  if (kind?.kind !== "image" || kind.mediaType === "image/gif") return { file: new File([blob], basenameOf(path), { type: blob.type || file.type }), path };

  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" }).catch(() => null);
  if (!bitmap) return { file: new File([blob], basenameOf(path), { type: kind.mediaType }), path };
  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height));
  // Mały obraz i rozsądny rozmiar pliku - zostawiamy oryginał (bez strat jakości tekstu na zrzutach).
  if (scale === 1 && blob.size < 4 * 1024 * 1024 && blob === file) {
    bitmap.close();
    return { file, path, width, height };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // PNG (zrzuty ekranu z tekstem) zostaje PNG, jeśli się mieści; zdjęcia jako JPG.
  const asPng = kind.mediaType === "image/png";
  let out = await new Promise<Blob | null>((r) => canvas.toBlob(r, asPng ? "image/png" : "image/jpeg", 0.92));
  if (out && asPng && out.size > 4 * 1024 * 1024) out = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.92));
  if (!out) return { file: new File([blob], basenameOf(path), { type: kind.mediaType }), path, width, height };
  return { file: new File([out], basenameOf(path), { type: out.type }), path, width: canvas.width, height: canvas.height };
}

function basenameOf(path: string) {
  return path.split("/").pop() || "plik";
}
