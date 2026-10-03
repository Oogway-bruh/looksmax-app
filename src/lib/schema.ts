import { z } from "zod";
import { METRIC_KEYS, type MetricKey } from "./metrics";

// Kategorie oceny pochodzą z materiałów autora. Te domyślne służą tylko jako punkt startowy
// (i do migracji starszych baz) - analiza materiałów zastępuje je kategoriami autora.
export const DEFAULT_CATEGORIES: Category[] = [
  { id: "eyes", name: "Oczy", description: "", weight: 3 },
  { id: "eyebrows", name: "Brwi", description: "", weight: 3 },
  { id: "nose", name: "Nos", description: "", weight: 3 },
  { id: "lips", name: "Usta", description: "", weight: 3 },
  { id: "jaw_chin", name: "Żuchwa i broda", description: "", weight: 3 },
  { id: "cheekbones", name: "Kości policzkowe", description: "", weight: 3 },
  { id: "proportions", name: "Proporcje", description: "", weight: 3 },
  { id: "symmetry", name: "Symetria", description: "", weight: 3 },
  { id: "skin", name: "Skóra", description: "", weight: 3 },
  { id: "hair", name: "Włosy", description: "", weight: 3 },
  { id: "facial_hair", name: "Zarost", description: "", weight: 3 },
  { id: "face_shape", name: "Kształt twarzy", description: "", weight: 3 },
  { id: "general", name: "Ogólne", description: "", weight: 3 },
];

export type Category = {
  id: string;
  name: string;
  description: string;
  /** Waga kategorii w ocenie ogólnej, 1-5 */
  weight: number;
};

