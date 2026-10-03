// Pomiary geometryczne twarzy liczone z punktów MediaPipe Face Landmarker (478 punktów).
// Wspólny dla przeglądarki i serwera - bez zależności serwerowych ani DOM.

export type Landmark = { x: number; y: number; z: number };
type Vec = [number, number, number];

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
  "brow_eye_distance_ratio",
  "brow_tilt",
  "nose_width_ratio",
  "nose_length_ratio",
  "mouth_nose_width_ratio",
  "mouth_ipd_ratio",
  "lip_ratio",
  "lower_middle_third_ratio",
  "chin_philtrum_ratio",
  "jaw_width_ratio",
  "chin_angle",
  "asymmetry_index",
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];
export type Metrics = Partial<Record<MetricKey, number>>;

export const METRIC_INFO: Record<MetricKey, { label: string; unit: string; description: string; digits: number }> = {
  canthal_tilt: {
    label: "Nachylenie oczu (średnie)",
    unit: "°",
    digits: 1,
    description: "Kąt linii od wewnętrznego do zewnętrznego kącika oka. Dodatni = zewnętrzny kącik wyżej.",
  },
  canthal_tilt_left: { label: "Nachylenie lewego oka", unit: "°", digits: 1, description: "Canthal tilt lewego oka (lewa strona osoby)." },
  canthal_tilt_right: { label: "Nachylenie prawego oka", unit: "°", digits: 1, description: "Canthal tilt prawego oka (prawa strona osoby)." },
  fwhr: {
    label: "FWHR",
    unit: "",
    digits: 2,
    description: "Szerokość twarzy (kości jarzmowe) / wysokość górnej części twarzy (linia brwi do górnej wargi).",
  },
  face_length_width_ratio: {
    label: "Długość / szerokość twarzy",
    unit: "",
    digits: 2,
    description: "Wysokość od górnej części czoła (nie linii włosów) do brody / szerokość na kościach jarzmowych.",
  },
  midface_ratio: {
    label: "Midface ratio",
    unit: "",
    digits: 2,
    description: "Rozstaw źrenic / odległość od linii źrenic do górnej wargi. Wartość ~1 = kompaktowy środek twarzy.",
  },
  eye_spacing_ratio: { label: "ESR (rozstaw oczu)", unit: "", digits: 3, description: "Rozstaw źrenic / szerokość twarzy na kościach jarzmowych." },
  intercanthal_eye_width_ratio: {
    label: "Odstęp między oczami / szerokość oka",
    unit: "",
    digits: 2,
    description: "Odległość między wewnętrznymi kącikami / średnia szerokość oka.",
  },
  eye_aspect_ratio: {
    label: "Wysokość / szerokość oka",
    unit: "",
    digits: 3,
    description: "Średnia wysokość szpary powiekowej / szerokość oka. Niższa wartość = węższe oczy ('hunter eyes').",
  },
  brow_eye_distance_ratio: {
    label: "Odległość brwi od oka",
    unit: "",
    digits: 2,
    description: "Odległość od dolnej krawędzi brwi do górnej powieki (nad źrenicą) / szerokość oka. Niższa = nisko osadzone brwi.",
  },
  brow_tilt: {
    label: "Nachylenie brwi",
    unit: "°",
    digits: 1,
    description: "Kąt brwi od początku (przy nosie) do końca. Dodatni = koniec brwi wyżej niż początek.",
  },
  nose_width_ratio: { label: "Szerokość nosa / odstęp oczu", unit: "", digits: 2, description: "Szerokość skrzydełek nosa / odległość między wewnętrznymi kącikami oczu." },
  nose_length_ratio: {
    label: "Długość nosa / wysokość twarzy",
    unit: "",
    digits: 3,
    description: "Odległość nasada nosa -> podnosie / odległość nasada nosa -> broda.",
  },
  mouth_nose_width_ratio: { label: "Szerokość ust / szerokość nosa", unit: "", digits: 2, description: "Szerokość ust (kąciki) / szerokość skrzydełek nosa." },
  mouth_ipd_ratio: { label: "Szerokość ust / rozstaw źrenic", unit: "", digits: 2, description: "Szerokość ust (kąciki) / rozstaw źrenic." },
  lip_ratio: { label: "Dolna / górna warga", unit: "", digits: 2, description: "Wysokość czerwieni dolnej wargi / wysokość czerwieni górnej wargi." },
  lower_middle_third_ratio: { label: "Dolna / środkowa tercja", unit: "", digits: 2, description: "(podnosie -> broda) / (glabella -> podnosie)." },
  chin_philtrum_ratio: { label: "Broda / rynienka", unit: "", digits: 2, description: "(dolna warga -> broda) / (podnosie -> górna warga)." },
  jaw_width_ratio: { label: "Szerokość żuchwy / twarzy", unit: "", digits: 3, description: "Szerokość na kątach żuchwy / szerokość na kościach jarzmowych." },
  chin_angle: {
    label: "Kąt brody (widok z przodu)",
    unit: "°",
    digits: 0,
    description: "Kąt przy brodzie między liniami do obu kątów żuchwy. Mniejszy = bardziej spiczasta (V), większy = szersza, kwadratowa dolna część twarzy.",
  },
  asymmetry_index: {
    label: "Indeks asymetrii",
    unit: "%",
    digits: 2,
    description: "Średnie odchylenie par punktów od lustrzanego odbicia względem osi twarzy, w % szerokości twarzy. Niższy = bardziej symetrycznie.",
  },
};

