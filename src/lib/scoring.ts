import { categoryName, type Analysis, type AnalysisResponse, type AreaResult, type AssessedEntry, type Category, type Confidence, type KnowledgeEntry, type RuleResult } from "./schema";

const CONFIDENCE_WEIGHT: Record<Confidence, number> = { low: 0.5, medium: 0.8, high: 1 };
const clampScore = (s: number) => Math.min(10, Math.max(1, s));
const round1 = (v: number) => Math.round(v * 10) / 10;

function weightedMean(items: AssessedEntry[], categoryWeight: (area: string) => number = () => 1): number | null {
  let sum = 0;
  let weight = 0;
  for (const e of items) {
    if (e.status !== "assessed" || e.score == null) continue;
    const w = e.priority * categoryWeight(e.area) * CONFIDENCE_WEIGHT[e.confidence];
    sum += e.score * w;
    weight += w;
  }
  return weight > 0 ? round1(sum / weight) : null;
}

/**
 * Składa raport z ocen poszczególnych wpisów. Wszystko, co liczbowe, liczy kod:
 * - wpisy z regułami dostają werdykt i ocenę z Twoich progów (model nie może ich zmienić),
 * - oceny kategorii to średnie ważone priorytetem wpisu i pewnością oceny,
 * - ocena ogólna dodatkowo uwzględnia wagę kategorii (z materiałów autora),
 * - priorytety zmian są sortowane wg wpływu = priorytet × waga kategorii × (10 - ocena) × pewność,
 * - zalecenia są brane dosłownie z bazy (model wskazuje tylko, które dotyczą tej osoby).
 */
export function buildReport(
  entries: KnowledgeEntry[],
  analysis: Analysis,
  rules: RuleResult[],
  categories: Category[] = [],
  usedFullMaterials = false,
): AnalysisResponse {
  const catWeight = (area: string) => categories.find((c) => c.id === area)?.weight ?? 3;
  const byId = new Map(analysis.assessments.map((a) => [a.entryId, a]));
  const ruleById = new Map(rules.map((r) => [r.entryId, r]));

  const assessed: AssessedEntry[] = entries.map((entry) => {
    const a = byId.get(entry.id);
    const rule = ruleById.get(entry.id) ?? null;
    const recommendations = (a?.recommendationIndexes ?? [])
      .filter((i, pos, arr) => Number.isInteger(i) && i >= 0 && i < entry.recommendations.length && arr.indexOf(i) === pos)
      .map((i) => entry.recommendations[i]);

    let status = a?.status ?? "not_visible";
    let verdict = a?.verdict ?? null;
    let score: number | null = a && a.status === "assessed" ? clampScore(a.score) : null;
    let confidence: Confidence = a?.confidence ?? "low";
    if (rule) {
      // Wynik z reguły ma pierwszeństwo przed oceną modelu.
      status = "assessed";
      verdict = rule.verdict;
      score = clampScore(rule.score);
      confidence = rule.borderline ? "medium" : "high";
    }
    if (status !== "assessed") verdict = null;

    const priority = Math.min(5, Math.max(1, Math.round(entry.priority)));
    // Gdy model nie wskazał zaleceń, a cecha wypada słabo - pokazujemy wszystkie zalecenia z wpisu.
    const recs = recommendations.length || status !== "assessed" || (score ?? 10) >= 7 ? recommendations : entry.recommendations;
    return {
      entryId: entry.id,
      title: entry.title,
      area: entry.area,
      areaName: categoryName(categories, entry.area),
      priority,
      status,
      observation: a?.observation ?? (rule ? rule.note : "Model nie ocenił tego wpisu."),
      verdict,
      score,
      confidence,
      recommendations: recs,
      personalNote: a?.personalNote ?? "",
      rule,
      impact:
        status === "assessed" && score != null ? round1((priority * catWeight(entry.area) * (10 - score) * CONFIDENCE_WEIGHT[confidence]) / 3) : 0,
    };
  });

  // Kolejność kategorii: najpierw najważniejsze wg autora.
  const areaIds = [...new Set([...categories.map((c) => c.id), ...entries.map((e) => e.area)])];
  const areas: AreaResult[] = areaIds
    .map((area) => {
      const list = assessed.filter((e) => e.area === area && e.status === "assessed");
      return {
        area,
        name: categoryName(categories, area),
        weight: catWeight(area),
        score: weightedMean(list),
        entries: list.sort((x, y) => y.priority - x.priority),
      };
    })
    .filter((a) => a.entries.length > 0)
    .sort((x, y) => y.weight - x.weight);

  const scored = assessed.filter((e) => e.status === "assessed" && e.score != null);
  return {
    summary: analysis.summary,
    photoQuality: analysis.photoQuality,
    overallScore: weightedMean(scored, catWeight),
    areas,
    priorities: scored
      .filter((e) => e.score! < 7 && e.impact > 0)
      .sort((x, y) => y.impact - x.impact || y.priority - x.priority),
    strengths: scored.filter((e) => e.score! >= 8).sort((x, y) => y.priority - x.priority || y.score! - x.score!),
    advice: assessed.filter((e) => e.status === "advice").sort((x, y) => y.priority - x.priority),
    notVisible: assessed.filter((e) => e.status === "not_visible"),
    notCovered: analysis.notCoveredByKnowledge,
    coverage: { totalEntries: entries.length, assessed: scored.length, ruleBased: rules.length, usedFullMaterials },
    createdAt: new Date().toISOString(),
  };
}
