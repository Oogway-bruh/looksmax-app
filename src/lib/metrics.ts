// Pomiary geometryczne twarzy liczone z punktów MediaPipe Face Landmarker (478 punktów).
// Ten plik jest wspólny dla przeglądarki i serwera - nie importuj tu nic serwerowego.

export type Point = { x: number; y: number };

export const METRIC_KEYS = [
  "canthal_tilt",
  "canthal_tilt_left",
  "canthal_tilt_right",
  "fwhr",
  "face_length_width_ratio",
  "midface_ratio",
  "eye_spacing_ratio",
  "intercanthal_eye_width_ratio",
  "eye_aspect_ratio",
  "nose_width_ratio",
  "mouth_nose_width_ratio",
  "lip_ratio",
  "lower_middle_third_ratio",
  "chin_philtrum_ratio",
  "jaw_width_ratio",
  "asymmetry_index",
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];
export type Metrics = Partial<Record<MetricKey, number>>;

export const METRIC_INFO: Record<MetricKey, { label: string; unit: string; description: string }> = {
  canthal_tilt: {
    label: "Nachylenie oczu (średnie)",
    unit: "°",
    description: "Kąt linii od wewnętrznego do zewnętrznego kącika oka. Dodatni = zewnętrzny kącik wyżej.",
  },
  canthal_tilt_left: { label: "Nachylenie lewego oka", unit: "°", description: "Canthal tilt lewego oka (lewa strona osoby)." },
  canthal_tilt_right: { label: "Nachylenie prawego oka", unit: "°", description: "Canthal tilt prawego oka (prawa strona osoby)." },
  fwhr: {
    label: "FWHR",
    unit: "",
    description: "Szerokość twarzy (kości jarzmowe) / wysokość górnej części twarzy (linia brwi do górnej wargi).",
  },
  face_length_width_ratio: {
    label: "Długość / szerokość twarzy",
    unit: "",
    description: "Wysokość od górnej części czoła do brody / szerokość na kościach jarzmowych.",
  },
  midface_ratio: {
    label: "Midface ratio",
    unit: "",
    description: "Rozstaw źrenic / odległość od linii źrenic do górnej wargi. Wartość ~1 = kompaktowy środek twarzy.",
  },
  eye_spacing_ratio: {
    label: "ESR (rozstaw oczu)",
    unit: "",
    description: "Rozstaw źrenic / szerokość twarzy na kościach jarzmowych.",
  },
  intercanthal_eye_width_ratio: {
    label: "Odstęp między oczami / szerokość oka",
    unit: "",
    description: "Odległość między wewnętrznymi kącikami / średnia szerokość oka.",
  },
  eye_aspect_ratio: {
    label: "Wysokość / szerokość oka",
    unit: "",
    description: "Średnia wysokość szpary powiekowej / szerokość oka. Niższa wartość = węższe, 'hunter eyes'.",
  },
  nose_width_ratio: {
    label: "Szerokość nosa / odstęp oczu",
    unit: "",
    description: "Szerokość skrzydełek nosa / odległość między wewnętrznymi kącikami oczu.",
  },
  mouth_nose_width_ratio: {
    label: "Szerokość ust / szerokość nosa",
    unit: "",
    description: "Szerokość ust (kąciki) / szerokość skrzydełek nosa.",
  },
  lip_ratio: {
    label: "Dolna / górna warga",
    unit: "",
    description: "Wysokość czerwieni dolnej wargi / wysokość czerwieni górnej wargi.",
  },
  lower_middle_third_ratio: {
    label: "Dolna / środkowa tercja",
    unit: "",
    description: "(podnosie -> broda) / (glabella -> podnosie).",
  },
  chin_philtrum_ratio: {
    label: "Broda / rynienka",
    unit: "",
    description: "(dolna warga -> broda) / (podnosie -> górna warga).",
  },
  jaw_width_ratio: {
    label: "Szerokość żuchwy / twarzy",
    unit: "",
    description: "Szerokość na kątach żuchwy / szerokość na kościach jarzmowych.",
  },
  asymmetry_index: {
    label: "Indeks asymetrii",
    unit: "%",
    description: "Średnie odchylenie par punktów od lustrzanego odbicia względem osi twarzy, w % szerokości twarzy. Niższy = bardziej symetrycznie.",
  },
};

// Indeksy punktów MediaPipe Face Mesh. "R" = prawa strona osoby (lewa strona zdjęcia).
const L = {
  forehead: 10,
  glabella: 9,
  nasion: 168,
  subnasale: 2,
  upperLipTop: 0,
  upperLipBottom: 13,
  lowerLipTop: 14,
  lowerLipBottom: 17,
  menton: 152,
  noseTip: 1,
  zygR: 234,
  zygL: 454,
  gonR: 172,
  gonL: 397,
  alarR: 129,
  alarL: 358,
  mouthR: 61,
  mouthL: 291,
  eyeOuterR: 33,
  eyeInnerR: 133,
  eyeOuterL: 263,
  eyeInnerL: 362,
  eyeTopR: 159,
  eyeBottomR: 145,
  eyeTopL: 386,
  eyeBottomL: 374,
  irisR: 468,
  irisL: 473,
};

// Pary punktów lustrzanych (prawa strona osoby, lewa strona osoby) do liczenia symetrii.
const MIRROR_PAIRS: [number, number][] = [
  [33, 263],
  [133, 362],
  [159, 386],
  [145, 374],
  [70, 300],
  [105, 334],
  [61, 291],
  [234, 454],
  [172, 397],
  [129, 358],
  [50, 280],
  [136, 365],
];

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const round = (v: number, digits = 3) => Math.round(v * 10 ** digits) / 10 ** digits;

