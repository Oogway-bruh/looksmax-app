import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { isMissingFileError, structuredCall } from "./claude";
import { prepareMaterialsForAnalysis } from "./knowledge";
import { UserError } from "./http";
import { METRIC_INFO, formatMetric, type MetricKey, type Metrics } from "./metrics";
import { evaluateRules } from "./rules";
import { allSourceBlocks } from "./materials";
import {
  AnalysisSchema,
  VERDICT_LABELS,
  categoryName,
  type AnalysisResponse,
  type Category,
  type Database,
  type KnowledgeEntry,
  type RuleResult,
} from "./schema";
import { buildReport } from "./scoring";
import { readDb } from "./store";

/** Do tego rozmiaru pełne materiały autora są dołączane do każdej analizy twarzy (z cache). */
const FULL_MATERIALS_LIMIT = 300_000;

const ANALYSIS_SYSTEM = `Oceniasz twarz ze zdjęć dla użytkownika aplikacji. Jedynym źródłem wiedzy, kryteriów i zaleceń są materiały autora aplikacji: uporządkowana baza wiedzy w <baza_wiedzy>, opis jego systemu oceny w <system_oceny_autora> oraz - jeśli są dołączone - pełne oryginalne materiały (<materialy_autora>). Gdy wpis bazy jest skrótowy lub niejasny, sprawdź szczegóły w pełnych materiałach.

Jak pracujesz:
1. Przejdź przez KAŻDY wpis bazy po kolei i zwróć dla niego dokładnie jeden element w assessments (entryId = ID wpisu).
2. status:
   - "assessed" - wpis opisuje cechę, którą da się ocenić na zdjęciach lub z pomiarów. Oceń ją wyłącznie wg treści i kryteriów wpisu: verdict, score 1-10 (ideal 9-10, good 7-8, average 5-6, weak 1-4), observation.
   - "advice" - wpis to ogólne zalecenie (np. pielęgnacja, nawyki), którego nie da się ocenić na zdjęciu, ale pasuje do tej osoby. score = 0.
   - "not_visible" - cechy nie widać (zasłonięta, zły kąt, wymaga profilu, którego nie ma) albo wpis nie dotyczy tej osoby. score = 0.
3. Wpisy z wynikiem w <wyniki_regul> są policzone kodem z progów autora - przyjmij werdykt jako fakt (status "assessed", ten sam verdict i score), w observation możesz dodać, co widać na zdjęciu.
4. recommendationIndexes: wskaż numery zaleceń z wpisu, które dotyczą tej osoby (dla cech ocenionych dobrze zwykle żadne). Nie wymyślaj własnych zaleceń - personalNote może tylko doprecyzować, jak zastosować zalecenia wpisu w przypadku tej osoby.
5. confidence: high - cecha dobrze widoczna; medium - częściowo widoczna lub pomiar niepewny; low - słabo widoczna, ocena orientacyjna.
6. Nie używaj ogólnie przyjętych kanonów piękna, własnej wiedzy ani informacji z internetu. Jeśli widzisz istotne cechy, których baza nie obejmuje, wypisz je w notCoveredByKnowledge bez oceniania.
7. Pomiary są przybliżone (zależą od zdjęcia, kąta i obiektywu) - podano ich niepewność (±). Problemy ze zdjęciem opisz w photoQuality.
8. Pisz po polsku, rzeczowo i z szacunkiem, bez obraźliwych określeń. Przy zabiegach medycznych zaznacz w personalNote konsultację ze specjalistą.
9. Oceniasz wyłącznie wygląd wg bazy. Nie zgaduj tożsamości, pochodzenia etnicznego, wieku, stanu zdrowia ani innych cech wrażliwych.
10. observation i personalNote: zwięźle, maksymalnie 2 zdania. Używaj terminologii autora.
11. Ocena ma odzwierciedlać sposób oceniania autora (opisany w <system_oceny_autora>), nie Twój.`;

function formatRange(r: KnowledgeEntry["ranges"][number], unit: string) {
  const lo = r.min == null ? "" : `od ${r.min}${unit}`;
  const hi = r.max == null ? "" : `do ${r.max}${unit}`;
  return `${[lo, hi].filter(Boolean).join(" ") || "dowolna wartość"} → ${VERDICT_LABELS[r.verdict]} (${r.score}/10)${r.note ? ` - ${r.note}` : ""}`;
}

/** Baza w formie czytelnej dla modelu: zalecenia ponumerowane, żeby model mógł je wskazać. */
export function knowledgeForAnalysis(entries: KnowledgeEntry[], categories: Category[]) {
  const order = [...new Set([...categories.map((c) => c.id), ...entries.map((e) => e.area)])];
  return order
    .flatMap((area) =>
      entries
        .filter((e) => e.area === area)
        .map((e) => {
          const where = [`kategoria: ${categoryName(categories, e.area)}`, e.topic ? `temat: ${e.topic}` : "", `priorytet ${e.priority}/5`]
            .filter(Boolean)
            .join(", ");
          const lines = [`[${e.id}] ${e.title} (${where})`, `Zasada: ${e.content}`];
          if (e.assessmentCriteria) lines.push(`Jak oceniać: ${e.assessmentCriteria}`);
          if (e.metric && e.ranges.length) {
            const unit = METRIC_INFO[e.metric].unit;
            lines.push(`Pomiar ${e.metric}: ${e.ranges.map((r) => formatRange(r, unit)).join("; ")}`);
          }
          if (e.recommendations.length) lines.push("Zalecenia:", ...e.recommendations.map((r, i) => `  [${i}] ${r}`));
          return lines.join("\n");
        }),
    )
    .join("\n\n");
}

