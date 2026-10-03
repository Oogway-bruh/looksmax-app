import type { Metrics } from "./metrics";
import type { KnowledgeEntry, RuleResult } from "./schema";

/**
 * Silnik reguł: dla wpisów z bazy, które mają przypisany pomiar i przedziały,
 * wynik liczy kod - deterministycznie i wyłącznie z Twoich progów.
 */
export function evaluateRules(entries: KnowledgeEntry[], metrics: Metrics): RuleResult[] {
  const results: RuleResult[] = [];
  for (const entry of entries) {
    if (!entry.metric || entry.ranges.length === 0) continue;
    const value = metrics[entry.metric];
    if (value == null || !Number.isFinite(value)) continue;
    const range = entry.ranges.find((r) => (r.min == null || value >= r.min) && (r.max == null || value < r.max));
    if (!range) continue;
    results.push({
      entryId: entry.id,
      title: entry.title,
      metric: entry.metric,
      value,
      verdict: range.verdict,
      score: range.score,
      note: range.note,
    });
  }
  return results;
}
