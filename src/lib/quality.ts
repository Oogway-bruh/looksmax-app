// Ocena jakości zdjęcia do pomiarów: poza głowy, mimika, światło, ostrość, rozdzielczość.
// Czyste funkcje (bez DOM) - liczone w przeglądarce, testowane jednostkowo.

import type { Pose } from "./metrics";

export type CheckStatus = "ok" | "warn" | "bad";
export type QualityCheck = { id: string; label: string; status: CheckStatus; message: string };
export type QualityReport = { status: CheckStatus; checks: QualityCheck[] };

export type ImageStats = {
  /** Średnia jasność twarzy 0-255 */
  brightness: number;
  /** Odsetek prześwietlonych pikseli (0-1) */
  clipped: number;
  /** Różnica jasności lewej i prawej połowy twarzy (0-1) */
  sideImbalance: number;
  /** Ostrość: wariancja laplasjanu w kadrze twarzy (zmniejszonym do maks. 256 px szerokości, nigdy powiększanym) */
  sharpness: number;
};

/** Statystyki obrazu z kadru twarzy w skali szarości (wiersz po wierszu). */
export function computeImageStats(gray: ArrayLike<number>, width: number, height: number): ImageStats {
  let sum = 0;
  let clipped = 0;
  let left = 0;
  let right = 0;
  const half = Math.floor(width / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = gray[y * width + x];
      sum += v;
      if (v >= 250) clipped++;
      if (x < half) left += v;
      else right += v;
    }
  }
  const n = width * height;
  const leftMean = left / (half * height);
  const rightMean = right / ((width - half) * height);

  // Laplasjan 3x3 - im większa wariancja, tym ostrzejsze krawędzie.
  let lapSum = 0;
  let lapSq = 0;
  let lapN = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      lapSum += lap;
      lapSq += lap * lap;
      lapN++;
    }
  }
  const lapMean = lapSum / Math.max(lapN, 1);

  return {
    brightness: sum / n,
    clipped: clipped / n,
    sideImbalance: Math.abs(leftMean - rightMean) / Math.max(leftMean, rightMean, 1),
    sharpness: lapSq / Math.max(lapN, 1) - lapMean * lapMean,
  };
}

export type QualityInput = {
  pose: Pose;
  /** Wyniki blendshapes MediaPipe: nazwa -> 0..1 */
  blendshapes?: Record<string, number>;
  faceWidthPx: number;
  faceWidthFraction: number;
  image?: ImageStats;
};

// Progi dobrane na zdjęciach testowych; "warn" = pomiar możliwy, ale mniej dokładny.
export const THRESHOLDS = {
  yaw: { warn: 7, bad: 15 },
  pitch: { warn: 10, bad: 18 },
  roll: { warn: 12, bad: 25 },
  smile: { warn: 0.25, bad: 0.4 },
  jawOpen: { warn: 0.12, bad: 0.25 },
  blink: { warn: 0.35, bad: 0.55 },
  squint: { warn: 0.55 },
  browRaise: { warn: 0.45 },
  gaze: { warn: 0.55 },
  // Model punktów pracuje na kadrze ~256 px, więc większa rozdzielczość niewiele już daje.
  faceWidthPx: { warn: 180, bad: 110 },
  faceWidthFraction: { warn: 0.7 },
  brightness: { dark: 70, bright: 205 },
  clipped: { warn: 0.08 },
  sideImbalance: { warn: 0.22, bad: 0.4 },
  // Skalibrowane: ostre zdjęcia 48-260, rozmycie 1 px ~13, 2 px ~3.
  sharpness: { warn: 25, bad: 8 },
};

const avg = (b: Record<string, number>, ...names: string[]) => names.reduce((s, n) => s + (b[n] ?? 0), 0) / names.length;
const max = (b: Record<string, number>, ...names: string[]) => Math.max(...names.map((n) => b[n] ?? 0));

