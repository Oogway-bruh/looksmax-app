"use client";

// Detekcja twarzy w przeglądarce (MediaPipe) i pełny skan jednej klatki/zdjęcia.
import type { FaceLandmarker, FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { computeFaceGeometry, mergeMirrored, type Landmark, type Metrics, type Pose } from "./metrics";
import { assessQuality, blendshapeMap, computeImageStats, type ImageStats, type QualityReport } from "./quality";

// Model jest serwowany z public/ (pobiera go scripts/copy-mediapipe.mjs); gdyby go brakowało - z Google.
const MODEL_URLS = [
  "/mediapipe/face_landmarker.task",
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
];

const cache: Partial<Record<"IMAGE" | "VIDEO", Promise<FaceLandmarker>>> = {};

export function getLandmarker(mode: "IMAGE" | "VIDEO"): Promise<FaceLandmarker> {
  const existing = cache[mode];
  if (existing) return existing;
  const promise = (async () => {
    const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
    let lastError: unknown;
    for (const url of MODEL_URLS) {
      for (const delegate of ["GPU", "CPU"] as const) {
        try {
          return await FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: url, delegate },
            runningMode: mode,
            numFaces: 2,
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: true,
          });
        } catch (err) {
          lastError = err;
        }
      }
    }
    throw lastError ?? new Error("Nie udało się wczytać modelu twarzy.");
  })();
  cache[mode] = promise;
  promise.catch(() => delete cache[mode]);
  return promise;
}

export type FaceDetection = {
  landmarks: Landmark[];
  matrix: number[] | null;
  blendshapes?: Record<string, number>;
};

export function firstFace(result: FaceLandmarkerResult): { count: number; face: FaceDetection | null } {
  const count = result.faceLandmarks.length;
  if (count === 0) return { count, face: null };
  return {
    count,
    face: {
      landmarks: result.faceLandmarks[0],
      matrix: result.facialTransformationMatrixes?.[0]?.data ? Array.from(result.facialTransformationMatrixes[0].data) : null,
      blendshapes: blendshapeMap(result.faceBlendshapes?.[0]?.categories),
    },
  };
}

/** Statystyki jasności/ostrości z kadru twarzy (zmniejszonego do maks. 256 px; powiększanie fałszowałoby ostrość). */
export function faceImageStats(source: CanvasImageSource, width: number, height: number, landmarks: Landmark[]): ImageStats {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of landmarks) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const sx = Math.max(0, x0 * width);
  const sy = Math.max(0, y0 * height);
  const sw = Math.min(width, x1 * width) - sx;
  const sh = Math.min(height, y1 * height) - sy;
  const w = Math.max(16, Math.min(256, Math.round(sw)));
  const h = Math.max(8, Math.round((sh / Math.max(sw, 1)) * w));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return computeImageStats(gray, w, h);
}

export type FrameScan = {
  metrics: Metrics;
  pose: Pose;
  quality: QualityReport;
  image: ImageStats;
  landmarks: Landmark[];
  faceWidthPx: number;
};

export class ScanError extends Error {}

/**
 * Pełny skan jednego obrazu (zdjęcia lub klatki z kamery, narysowanego na canvasie):
 * detekcja, korekta 3D, uśrednienie z lustrzanym odbiciem i ocena jakości.
 */