// Indeksy punktów MediaPipe Face Mesh (zweryfikowane wizualnie). "R" = prawa strona osoby (lewa strona zdjęcia).
export const LM = {
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
  browLowR: 52,
  browLowL: 282,
  browInnerR: 55,
  browInnerL: 285,
  browOuterR: 46,
  browOuterL: 276,
} as const;

// Pary punktów lustrzanych (prawa strona osoby, lewa strona osoby) do liczenia symetrii.
const MIRROR_PAIRS: [number, number][] = [
  [33, 263],
  [133, 362],
  [159, 386],
  [145, 374],
  [70, 300],
  [105, 334],
  [52, 282],
  [61, 291],
  [234, 454],
  [172, 397],
  [129, 358],
  [50, 280],
  [136, 365],
  [58, 288],
];

// Linie rysowane na podglądzie (pary punktów).
export const OVERLAY_LINES: [number, number][] = [
  [LM.eyeInnerR, LM.eyeOuterR],
  [LM.eyeInnerL, LM.eyeOuterL],
  [LM.zygR, LM.zygL],
  [LM.gonR, LM.gonL],
  [LM.gonR, LM.menton],
  [LM.gonL, LM.menton],
  [LM.alarR, LM.alarL],
  [LM.mouthR, LM.mouthL],
  [LM.glabella, LM.menton],
  [LM.irisR, LM.irisL],
];
export const OVERLAY_POINTS = Object.values(LM);

export type Pose = { yaw: number; pitch: number; roll: number };

/** Kąty głowy (w stopniach) z macierzy transformacji MediaPipe (4x4, kolumnami). */
export function poseFromMatrix(m: ArrayLike<number>): Pose {
  const deg = 180 / Math.PI;
  return {
    yaw: Math.atan2(m[8], m[10]) * deg,
    pitch: Math.asin(Math.max(-1, Math.min(1, -m[9]))) * deg,
    roll: Math.atan2(m[1], m[5]) * deg,
  };
}

/**
 * Sprowadza punkty do widoku "na wprost": odwraca obrót głowy z macierzy MediaPipe.
 * Macierz jest w układzie modelu (y w górę, z do kamery), a punkty w układzie obrazu (y w dół),
 * stąd sprzężenie F·R·F. Zweryfikowane na zdjęciach z obrotem ~20° (oś twarzy wraca do pionu).
 */
function frontalize(points: Vec[], m: ArrayLike<number>): Vec[] {
  // R[wiersz][kolumna] = m[kolumna*4 + wiersz]; F·R·F zmienia znak elementów mieszających y/z z x.
  const r = [
    [m[0], -m[4], -m[8]],
    [-m[1], m[5], m[9]],
    [-m[2], m[6], m[10]],
  ];
  const c = points.reduce<Vec>((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map((v) => v / points.length);
  // Odwrotność rotacji = transpozycja.
  return points.map((p) => {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    return [
      r[0][0] * d[0] + r[1][0] * d[1] + r[2][0] * d[2],
      r[0][1] * d[0] + r[1][1] * d[1] + r[2][1] * d[2],
      r[0][2] * d[0] + r[1][2] * d[1] + r[2][2] * d[2],
    ];
  });
}

const dist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const roundTo = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
const angleAt = (vertex: Vec, a: Vec, b: Vec) => {
  const v1 = [a[0] - vertex[0], a[1] - vertex[1]];
  const v2 = [b[0] - vertex[0], b[1] - vertex[1]];
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]));
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
};

