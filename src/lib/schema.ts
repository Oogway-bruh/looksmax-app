import { z } from "zod";
import { METRIC_KEYS } from "./metrics";

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

export type Database = {
  entries: KnowledgeEntry[];
  sources: KnowledgeSource[];
  nextEntryNumber: number;
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

export const AnalysisSchema = z.object({
  photoQuality: z.object({
    ok: z.boolean(),
    issues: z.array(z.string()),
  }),
  summary: z.string().describe("Podsumowanie 2-4 zdania"),
  areas: z.array(
    z.object({
      area: z.enum(AREAS),
      observation: z.string().describe("Co widać na zdjęciu / w pomiarach w odniesieniu do kryteriów z bazy"),
      score: z.number().nullable().describe("Ocena 1-10 wg kryteriów z bazy; null jeśli baza nie daje kryteriów oceny"),
      entryIds: z.array(z.string()).describe("ID wpisów z bazy, na których opiera się ocena"),
      strengths: z.array(z.string()),
      improvements: z.array(
        z.object({
          text: z.string(),
          entryIds: z.array(z.string()),
          priority: z.enum(["high", "medium", "low"]),
        }),
      ),
    }),
  ),
  topPriorities: z
    .array(z.object({ text: z.string(), entryIds: z.array(z.string()) }))
    .describe("3-5 najważniejszych zmian, od najważniejszej"),
  notCoveredByKnowledge: z
    .array(z.string())
    .describe("Cechy widoczne na zdjęciu, których baza wiedzy nie obejmuje - bez oceniania ich"),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

export type RuleResult = {
  entryId: string;
  title: string;
  metric: string;
  value: number;
  verdict: (typeof VERDICTS)[number];
  score: number;
  note: string;
};

export type AnalysisResponse = {
  analysis: Analysis;
  ruleResults: RuleResult[];
  overallScore: number | null;
  droppedUnsupported: number;
  entries: Pick<KnowledgeEntry, "id" | "title" | "area">[];
};