function frameworkText(db: Database) {
  const cats = db.categories.map((c) => `- ${c.name} (waga ${c.weight}/5)${c.description ? `: ${c.description}` : ""}`).join("\n");
  const f = db.framework;
  return [
    f?.summary ? `Założenia autora:\n${f.summary}` : "",
    f?.scoringNotes ? `Jak autor ocenia:\n${f.scoringNotes}` : "",
    cats ? `Kategorie oceny:\n${cats}` : "",
    f?.contradictions.length
      ? `Sprzeczności w materiałach (nie rozstrzygaj ich, zaznacz niepewność):\n${f.contradictions.map((c) => `- ${c}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Czy dołączać pełne materiały: tylko gdy są przeanalizowane i mieszczą się w limicie. */
function shouldIncludeMaterials(db: Database) {
  if (db.sources.length === 0) return false;
  const images = db.sources.filter((s) => s.kind === "image").length;
  const pages = db.sources.reduce((n, s) => n + (s.kind === "pdf" ? (s.pages ?? 1) : 0), 0);
  // Limity API na zapytanie: 600 obrazów i 600 stron PDF (z zapasem na zdjęcia twarzy).
  if (images > 300 || pages > 300) return false;
  const tokens = db.framework?.materialTokens;
  if (tokens != null) return tokens <= FULL_MATERIALS_LIMIT;
  return db.sources.reduce((s, x) => s + x.size, 0) < 1_500_000;
}

function measurementsText(metrics: Metrics, spreads: Partial<Record<MetricKey, number>>, samples: number) {
  const lines = (Object.entries(metrics) as [MetricKey, number][]).map(([k, v]) => {
    const spread = spreads[k];
    return `- ${k} (${METRIC_INFO[k].label}): ${formatMetric(k, v)}${spread ? ` ±${spread}` : ""}`;
  });
  return `Pomiar z ${samples} ${samples === 1 ? "ujęcia" : "ujęć"} (mediana, ± = rozrzut między ujęciami), po korekcie obrotu głowy:\n${lines.join("\n")}`;
}

function rulesText(rules: RuleResult[]) {
  if (rules.length === 0) return "Brak wpisów z regułami liczbowymi.";
  return rules
    .map(
      (r) =>
        `- ${r.entryId} (${r.title}): ${formatMetric(r.metric, r.value)} → ${VERDICT_LABELS[r.verdict]} (${r.score}/10)${r.borderline ? " [na granicy przedziału]" : ""}`,
    )
    .join("\n");
}

type ImageInput = { data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" };

export async function analyzeFace(input: {
  front: ImageInput;
  profile?: ImageInput;
  metrics: Metrics;
  spreads: Partial<Record<MetricKey, number>>;
  samples: number;
  qualityNotes: string[];
}): Promise<AnalysisResponse> {
  const db = await readDb();
  if (db.entries.length === 0) throw new UserError("Baza wiedzy jest pusta - najpierw dodaj materiały w panelu administratora.", 409);

  const rules = evaluateRules(db.entries, input.metrics, input.spreads);

  const includeMaterials = shouldIncludeMaterials(db);
  const run = async (forceReupload: boolean) => {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (includeMaterials) {
      // Obrazy i PDF-y przez Files API - zapytanie zostaje małe nawet przy wielu plikach.
      await prepareMaterialsForAnalysis(forceReupload);
      const materials = await allSourceBlocks((await readDb()).sources);
      content.push({ type: "text", text: "<materialy_autora>" }, ...materials, { type: "text", text: "</materialy_autora>" });
      // Materiały są takie same dla każdej analizy - cache obniża koszt i czas kolejnych analiz.
      const last = content[content.length - 1] as Anthropic.Beta.BetaTextBlockParam;
      last.cache_control = { type: "ephemeral" };
    }
    content.push(
      { type: "text", text: "Zdjęcie przodu twarzy:" },
      { type: "image", source: { type: "base64", media_type: input.front.mediaType, data: input.front.data } },
    );
    if (input.profile) {
      content.push(
        { type: "text", text: "Zdjęcie profilu:" },
        { type: "image", source: { type: "base64", media_type: input.profile.mediaType, data: input.profile.data } },
      );
    }
    content.push({
      type: "text",
      text: [
        `<pomiary>\n${measurementsText(input.metrics, input.spreads, input.samples)}\n</pomiary>`,
        `<wyniki_regul>\n${rulesText(rules)}\n</wyniki_regul>`,
        input.qualityNotes.length ? `<jakosc_zdjecia>\n${input.qualityNotes.join("\n")}\n</jakosc_zdjecia>` : "",
        input.profile ? "" : "Brak zdjęcia profilu - cechy widoczne tylko z boku oznacz jako not_visible lub oceń z niską pewnością.",
        `Oceń tę twarz według bazy wiedzy - wszystkie ${db.entries.length} wpisów.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });

    return structuredCall({
      schema: AnalysisSchema,
      system: [
        { type: "text", text: ANALYSIS_SYSTEM },
        // Baza jest taka sama dla każdego użytkownika - cache obniża koszt i czas kolejnych analiz.
        {
          type: "text",
          text: `<system_oceny_autora>\n${frameworkText(db)}\n</system_oceny_autora>\n\n<baza_wiedzy>\n${knowledgeForAnalysis(db.entries, db.categories)}\n</baza_wiedzy>`,
          cache_control: { type: "ephemeral" },
        },
      ],
      content,
      effort: "high",
      maxTokens: 128000,
    });
  };

  let analysis;
  try {
    analysis = await run(false);
  } catch (err) {
    // Pliki w Files API zniknęły (np. zmiana klucza API) - wgrywamy je ponownie i próbujemy raz jeszcze.
    if (!includeMaterials || !isMissingFileError(err)) throw err;
    analysis = await run(true);
  }

  return buildReport(db.entries, analysis, rules, db.categories, includeMaterials);
}