export function assessQuality(input: QualityInput): QualityReport {
  const checks: QualityCheck[] = [];
  const add = (id: string, label: string, status: CheckStatus, message: string) => checks.push({ id, label, status, message });
  const T = THRESHOLDS;

  // Poza głowy
  const { yaw, pitch, roll } = input.pose;
  const level = (v: number, t: { warn: number; bad: number }): CheckStatus => (Math.abs(v) >= t.bad ? "bad" : Math.abs(v) >= t.warn ? "warn" : "ok");
  const yawS = level(yaw, T.yaw);
  add("yaw", "Twarz na wprost", yawS, yawS === "ok" ? "Głowa ustawiona prosto" : `Głowa obrócona w bok o ${Math.abs(yaw).toFixed(0)}° - patrz prosto w obiektyw`);
  const pitchS = level(pitch, T.pitch);
  add(
    "pitch",
    "Głowa w poziomie",
    pitchS,
    pitchS === "ok" ? "Brak pochylenia" : `Głowa ${pitch > 0 ? "pochylona" : "uniesiona"} o ${Math.abs(pitch).toFixed(0)}° - aparat na wysokości oczu`,
  );
  const rollS = level(roll, T.roll);
  add("roll", "Brak przechylenia", rollS, rollS === "ok" ? "OK" : `Głowa przechylona o ${Math.abs(roll).toFixed(0)}°`);

  // Mimika (neutralna twarz jest warunkiem wiarygodnych proporcji)
  const b = input.blendshapes;
  if (b) {
    const smile = avg(b, "mouthSmileLeft", "mouthSmileRight");
    const jaw = b.jawOpen ?? 0;
    const blink = avg(b, "eyeBlinkLeft", "eyeBlinkRight");
    const squint = avg(b, "eyeSquintLeft", "eyeSquintRight");
    const browUp = Math.max(b.browInnerUp ?? 0, avg(b, "browOuterUpLeft", "browOuterUpRight"));
    const gaze = max(b, "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight", "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight");

    const issues: { s: CheckStatus; m: string }[] = [];
    if (smile >= T.smile.bad) issues.push({ s: "bad", m: "uśmiech zmienia kształt oczu, ust i policzków" });
    else if (smile >= T.smile.warn) issues.push({ s: "warn", m: "lekki uśmiech" });
    if (jaw >= T.jawOpen.bad) issues.push({ s: "bad", m: "otwarte usta" });
    else if (jaw >= T.jawOpen.warn) issues.push({ s: "warn", m: "lekko rozchylone usta" });
    if (blink >= T.blink.bad) issues.push({ s: "bad", m: "zamknięte oczy" });
    else if (blink >= T.blink.warn) issues.push({ s: "warn", m: "przymknięte oczy" });
    if (squint >= T.squint.warn && smile < T.smile.bad) issues.push({ s: "warn", m: "zmrużone oczy" });
    if (browUp >= T.browRaise.warn) issues.push({ s: "warn", m: "uniesione brwi" });
    const worst: CheckStatus = issues.some((i) => i.s === "bad") ? "bad" : issues.length ? "warn" : "ok";
    add(
      "expression",
      "Neutralna mina",
      worst,
      worst === "ok" ? "Mina neutralna" : `Rozluźnij twarz: ${issues.map((i) => i.m).join(", ")}`,
    );
    add(
      "gaze",
      "Wzrok w obiektyw",
      gaze >= T.gaze.warn ? "warn" : "ok",
      gaze >= T.gaze.warn ? "Patrz prosto w obiektyw - kierunek wzroku zmienia pozycję źrenic" : "OK",
    );
  }

  // Rozdzielczość i odległość
  const px = input.faceWidthPx;
  add(
    "resolution",
    "Rozdzielczość twarzy",
    px < T.faceWidthPx.bad ? "bad" : px < T.faceWidthPx.warn ? "warn" : "ok",
    px < T.faceWidthPx.warn ? `Twarz ma tylko ${px} px szerokości - podejdź bliżej lub użyj lepszego aparatu` : `${px} px`,
  );
  if (input.faceWidthFraction > T.faceWidthFraction.warn) {
    add("distance", "Odległość", "warn", "Twarz bardzo blisko obiektywu - z bliska obiektyw powiększa nos i zwęża twarz. Odsuń aparat (min. ~1 m, użyj zoomu)");
  }

  // Światło i ostrość
  const img = input.image;
  if (img) {
    const lightIssues: string[] = [];
    let lightS: CheckStatus = "ok";
    if (img.brightness < T.brightness.dark) {
      lightIssues.push("za ciemno");
      lightS = "warn";
    } else if (img.brightness > T.brightness.bright || img.clipped > T.clipped.warn) {
      lightIssues.push("prześwietlone");
      lightS = "warn";
    }
    if (img.sideImbalance >= T.sideImbalance.bad) {
      lightIssues.push("jedna strona twarzy dużo ciemniejsza");
      lightS = "bad";
    } else if (img.sideImbalance >= T.sideImbalance.warn) {
      lightIssues.push("nierówne światło z boku");
      if (lightS === "ok") lightS = "warn";
    }
    add("light", "Oświetlenie", lightS, lightS === "ok" ? "Równe światło" : `${lightIssues.join(", ")} - stań przodem do okna lub lampy`);
    const sharpS: CheckStatus = img.sharpness < T.sharpness.bad ? "bad" : img.sharpness < T.sharpness.warn ? "warn" : "ok";
    add("sharpness", "Ostrość", sharpS, sharpS === "ok" ? "Ostre" : "Zdjęcie rozmazane - trzymaj aparat nieruchomo, więcej światła");
  }

  const status: CheckStatus = checks.some((c) => c.status === "bad") ? "bad" : checks.some((c) => c.status === "warn") ? "warn" : "ok";
  return { status, checks };
}

/** Lista blendshapes MediaPipe -> słownik nazwa -> wynik */
export function blendshapeMap(categories?: { categoryName: string; score: number }[]): Record<string, number> | undefined {
  if (!categories) return undefined;
  return Object.fromEntries(categories.map((c) => [c.categoryName, c.score]));
}