export const VERDICTS = ["ideal", "good", "average", "weak"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const VERDICT_LABELS: Record<Verdict, string> = {
  ideal: "idealnie",
  good: "dobrze",
  average: "przeciętnie",
  weak: "słabo",
};

// Przedział wartości pomiaru i co on oznacza według wiedzy autora.
export const RangeSchema = z.object({
  min: z.number().nullable().describe("Dolna granica (włącznie) lub null, jeśli brak"),
  max: z.number().nullable().describe("Górna granica (wyłącznie) lub null, jeśli brak"),
  verdict: z.enum(VERDICTS),
  score: z.number().describe("Ocena 1-10 dla tego przedziału"),
  note: z.string().describe("Krótki komentarz z materiałów dla tego przedziału"),
});

export const DraftEntrySchema = z.object({
  area: z.string().describe("ID kategorii (z listy kategorii)"),
  title: z.string().describe("Krótki tytuł zasady"),
  content: z.string().describe("Pełna treść zasady wg materiałów - bez gubienia szczegółów, liczb, wyjątków"),
  assessmentCriteria: z.string().describe("Jak ocenić tę cechę na zdjęciu twarzy - konkretne kryteria wg materiałów. Pusty string, jeśli brak"),
  metric: z.enum(METRIC_KEYS).nullable().describe("Klucz pomiaru automatycznego, jeśli materiały podają progi liczbowe dla tej cechy; inaczej null"),
  ranges: z.array(RangeSchema).describe("Przedziały wartości pomiaru - tylko jeśli materiały je podają"),
  recommendations: z.array(z.string()).describe("Konkretne zalecenia/działania wg materiałów, każde osobno"),
  priority: z.number().describe("Ważność 1-5 (5 = kluczowe) wg materiałów"),
});

export type DraftEntry = z.infer<typeof DraftEntrySchema>;

export const KnowledgeEntrySchema = DraftEntrySchema.extend({
  id: z.string(),
  sourceIds: z.array(z.string()),
  updatedAt: z.string(),
  /** Wpis dodany lub poprawiony ręcznie - ponowna analiza materiałów go zachowuje */
  manual: z.boolean().optional(),
  /** Temat wg struktury folderów autora, np. "Oczy › Canthal tilt" */
  topic: z.string().optional(),
});

export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

export type KnowledgeSource = {
  id: string;
  /** Ścieżka względna z folderami, np. "Looksmax/Oczy/canthal.txt" (identyfikuje materiał) */
  path: string;
  /** Sama nazwa pliku */
  filename: string;
  kind: "text" | "image" | "pdf";
  mediaType: string;
  /** Plik w data/sources */
  storedAs: string;
  size: number;
  /** SHA-256 treści - do wykrywania duplikatów i zmian */
  hash: string;
  /** Wymiary obrazu (do szacowania kosztu w tokenach) */
  width?: number;
  height?: number;
  /** Przybliżona liczba stron PDF */
  pages?: number;
  /** ID pliku w Anthropic Files API (obrazy i PDF-y) - żeby nie wysyłać ich za każdym razem */
  fileId?: string | null;
  uploadedAt: string;
  /** Ile wpisów wskazuje ten materiał jako źródło (po ostatniej analizie) */
  entryCount: number;
  notes: string;
};

/** Jak autor ocenia wygląd - wynik analizy wszystkich materiałów. */
export type Framework = {
  summary: string;
  scoringNotes: string;
  contradictions: string[];
  gaps: string[];
  /** Rozmiar wszystkich materiałów w tokenach (do decyzji, czy dołączać je w całości do analizy twarzy) */
  materialTokens: number | null;
  analyzedAt: string;
  sourceIds: string[];
};

export const SynthesisSchema = z.object({
  framework: z.object({
    summary: z.string().describe("Jak autor ocenia wygląd: główne założenia, co uważa za najważniejsze, jego terminologia - 5-15 zdań"),
    scoringNotes: z.string().describe("Jak wg autora przekładać cechy na ocenę (skale, progi, co obniża/podnosi wynik). Pusty string, jeśli materiały nic nie mówią"),
  }),
  categories: z
    .array(
      z.object({
        id: z.string().describe("Krótki identyfikator, małe litery i podkreślniki, np. oczy, linia_zuchwy"),
        name: z.string().describe("Nazwa kategorii tak, jak nazywa ją autor"),
        description: z.string().describe("Co obejmuje kategoria"),
        weight: z.number().describe("Waga w ocenie ogólnej 1-5 wg materiałów (3, jeśli materiały nie mówią)"),
      }),
    )
    .describe("Kategorie oceny wynikające z materiałów"),
  entries: z.array(
    DraftEntrySchema.extend({
      topic: z.string().describe("Temat wg struktury folderów autora, np. 'Oczy › Canthal tilt' (foldery oddzielone ›); pusty string, jeśli brak folderów"),
      sourceFiles: z.array(z.string()).describe("Pełne ścieżki plików (z folderami, dokładnie jak w materiałach), z których pochodzi wpis"),
      fromManual: z.array(z.string()).describe("ID ręcznych wpisów autora uwzględnionych w tym wpisie"),
    }),
  ),
  contradictions: z.array(z.string()).describe("Sprzeczności między materiałami - ze ścieżkami plików"),
  gaps: z.array(z.string()).describe("Czego brakuje, żeby oceniać twarz wg tych materiałów (np. brak kryteriów dla jakiejś cechy, brak progów)"),
  unreadable: z.array(z.string()).describe("Pliki lub fragmenty nieczytelne/niezrozumiałe"),
});

export type Synthesis = z.infer<typeof SynthesisSchema>;

export type SynthesisProposal = {
  createdAt: string;
  mode: "full" | "batched";
  materialTokens: number | null;
  /** ID wpisów, które istniały w chwili tworzenia propozycji */
  basedOn: string[];
  sourceIds: string[];
  synthesis: Synthesis;
};

export type Database = {
  entries: KnowledgeEntry[];
  categories: Category[];
  sources: KnowledgeSource[];
  framework: Framework | null;
  nextEntryNumber: number;
  pendingSynthesis?: SynthesisProposal | null;
};

export const CONFIDENCE = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

// To, co zwraca Claude przy analizie twarzy: ocena KAŻDEGO wpisu bazy osobno. Liczby końcowe liczy kod.
export const AnalysisSchema = z.object({
  photoQuality: z.object({
    ok: z.boolean(),
    issues: z.array(z.string()).describe("Problemy ze zdjęciem, które obniżają pewność oceny"),
  }),
  summary: z.string().describe("Podsumowanie 3-5 zdań w języku i stylu materiałów autora: najmocniejsze strony i najważniejsze obszary do poprawy"),
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
        personalNote: z.string().describe("Krótko, jak zastosować zalecenia wpisu u tej osoby - tylko na podstawie materiałów. Pusty string, jeśli nic"),
      }),
    )
    .describe("Dokładnie jeden element dla każdego wpisu bazy, w kolejności wpisów"),
  notCoveredByKnowledge: z.array(z.string()).describe("Cechy widoczne na zdjęciu, których materiały nie obejmują - bez oceniania ich"),
});

export type Analysis = z.infer<typeof AnalysisSchema>;
export type AssessmentStatus = Analysis["assessments"][number]["status"];

export type RuleResult = {
  entryId: string;
  title: string;
  metric: MetricKey;
  value: number;
  verdict: Verdict;
  score: number;
  note: string;
  /** Wartość z niepewnością pomiaru przecina granicę przedziału */
  borderline: boolean;
};

export type AssessedEntry = {
  entryId: string;
  title: string;
  area: string;
  areaName: string;
  priority: number;
  status: AssessmentStatus;
  observation: string;
  verdict: Verdict | null;
  score: number | null;
  confidence: Confidence;
  /** Zalecenia dosłownie z bazy */
  recommendations: string[];
  personalNote: string;
  rule: RuleResult | null;
  /** Wpływ na wygląd = priorytet × waga kategorii × (10 - ocena) × pewność */
  impact: number;
};

export type AreaResult = { area: string; name: string; weight: number; score: number | null; entries: AssessedEntry[] };

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
  coverage: { totalEntries: number; assessed: number; ruleBased: number; usedFullMaterials: boolean };
  createdAt: string;
};

/** Nazwa kategorii po ID (z zapasem dla nieznanych). */
export function categoryName(categories: Category[], id: string): string {
  return categories.find((c) => c.id === id)?.name ?? DEFAULT_CATEGORIES.find((c) => c.id === id)?.name ?? id;
}

/** Zamienia dowolny tekst na identyfikator kategorii. */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ł/g, "l")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "kategoria"
  );
}
