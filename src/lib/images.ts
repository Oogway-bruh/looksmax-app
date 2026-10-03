import "server-only";
import sharp, { type Metadata, type Sharp } from "sharp";
import { UserError } from "./errors";

/**
 * Limity API dla obrazów: przy więcej niż 20 obrazach w zapytaniu każdy bok ≤ 2000 px,
 * a pojedynczy obraz najwyżej kilka MB. Dlatego każdy obraz normalizujemy na serwerze,
 * niezależnie od tego, co zrobiła przeglądarka.
 */
export const MAX_SIDE = 2000;
const MAX_PART_BYTES = 4.5 * 1024 * 1024;
const TILE_OVERLAP = 120;
const MAX_TILES = 12;

export type ImagePart = { data: Buffer; mediaType: "image/png" | "image/jpeg"; width: number; height: number };

/**
 * Przygotowuje obraz do wysłania do Claude:
 * - orientacja z EXIF, pierwsza klatka GIF-a, przezroczystość na białym tle,
 * - zwykłe obrazy: zmniejszenie do 2000×2000 px,
 * - długie zrzuty ekranu (np. przewijane czaty, artykuły): pocięcie na czytelne kawałki ≤ 2000 px
 *   z małą zakładką, zamiast zmniejszania tekstu do nieczytelności.
 */
export async function normalizeImage(input: Buffer, opts: { minSide?: number } = {}): Promise<{ parts: ImagePart[]; width: number; height: number; format: string }> {
  let meta: Metadata;
  try {
    meta = await sharp(input, { animated: false }).metadata();
  } catch {
    throw new UserError("nie udało się odczytać obrazu (uszkodzony lub nieobsługiwany format - zapisz jako JPG lub PNG)");
  }
  if (!meta.width || !meta.height) throw new UserError("nie udało się odczytać wymiarów obrazu");
  if (opts.minSide && Math.max(meta.width, meta.height) < opts.minSide) return { parts: [], width: meta.width, height: meta.height, format: meta.format ?? "" };

  // Zrzuty i grafiki (PNG/GIF) zostają bezstratne; zdjęcia jako JPG.
  const lossless = meta.format === "png" || meta.format === "gif";
  // Obraz po obróceniu wg EXIF, z białym tłem zamiast przezroczystości.
  const { data: oriented, info } = await sharp(input, { animated: false })
    .rotate()
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const raw = { raw: { width: info.width, height: info.height, channels: info.channels } } as const;
  let { width, height } = info;

  const encode = async (pipeline: Sharp): Promise<ImagePart> => {
    let data = lossless ? await pipeline.clone().png({ compressionLevel: 9 }).toBuffer() : await pipeline.clone().jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    let mediaType: ImagePart["mediaType"] = lossless ? "image/png" : "image/jpeg";
    if (data.length > MAX_PART_BYTES) {
      data = await pipeline.clone().jpeg({ quality: 82, mozjpeg: true }).toBuffer();
      mediaType = "image/jpeg";
    }
    const m = await sharp(data).metadata();
    return { data, mediaType, width: m.width!, height: m.height! };
  };

  // Długi pionowy obraz: najpierw szerokość ≤ 2000 px, potem kawałki po wysokości.
  const scaleW = Math.min(1, MAX_SIDE / width);
  const scaledH = Math.round(height * scaleW);
  if (scaledH > MAX_SIDE && height / width > 1.6) {
    let w = Math.round(width * scaleW);
    let h = scaledH;
    const step = MAX_SIDE - TILE_OVERLAP;
    let tiles = Math.ceil((h - TILE_OVERLAP) / step);
    if (tiles > MAX_TILES) {
      // Ekstremalnie długi obraz - zmniejszamy tak, żeby zmieścił się w limicie kawałków.
      const s = (MAX_TILES * step + TILE_OVERLAP) / h;
      w = Math.max(1, Math.round(w * s));
      h = Math.round(h * s);
      tiles = MAX_TILES;
    }
    const resized = await sharp(oriented, raw).resize(w, h).raw().toBuffer({ resolveWithObject: true });
    const parts: ImagePart[] = [];
    for (let i = 0; i < tiles; i++) {
      const top = Math.min(i * step, Math.max(0, h - MAX_SIDE));
      const tileH = Math.min(MAX_SIDE, h - top);
      const tile = sharp(resized.data, { raw: { width: resized.info.width, height: resized.info.height, channels: resized.info.channels } }).extract({
        left: 0,
        top,
        width: w,
        height: tileH,
      });
      parts.push(await encode(tile));
      if (top + tileH >= h) break;
    }
    return { parts, width, height, format: meta.format ?? "" };
  }

  // Zwykły obraz: zmieszczenie w 2000×2000.
  const s = Math.min(1, MAX_SIDE / Math.max(width, height));
  width = Math.max(1, Math.round(width * s));
  height = Math.max(1, Math.round(height * s));
  const pipeline = sharp(oriented, raw).resize(width, height);
  return { parts: [await encode(pipeline)], width: info.width, height: info.height, format: meta.format ?? "" };
}

/** Wymiary obrazu po normalizacji -> szacowany koszt w tokenach (⌈w/28⌉·⌈h/28⌉, maks. 4784). */
export function imageTokens(width: number, height: number): number {
  return Math.min(4784, Math.ceil(width / 28) * Math.ceil(height / 28)) + 20;
}
