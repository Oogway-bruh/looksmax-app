import type { MetricKey, Metrics } from "./metrics";
import type { KnowledgeEntry, RuleResult } from "./schema";

const inRange = (v: number, r: { min: number | null; max: number | null }) => (r.min == null || v >= r.min) && (r.max == null || v < r.max);

/**
 * Silnik reguł: dla wpisów z bazy, które mają przypisany pomiar i przedziały,
 * wynik liczy kod - deterministycznie i wyłącznie z Twoich progów.
 * `spreads` (niepewność pomiaru) służy do oznaczenia wyników na granicy przedziałów.
 */
export function evaluateRules(
  entries: KnowledgeEntry[],
  metrics: Metrics,
  spreads: Partial<Record<MetricKey, number>> = {},
): RuleResult[] {
  const results: RuleResult[] = [];
  for (const entry of entries) {
    if (!entry.metric || entry.ranges.length === 0) continue;
    const value = metrics[entry.metric];
    if (value == null || !Number.isFinite(value)) continue;
    const range = entry.ranges.find((r) => inRange(value, r));
    if (!range) continue;
    const spread = spreads[entry.metric] ?? 0;
    // Granica: przy niepewności ±spread wynik mógłby wpaść do innego przedziału.
    const borderline = spread > 0 && (!inRange(value - spread, range) || !inRange(value + spread, range));
    results.push({
      entryId: entry.id,
      title: entry.title,
      metric: entry.metric,
      value,
      verdict: range.verdict,
      score: range.score,
      note: range.note,
      borderline,
    });
  }
  return results;
}