export type FaceGeometry = {
  metrics: Metrics;
  pose: Pose;
  /** Szerokość twarzy na kościach jarzmowych jako ułamek szerokości zdjęcia */
  faceWidthFraction: number;
  /** Szerokość twarzy w pikselach (rozdzielczość pomiaru) */
  faceWidthPx: number;
};

/**
 * Liczy pomiary z punktów MediaPipe (x, y, z znormalizowane do rozmiaru obrazu).
 * Jeśli jest macierz transformacji, punkty są najpierw sprowadzane do widoku na wprost.
 */
export function computeFaceGeometry(
  landmarks: Landmark[],
  width: number,
  height: number,
  matrix?: ArrayLike<number> | null,
): FaceGeometry {
  const raw: Vec[] = landmarks.map((p) => [p.x * width, p.y * height, p.z * width]);
  const rawFaceWidth = dist(raw[LM.zygR], raw[LM.zygL]);

  let p: Vec[];
  let pose: Pose;
  if (matrix && matrix.length >= 16) {
    p = frontalize(raw, matrix);
    pose = poseFromMatrix(matrix);
  } else {
    // Bez macierzy: korygujemy tylko przechylenie (roll) na podstawie linii wewnętrznych kącików oczu.
    const roll = Math.atan2(raw[LM.eyeInnerL][1] - raw[LM.eyeInnerR][1], raw[LM.eyeInnerL][0] - raw[LM.eyeInnerR][0]);
    const cos = Math.cos(-roll);
    const sin = Math.sin(-roll);
    p = raw.map(([x, y, z]) => [x * cos - y * sin, x * sin + y * cos, z]);
    pose = { yaw: 0, pitch: 0, roll: (roll * 180) / Math.PI };
  }

  const faceWidth = dist(p[LM.zygR], p[LM.zygL]);

  // Canthal tilt: dodatni, gdy zewnętrzny kącik jest wyżej (mniejsze y) niż wewnętrzny.
  const tilt = (inner: Vec, outer: Vec) => (Math.atan2(inner[1] - outer[1], Math.abs(outer[0] - inner[0])) * 180) / Math.PI;
  const tiltR = tilt(p[LM.eyeInnerR], p[LM.eyeOuterR]);
  const tiltL = tilt(p[LM.eyeInnerL], p[LM.eyeOuterL]);
  const browTiltR = tilt(p[LM.browInnerR], p[LM.browOuterR]);
  const browTiltL = tilt(p[LM.browInnerL], p[LM.browOuterL]);

  const eyeWidth = (dist(p[LM.eyeOuterR], p[LM.eyeInnerR]) + dist(p[LM.eyeOuterL], p[LM.eyeInnerL])) / 2;
  const eyeHeight = (dist(p[LM.eyeTopR], p[LM.eyeBottomR]) + dist(p[LM.eyeTopL], p[LM.eyeBottomL])) / 2;
  const intercanthal = dist(p[LM.eyeInnerR], p[LM.eyeInnerL]);
  const ipd = dist(p[LM.irisR], p[LM.irisL]);
  const pupilLineY = (p[LM.irisR][1] + p[LM.irisL][1]) / 2;
  const noseWidth = dist(p[LM.alarR], p[LM.alarL]);
  const mouthWidth = dist(p[LM.mouthR], p[LM.mouthL]);
  const browEye = (Math.abs(p[LM.eyeTopR][1] - p[LM.browLowR][1]) + Math.abs(p[LM.eyeTopL][1] - p[LM.browLowL][1])) / 2;

  // Symetria: odbijamy punkty prawej strony względem pionowej osi twarzy.
  const axisPoints: number[] = [LM.glabella, LM.nasion, LM.subnasale, LM.upperLipTop, LM.menton];
  const axisX = axisPoints.reduce((s, i) => s + p[i][0], 0) / axisPoints.length;
  const deviations = MIRROR_PAIRS.map(([r, l]) => Math.hypot(2 * axisX - p[r][0] - p[l][0], p[r][1] - p[l][1]) / faceWidth);
  const asymmetry = (deviations.reduce((a, b) => a + b, 0) / deviations.length) * 100;

  const values: Record<MetricKey, number> = {
    canthal_tilt: (tiltR + tiltL) / 2,
    canthal_tilt_right: tiltR,
    canthal_tilt_left: tiltL,
    fwhr: faceWidth / Math.abs(p[LM.upperLipTop][1] - p[LM.glabella][1]),
    face_length_width_ratio: dist(p[LM.forehead], p[LM.menton]) / faceWidth,
    midface_ratio: ipd / Math.abs(p[LM.upperLipTop][1] - pupilLineY),
    eye_spacing_ratio: ipd / faceWidth,
    intercanthal_eye_width_ratio: intercanthal / eyeWidth,
    eye_aspect_ratio: eyeHeight / eyeWidth,
    brow_eye_distance_ratio: browEye / eyeWidth,
    brow_tilt: (browTiltR + browTiltL) / 2,
    nose_width_ratio: noseWidth / intercanthal,
    nose_length_ratio: dist(p[LM.nasion], p[LM.subnasale]) / dist(p[LM.nasion], p[LM.menton]),
    mouth_nose_width_ratio: mouthWidth / noseWidth,
    mouth_ipd_ratio: mouthWidth / ipd,
    lip_ratio: dist(p[LM.lowerLipTop], p[LM.lowerLipBottom]) / Math.max(dist(p[LM.upperLipTop], p[LM.upperLipBottom]), 1e-6),
    lower_middle_third_ratio: dist(p[LM.subnasale], p[LM.menton]) / dist(p[LM.glabella], p[LM.subnasale]),
    chin_philtrum_ratio: dist(p[LM.lowerLipBottom], p[LM.menton]) / dist(p[LM.subnasale], p[LM.upperLipTop]),
    jaw_width_ratio: dist(p[LM.gonR], p[LM.gonL]) / faceWidth,
    chin_angle: angleAt(p[LM.menton], p[LM.gonR], p[LM.gonL]),
    asymmetry_index: asymmetry,
  };

  const metrics: Metrics = {};
  for (const k of METRIC_KEYS) {
    if (Number.isFinite(values[k])) metrics[k] = roundTo(values[k], METRIC_INFO[k].digits);
  }

  return {
    metrics,
    pose: { yaw: roundTo(pose.yaw, 1), pitch: roundTo(pose.pitch, 1), roll: roundTo(pose.roll, 1) },
    faceWidthFraction: roundTo(rawFaceWidth / width, 3),
    faceWidthPx: Math.round(rawFaceWidth),
  };
}