export async function scanCanvas(canvas: HTMLCanvasElement): Promise<FrameScan> {
  const landmarker = await getLandmarker("IMAGE");
  const { count, face } = firstFace(landmarker.detect(canvas));
  if (!face) throw new ScanError("Nie wykryto twarzy. Użyj zdjęcia z przodu, z dobrym światłem i odsłoniętą twarzą.");
  if (count > 1) throw new ScanError("Na zdjęciu jest więcej niż jedna twarz - użyj zdjęcia tylko jednej osoby.");

  const { width, height } = canvas;
  const geo = computeFaceGeometry(face.landmarks, width, height, face.matrix);

  // Drugi przebieg na lustrzanym odbiciu zmniejsza błąd modelu punktów.
  const mirror = document.createElement("canvas");
  mirror.width = width;
  mirror.height = height;
  const mctx = mirror.getContext("2d")!;
  mctx.translate(width, 0);
  mctx.scale(-1, 1);
  mctx.drawImage(canvas, 0, 0);
  const mirrored = firstFace(landmarker.detect(mirror)).face;
  const metrics = mirrored
    ? mergeMirrored(geo.metrics, computeFaceGeometry(mirrored.landmarks, width, height, mirrored.matrix).metrics)
    : geo.metrics;

  const image = faceImageStats(canvas, width, height, face.landmarks);
  const quality = assessQuality({
    pose: geo.pose,
    blendshapes: face.blendshapes,
    faceWidthPx: geo.faceWidthPx,
    faceWidthFraction: geo.faceWidthFraction,
    image,
  });
  return { metrics, pose: geo.pose, quality, image, landmarks: face.landmarks, faceWidthPx: geo.faceWidthPx };
}

/** Wczytuje plik do canvasu (z uwzględnieniem orientacji EXIF), maks. `maxSide` px. */
export async function fileToCanvas(file: File, maxSide = 2048): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

/** Kadr wokół twarzy do podglądu, z punktami przeliczonymi na współrzędne kadru. */
export function facePreview(canvas: HTMLCanvasElement, landmarks: Landmark[], maxSide = 700): { image: string; landmarks: Landmark[] } {
  const box = faceBox(canvas, landmarks);
  const scale = Math.min(1, maxSide / Math.max(box.sw, box.sh));
  const out = document.createElement("canvas");
  out.width = Math.round(box.sw * scale);
  out.height = Math.round(box.sh * scale);
  out.getContext("2d")!.drawImage(canvas, box.sx, box.sy, box.sw, box.sh, 0, 0, out.width, out.height);
  return {
    image: out.toDataURL("image/jpeg", 0.85),
    landmarks: landmarks.map((p) => ({
      x: (p.x * canvas.width - box.sx) / box.sw,
      y: (p.y * canvas.height - box.sy) / box.sh,
      z: p.z,
    })),
  };
}

/** Prostokąt wokół twarzy z zapasem na włosy, uszy i szyję. */
function faceBox(canvas: HTMLCanvasElement, landmarks: Landmark[]) {
  const xs = landmarks.map((p) => p.x * canvas.width);
  const ys = landmarks.map((p) => p.y * canvas.height);
  const fw = Math.max(...xs) - Math.min(...xs);
  const fh = Math.max(...ys) - Math.min(...ys);
  const sx = Math.max(0, Math.min(...xs) - fw * 0.6);
  const sy = Math.max(0, Math.min(...ys) - fh * 0.6);
  return {
    sx,
    sy,
    sw: Math.min(canvas.width, Math.max(...xs) + fw * 0.6) - sx,
    sh: Math.min(canvas.height, Math.max(...ys) + fh * 0.5) - sy,
  };
}

/** JPEG do wysłania do analizy: kadr wokół twarzy (z zapasem), maks. 1280 px. */
export function encodeForAnalysis(canvas: HTMLCanvasElement, landmarks?: Landmark[], maxSide = 1280): string {
  // Kadr z zapasem na włosy, uszy i szyję - ważne dla oceny fryzury i linii żuchwy.
  const { sx, sy, sw, sh } = landmarks ? faceBox(canvas, landmarks) : { sx: 0, sy: 0, sw: canvas.width, sh: canvas.height };
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const out = document.createElement("canvas");
  out.width = Math.round(sw * scale);
  out.height = Math.round(sh * scale);
  out.getContext("2d")!.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.9);
}

export function thumbnail(dataUrl: string, size = 160): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = size / Math.max(img.width, img.height);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.75));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}
