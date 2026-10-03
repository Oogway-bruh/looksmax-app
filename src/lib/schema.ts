import { z } from "zod";
import { METRIC_KEYS, type MetricKey } from "./metrics";

export const AREAS = [
  "eyes",
  "eyebrows",
  "nose",
  "lips",
  "jaw_chin",
  "cheekbones",
  "proportions",
  "symmetry",
  "skin",
  "hair",
  "facial_hair",
  "face_shape",
  "general",
] as const;

export type Area = (typeof AREAS)[number];

export const AREA_LABELS: Record<Area, string> = {
  eyes: "Oczy",
  eyebrows: "Brwi",
  nose: "Nos",
  lips: "Usta",
  jaw_chin: "Żuchwa i broda",
  cheekbones: "Kości policzkowe",
  proportions: "Proporcje",
  symmetry: "Symetria",
  skin: "Skóra",
  hair: "Włosy",
  facial_hair: "Zarost",
  face_shape: "Kształt twarzy",
  general: "Ogólne",
};

export const VERDICTS = ["ideal", "good", "average", "weak"] as const;
export const VERDICT_LABELS: Record<(typeof VERDICTS)[number], string> = {
  ideal: "idealnie",
  good: "dobrze",
  average: "przeciętnie",
  weak: "słabo",
};

// Przedział wartości pomiaru i co on oznacza według Twojej wiedzy.
export const RangeSchema = z.object({
  min: z.number().nullable().describe("Dolna granica (włącznie) lub null, jeśli brak"),
  max: z.number().nullable().describe("Górna granica (wyłącznie) lub null, jeśli brak"),
  verdict: z.enum(VERDICTS),
  score: z.number().describe("Ocena 1-10 dla tego przedziału"),
  note: z.string().describe("Krótki komentarz z bazy wiedzy dla tego przedziału"),
});

// To, co model zwraca przy wyciąganiu wiedzy z materiałów (bez pól technicznych).
export const DraftEntrySchema = z.object({
  area: z.enum(AREAS),
  title: z.string().describe("Krótki tytuł zasady"),
  content: z.string().describe("Sedno zasady/wiedzy, zwięźle, wiernie wg materiału"),
  assessmentCriteria: z
    .string()
    .describe("Jak ocenić tę cechę na zdjęciu twarzy - konkretne kryteria wg materiału. Pusty string, jeśli brak"),
  metric: z
    .enum(METRIC_KEYS)
    .nullable()
    .describe("Klucz pomiaru, jeśli zasada podaje progi liczbowe pasujące do jednego z pomiarów; inaczej null"),
  ranges: z.array(RangeSchema).describe("Przedziały wartości pomiaru - tylko jeśli materiał je podaje"),
  recommendations: z.array(z.string()).describe("Konkretne zalecenia/działania wg materiału"),
  priority: z.number().describe("Ważność 1-5 (5 = kluczowe)"),
});

export type DraftEntry = z.infer<typeof DraftEntrySchema>;

export const KnowledgeEntrySchema = DraftEntrySchema.extend({
  id: z.string(),
  sourceIds: z.array(z.string()),
  updatedAt: z.string(),
});

export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

export type KnowledgeSource = {
  id: string;
  filename: string;
  kind: "text" | "image" | "pdf";
  uploadedAt: string;
  entryCount: number;
  notes: string;
};

export type ConsolidationProposal = {
  createdAt: string;
  /** ID wpisów, które istniały w chwili tworzenia propozycji */
  basedOn: string[];
  entries: (DraftEntry & { mergedFrom: string[] })[];
  changes: string[];
};

export type Database = {
  entries: KnowledgeEntry[];
  sources: KnowledgeSource[];
  nextEntryNumber: number;
  pendingConsolidation?: ConsolidationProposal | null;
};

export const ExtractionSchema = z.object({
  entries: z.array(DraftEntrySchema),
  notes: z.string().describe("Uwagi: co było nieczytelne, sprzeczne lub niejasne w materiale. Pusty string, jeśli nic"),
});

export const ConsolidationSchema = z.object({
  entries: z.array(
    DraftEntrySchema.extend({
      mergedFrom: z.array(z.string()).describe("ID wpisów, z których powstał ten wpis"),
    }),
  ),
  changes: z.array(z.string()).describe("Lista najważniejszych zmian: co połączono, co usunięto i dlaczego"),
});

export const CONFIDENCE = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

// To, co zwraca Claude: ocena KAŻDEGO wpisu bazy osobno. Liczby końcowe i kolejność liczy kod.
export const AnalysisSchema = z.object({
  photoQuality: z.object({
    ok: z.boolean(),
    issues: z.array(z.string()).describe("Problemy ze zdjęciem, które obniżają pewność oceny"),
  }),
  summary: z.string().describe("Podsumowanie 2-4 zdania: najmocniejsze strony i najważniejsze obszary do poprawy wg bazy"),
  assessments: z
    .array(
      z.object({
        entryId: z.string(),
        status: z
          .enum(["assessed", "advice", "not_visible"])
          .describe("assessed = oceniono cechę; advice = ogólne zalecenie z bazy pasujące do tej osoby, bez oceny; not_visible = nie da się ocenić ze zdjęć"),
        observation: z.string().describe("1-2 zdania: co widać, odniesione do kryteriów wpisu"),
        verdict: z.enum(VERDICTS),
        score: z.number().describe("1-10 wg kryteriów wpisu (dla advice/not_visible: 0)"),
        confidence: z.enum(CONFIDENCE),
        recommendationIndexes: z.array(z.number()).describe("Numery zaleceń z wpisu [0, 1, ...], które dotyczą tej osoby"),
        personalNote: z.string().describe("Krótko, jak zastosować zalecenia wpisu u tej osoby - tylko na podstawie wpisu. Pusty string, jeśli nic"),
      }),
    )
    .describe("Dokładnie jeden element dla każdego wpisu bazy, w kolejności wpisów"),
  notCoveredByKnowledge: z.array(z.string()).describe("Cechy widoczne na zdjęciu, których baza nie obejmuje - bez oceniania ich"),
});

export type Analysis = z.infer<typeof AnalysisSchema>;
export type AssessmentStatus = Analysis["assessments"][number]["status"];

export type RuleResult = {
  entryId: string;
  title: string;
  metric: MetricKey;
  value: number;
  verdict: (typeof VERDICTS)[number];
  score: number;
  note: string;
  /** Wartość z niepewnością pomiaru przecina granicę przedziału */
  borderline: boolean;
};

export type AssessedEntry = {
  entryId: string;
  title: string;
  area: Area;
  priority: number;
  status: AssessmentStatus;
  observation: string;
  verdict: (typeof VERDICTS)[number] | null;
  score: number | null;
  confidence: Confidence;
  /** Zalecenia dosłownie z bazy */
  recommendations: string[];
  personalNote: string;
  rule: RuleResult | null;
  /** Wpływ na wygląd = priorytet × (10 - ocena) × pewność */
  impact: number;
};

export type AreaResult = { area: Area; score: number | null; entries: AssessedEntry[] };

export type AnalysisResponse = {
  summary: string;
  photoQuality: Analysis["photoQuality"];
  overallScore: number | null;
  areas: AreaResult[];
  priorities: AssessedEntry[];
  strengths: AssessedEntry[];
  advice: AssessedEntry[];
  notVisible: AssessedEntry[];
  notCovered: string[];
  coverage: { totalEntries: number; assessed: number; ruleBased: number };
  createdAt: string;
};