export type MetricStat = { value: number; spread: number; samples: number };

/**
 * Łączy pomiary z wielu zdjęć/klatek: mediana (odporna na pojedyncze błędne klatki)
 * oraz rozrzut (MAD), który pokazuje, na ile pomiar jest stabilny.
 */
export function combineMetrics(list: Metrics[]): { metrics: Metrics; stats: Partial<Record<MetricKey, MetricStat>> } {
  const metrics: Metrics = {};
  const stats: Partial<Record<MetricKey, MetricStat>> = {};
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  for (const k of METRIC_KEYS) {
    const xs = list.map((m) => m[k]).filter((v): v is number => v != null && Number.isFinite(v));
    if (xs.length === 0) continue;
    const med = median(xs);
    const digits = METRIC_INFO[k].digits;
    metrics[k] = roundTo(med, digits);
    stats[k] = { value: roundTo(med, digits), spread: roundTo(median(xs.map((x) => Math.abs(x - med))), digits + 1), samples: xs.length };
  }
  return { metrics, stats };
}

export function formatMetric(k: MetricKey, v: number) {
  return `${v.toFixed(METRIC_INFO[k].digits)}${METRIC_INFO[k].unit}`;
}

// Pomiary, które w lustrzanym odbiciu zamieniają się stronami.
const MIRROR_SWAP: [MetricKey, MetricKey][] = [["canthal_tilt_left", "canthal_tilt_right"]];

/**
 * Łączy pomiar zdjęcia z pomiarem jego lustrzanego odbicia (test-time augmentation).
 * Model punktów twarzy nie jest idealnie symetryczny - uśrednienie obu przebiegów zmniejsza jego błąd.
 */
export function mergeMirrored(original: Metrics, mirrored: Metrics): Metrics {
  const swapped: Metrics = { ...mirrored };
  for (const [a, b] of MIRROR_SWAP) {
    swapped[a] = mirrored[b];
    swapped[b] = mirrored[a];
  }
  const out: Metrics = {};
  for (const k of METRIC_KEYS) {
    const x = original[k];
    const y = swapped[k];
    if (x == null && y == null) continue;
    out[k] = roundTo(x != null && y != null ? (x + y) / 2 : (x ?? y)!, METRIC_INFO[k].digits);
  }
  return out;
}