export type FaceGeometry = {
  metrics: Metrics;
  // Jakość zdjęcia - wykryte problemy z ułożeniem głowy
  pose: { yaw: number; roll: number };
  warnings: string[];
};

/**
 * Liczy pomiary z punktów. `landmarks` w formacie MediaPipe (x, y znormalizowane 0-1),
 * `width`/`height` - rozmiar obrazu w pikselach (żeby przeliczyć na układ izotropowy).
 */
export function computeFaceGeometry(
  landmarks: { x: number; y: number }[],
  width: number,
  height: number,
): FaceGeometry {
  const raw = landmarks.map((p) => ({ x: p.x * width, y: p.y * height }));

  // Obrót (roll) wyznaczony z linii między wewnętrznymi kącikami oczu - wyrównujemy twarz do poziomu.
  const roll = Math.atan2(raw[L.eyeInnerL].y - raw[L.eyeInnerR].y, raw[L.eyeInnerL].x - raw[L.eyeInnerR].x);
  const cos = Math.cos(-roll);
  const sin = Math.sin(-roll);
  const p = raw.map((pt) => ({ x: pt.x * cos - pt.y * sin, y: pt.x * sin + pt.y * cos }));

  const faceWidth = dist(p[L.zygR], p[L.zygL]);
  const warnings: string[] = [];

  // Yaw (obrót w bok) - porównanie odległości czubka nosa od obu policzków.
  const dR = Math.abs(p[L.noseTip].x - p[L.zygR].x);
  const dL = Math.abs(p[L.zygL].x - p[L.noseTip].x);
  const yaw = (dL - dR) / (dL + dR);
  if (Math.abs(yaw) > 0.12) warnings.push("Głowa jest obrócona w bok - pomiary symetrii i proporcji mogą być zafałszowane.");
  const rollDeg = (roll * 180) / Math.PI;
  if (Math.abs(rollDeg) > 10) warnings.push("Głowa jest mocno przechylona - zrób zdjęcie z prosto ustawioną głową.");

  // Canthal tilt: dodatni, gdy zewnętrzny kącik jest wyżej (mniejsze y) niż wewnętrzny.
  const tilt = (inner: Point, outer: Point) =>
    (Math.atan2(inner.y - outer.y, Math.abs(outer.x - inner.x)) * 180) / Math.PI;
  const tiltR = tilt(p[L.eyeInnerR], p[L.eyeOuterR]);
  const tiltL = tilt(p[L.eyeInnerL], p[L.eyeOuterL]);

  const eyeWidthR = dist(p[L.eyeOuterR], p[L.eyeInnerR]);
  const eyeWidthL = dist(p[L.eyeOuterL], p[L.eyeInnerL]);
  const eyeWidth = (eyeWidthR + eyeWidthL) / 2;
  const eyeHeight = (dist(p[L.eyeTopR], p[L.eyeBottomR]) + dist(p[L.eyeTopL], p[L.eyeBottomL])) / 2;
  const intercanthal = dist(p[L.eyeInnerR], p[L.eyeInnerL]);
  const ipd = dist(p[L.irisR], p[L.irisL]);
  const pupilLineY = (p[L.irisR].y + p[L.irisL].y) / 2;
  const noseWidth = dist(p[L.alarR], p[L.alarL]);

  // Symetria: odbijamy punkty prawej strony względem osi twarzy (pionowa linia przez środek).
  const axisX = (p[L.glabella].x + p[L.subnasale].x + p[L.menton].x + p[L.nasion].x) / 4;
  const deviations = MIRROR_PAIRS.map(([r, l]) => {
    const mirrored = { x: 2 * axisX - p[r].x, y: p[r].y };
    return dist(mirrored, p[l]) / faceWidth;
  });
  const asymmetry = (deviations.reduce((a, b) => a + b, 0) / deviations.length) * 100;

  const metrics: Metrics = {
    canthal_tilt: round((tiltR + tiltL) / 2, 1),
    canthal_tilt_right: round(tiltR, 1),
    canthal_tilt_left: round(tiltL, 1),
    fwhr: round(faceWidth / Math.abs(p[L.upperLipTop].y - p[L.glabella].y)),
    face_length_width_ratio: round(dist(p[L.forehead], p[L.menton]) / faceWidth),
    midface_ratio: round(ipd / Math.abs(p[L.upperLipTop].y - pupilLineY)),
    eye_spacing_ratio: round(ipd / faceWidth),
    intercanthal_eye_width_ratio: round(intercanthal / eyeWidth),
    eye_aspect_ratio: round(eyeHeight / eyeWidth),
    nose_width_ratio: round(noseWidth / intercanthal),
    mouth_nose_width_ratio: round(dist(p[L.mouthR], p[L.mouthL]) / noseWidth),
    lip_ratio: round(dist(p[L.lowerLipTop], p[L.lowerLipBottom]) / Math.max(dist(p[L.upperLipTop], p[L.upperLipBottom]), 1e-6)),
    lower_middle_third_ratio: round(dist(p[L.subnasale], p[L.menton]) / dist(p[L.glabella], p[L.subnasale])),
    chin_philtrum_ratio: round(dist(p[L.lowerLipBottom], p[L.menton]) / dist(p[L.subnasale], p[L.upperLipTop])),
    jaw_width_ratio: round(dist(p[L.gonR], p[L.gonL]) / faceWidth),
    asymmetry_index: round(asymmetry, 2),
  };

  return { metrics, pose: { yaw: round(yaw), roll: round(rollDeg, 1) }, warnings };
}

// Punkty rysowane na podglądzie zdjęcia
export const OVERLAY_POINTS = Object.values(L);
