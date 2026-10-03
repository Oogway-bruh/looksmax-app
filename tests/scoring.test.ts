import { describe, expect, it } from "vitest";
import { evaluateRules } from "@/lib/rules";
import type { Analysis, KnowledgeEntry } from "@/lib/schema";
import { buildReport } from "@/lib/scoring";

const entry = (id: string, patch: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  id,
  area: "eyes",
  title: `Wpis ${id}`,
  content: "treść",
  assessmentCriteria: "",
  metric: null,
  ranges: [],
  recommendations: ["zalecenie A", "zalecenie B"],
  priority: 3,
  sourceIds: [],
  updatedAt: "",
  ...patch,
});

const tiltEntry = entry("K001", {
  metric: "canthal_tilt",
  priority: 5,
  ranges: [
    { min: null, max: 0, verdict: "weak", score: 3, note: "negatywny" },
    { min: 0, max: 4, verdict: "good", score: 7, note: "lekko pozytywny" },
    { min: 4, max: null, verdict: "ideal", score: 9, note: "pozytywny" },
  ],
});

const assessment = (entryId: string, patch: Partial<Analysis["assessments"][number]> = {}): Analysis["assessments"][number] => ({
  entryId,
  status: "assessed",
  observation: "obserwacja",
  verdict: "average",
  score: 5,
  confidence: "high",
  recommendationIndexes: [],
  personalNote: "",
  ...patch,
});

const analysis = (assessments: Analysis["assessments"]): Analysis => ({
  photoQuality: { ok: true, issues: [] },
  summary: "podsumowanie",
  assessments,
  notCoveredByKnowledge: [],
});

describe("evaluateRules", () => {
  it("wybiera przedział wg wartości (min włącznie, max wyłącznie)", () => {
    expect(evaluateRules([tiltEntry], { canthal_tilt: 4 })[0].verdict).toBe("ideal");
    expect(evaluateRules([tiltEntry], { canthal_tilt: 3.9 })[0].verdict).toBe("good");
    expect(evaluateRules([tiltEntry], { canthal_tilt: -1 })[0].verdict).toBe("weak");
  });

  it("oznacza wynik na granicy, gdy niepewność pomiaru przecina próg", () => {
    expect(evaluateRules([tiltEntry], { canthal_tilt: 3.8 }, { canthal_tilt: 0.5 })[0].borderline).toBe(true);
    expect(evaluateRules([tiltEntry], { canthal_tilt: 2 }, { canthal_tilt: 0.5 })[0].borderline).toBe(false);
  });

  it("pomija wpisy bez pomiaru", () => {
    expect(evaluateRules([tiltEntry], {})).toHaveLength(0);
  });
});

describe("buildReport", () => {
  it("wynik reguły nadpisuje ocenę modelu", () => {
    const rules = evaluateRules([tiltEntry], { canthal_tilt: 5 });
    const report = buildReport([tiltEntry], analysis([assessment("K001", { verdict: "weak", score: 2 })]), rules);
    expect(report.areas[0].entries[0].score).toBe(9);
    expect(report.areas[0].entries[0].verdict).toBe("ideal");
  });

  it("zalecenia są brane dosłownie z bazy wg wskazanych numerów, błędne numery odrzucane", () => {
    const e = entry("K002");
    const report = buildReport([e], analysis([assessment("K002", { score: 4, recommendationIndexes: [1, 7, -1, 1] })]), []);
    expect(report.priorities[0].recommendations).toEqual(["zalecenie B"]);
  });

  it("słaba cecha bez wskazanych zaleceń dostaje wszystkie zalecenia z wpisu", () => {
    const report = buildReport([entry("K002")], analysis([assessment("K002", { score: 3 })]), []);
    expect(report.priorities[0].recommendations).toEqual(["zalecenie A", "zalecenie B"]);
  });

  it("ignoruje oceny wpisów, których nie ma w bazie, a brakujące oznacza jako nieocenione", () => {
    const report = buildReport([entry("K002"), entry("K003")], analysis([assessment("K002"), assessment("K999", { score: 1 })]), []);
    expect(report.coverage.assessed).toBe(1);
    expect(report.notVisible.map((e) => e.entryId)).toEqual(["K003"]);
  });

  it("wynik ogólny to średnia ważona priorytetem i pewnością", () => {
    const entries = [entry("A", { priority: 5 }), entry("B", { priority: 1, area: "skin" })];
    const report = buildReport(entries, analysis([assessment("A", { score: 8 }), assessment("B", { score: 2 })]), []);
    expect(report.overallScore).toBeCloseTo((8 * 5 + 2 * 1) / 6, 1);
  });

  it("priorytety zmian są sortowane wg wpływu = priorytet × (10 - ocena) × pewność", () => {
    const entries = [entry("A", { priority: 1 }), entry("B", { priority: 5 }), entry("C", { priority: 5 })];
    const report = buildReport(
      entries,
      analysis([assessment("A", { score: 2 }), assessment("B", { score: 5 }), assessment("C", { score: 5, confidence: "low" })]),
      [],
    );
    expect(report.priorities.map((p) => p.entryId)).toEqual(["B", "C", "A"]);
  });

  it("ogranicza oceny do zakresu 1-10", () => {
    const report = buildReport([entry("A")], analysis([assessment("A", { score: 42 })]), []);
    expect(report.overallScore).toBe(10);
  });

  it("zalecenia ogólne (advice) nie wpływają na wynik", () => {
    const report = buildReport([entry("A"), entry("B")], analysis([assessment("A", { score: 6 }), assessment("B", { status: "advice", score: 0 })]), []);
    expect(report.overallScore).toBe(6);
    expect(report.advice.map((a) => a.entryId)).toEqual(["B"]);
  });
});
