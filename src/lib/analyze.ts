import "server-only";
import { UserError } from "./http";
import { structuredCall } from "./claude";
import { evaluateRules } from "./rules";
import { METRIC_INFO, type Metrics, type MetricKey } from "./metrics";
import { AREAS, AREA_LABELS, AnalysisSchema, type AnalysisResponse } from "./schema";
import { entriesForPrompt } from "./knowledge";
import { readDb } from "./store";

const ANALYSIS_SYSTEM = `Oceniasz twarz ze zdjęcia dla użytkownika aplikacji. Jedynym źródłem wiedzy, kryteriów i zaleceń jest baza wiedzy autora aplikacji podana niżej w <baza_wiedzy>.

Zasady (ich złamanie unieważnia ocenę):
1. Każda ocena, mocna strona i zalecenie musi wynikać z konkretnych wpisów bazy - podawaj ich ID w entryIds. Nie używaj ogólnie przyjętych kanonów piękna, własnej wiedzy ani informacji z internetu.
2. Jeśli baza nie zawiera kryteriów dla jakiejś cechy, nie oceniaj jej - wpisz ją do notCoveredByKnowledge.
3. Wyniki silnika reguł (<wyniki_regul>) są policzone kodem z progów autora - przyjmij je jako fakt; możesz je skomentować, ale nie zmieniaj werdyktu.
4. Pomiary są przybliżone (zależą od zdjęcia, kąta i obiektywu). Gdy zdjęcie ma wyraźne problemy (kąt, światło, zasłonięta twarz), zaznacz to w photoQuality.
5. score 1-10 dla obszaru tylko wtedy, gdy baza daje do tego kryteria; inaczej null.
6. Pisz po polsku, rzeczowo i z szacunkiem, bez obraźliwych określeń. Zalecenia mają być konkretne i wykonalne. Przy zabiegach medycznych dodaj, że decyzję należy skonsultować ze specjalistą.
7. Oceniasz wyłącznie wygląd wg bazy. Nie zgaduj tożsamości, pochodzenia etnicznego, stanu zdrowia ani innych cech wrażliwych.

Obszary (pole area): ${AREAS.map((a) => `${a} (${AREA_LABELS[a]})`).join(", ")}`;

export async function analyzeFace(input: {
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  metrics: Metrics;
  warnings: string[];
}): Promise<AnalysisResponse> {
  const db = await readDb();
  if (db.entries.length === 0) throw new UserError("Baza wiedzy jest pusta - najpierw dodaj materiały w panelu administratora.", 409);

  const ruleResults = evaluateRules(db.entries, input.metrics);
  const metricsText = (Object.entries(input.metrics) as [MetricKey, number][])
    .map(([k, v]) => `- ${k} (${METRIC_INFO[k].label}): ${v}${METRIC_INFO[k].unit}`)
    .join("\n");

  const analysis = await structuredCall({
    schema: AnalysisSchema,
    system: [
      { type: "text", text: ANALYSIS_SYSTEM },
      // Baza jest taka sama dla każdego użytkownika - cache obniża koszt i czas kolejnych analiz.
      { type: "text", text: `<baza_wiedzy>\n${entriesForPrompt(db.entries)}\n</baza_wiedzy>`, cache_control: { type: "ephemeral" } },
    ],
    content: [
      { type: "image", source: { type: "base64", media_type: input.mediaType, data: input.imageBase64 } },
      {
        type: "text",
        text: [
          `<pomiary>\n${metricsText}\n</pomiary>`,
          `<wyniki_regul>\n${JSON.stringify(ruleResults, null, 1)}\n</wyniki_regul>`,
          input.warnings.length ? `<ostrzezenia_zdjecia>\n${input.warnings.join("\n")}\n</ostrzezenia_zdjecia>` : "",
          "Oceń tę twarz według bazy wiedzy.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    effort: "high",
  });

  // Walidacja: wszystko, co nie ma pokrycia w istniejących wpisach bazy, odrzucamy.
  const known = new Set(db.entries.map((e) => e.id));
  let dropped = 0;
  const keepIds = (ids: string[]) => ids.filter((id) => known.has(id));
  analysis.areas = analysis.areas
    .map((a) => {
      const improvements = a.improvements
        .map((i) => ({ ...i, entryIds: keepIds(i.entryIds) }))
        .filter((i) => i.entryIds.length > 0 || (dropped++, false));
      return { ...a, entryIds: keepIds(a.entryIds), improvements };
    })
    .filter((a) => a.entryIds.length > 0 || (dropped++, false));
  analysis.topPriorities = analysis.topPriorities
    .map((p) => ({ ...p, entryIds: keepIds(p.entryIds) }))
    .filter((p) => p.entryIds.length > 0 || (dropped++, false));

  // Wynik ogólny: średnia ocen obszarów i reguł liczonych kodem.
  const scores = [
    ...analysis.areas.map((a) => a.score).filter((s): s is number => s != null),
    ...ruleResults.map((r) => r.score),
  ].filter((s) => s >= 1 && s <= 10);
  const overallScore = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;

  return {
    analysis,
    ruleResults,
    overallScore,
    droppedUnsupported: dropped,
    entries: db.entries.map(({ id, title, area }) => ({ id, title, area })),
  };
}
