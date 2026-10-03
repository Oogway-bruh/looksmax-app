import { describe, expect, it } from "vitest";
import { detectKind } from "@/lib/materials";
import { slugify, type Analysis, type KnowledgeEntry } from "@/lib/schema";
import { buildReport } from "@/lib/scoring";
import { normalizeDb } from "@/lib/store";

const entry = (id: string, area: string, priority = 3): KnowledgeEntry => ({
  id,
  area,
  title: id,
  content: "",
  assessmentCriteria: "",
  metric: null,
  ranges: [],
  recommendations: ["r"],
  priority,
  sourceIds: [],
  updatedAt: "",
});

const assessed = (entryId: string, score: number): Analysis["assessments"][number] => ({
  entryId,
  status: "assessed",
  observation: "",
  verdict: "average",
  score,
  confidence: "high",
  recommendationIndexes: [],
  personalNote: "",
});

describe("kategorie autora", () => {
  it("waga kategorii wpływa na ocenę ogólną i kolejność priorytetów", () => {
    const categories = [
      { id: "oczy", name: "Oczy (hunter eyes)", description: "", weight: 5 },
      { id: "skora", name: "Skóra", description: "", weight: 1 },
    ];
    const report = buildReport(
      [entry("A", "oczy"), entry("B", "skora")],
      { photoQuality: { ok: true, issues: [] }, summary: "", assessments: [assessed("A", 4), assessed("B", 4)], notCoveredByKnowledge: [] },
      [],
      categories,
    );
    expect(report.areas.map((a) => a.name)).toEqual(["Oczy (hunter eyes)", "Skóra"]);
    expect(report.priorities[0].entryId).toBe("A");
    expect(report.priorities[0].areaName).toBe("Oczy (hunter eyes)");

    const mixed = buildReport(
      [entry("A", "oczy"), entry("B", "skora")],
      { photoQuality: { ok: true, issues: [] }, summary: "", assessments: [assessed("A", 8), assessed("B", 2)], notCoveredByKnowledge: [] },
      [],
      categories,
    );
    // (8*5 + 2*1) / 6 = 7
    expect(mixed.overallScore).toBe(7);
  });

  it("slugify robi bezpieczne ID z polskich nazw", () => {
    expect(slugify("Linia żuchwy & Broda")).toBe("linia_zuchwy_broda");
    expect(slugify("Łuk brwiowy")).toBe("luk_brwiowy");
    expect(slugify("!!!")).toBe("kategoria");
  });
});

describe("normalizeDb", () => {
  it("migruje bazę ze starszej wersji (bez kategorii i danych plików)", () => {
    const db = normalizeDb({
      entries: [entry("K001", "eyes"), entry("K002", "moja_kategoria")],
      sources: [{ id: "S1", filename: "a.txt", kind: "text", uploadedAt: "", entryCount: 1, notes: "" }] as never,
      nextEntryNumber: 3,
      pendingConsolidation: { old: true },
    } as never);
    expect(db.categories.map((c) => c.id).sort()).toEqual(["eyes", "moja_kategoria"]);
    expect(db.categories.find((c) => c.id === "eyes")?.name).toBe("Oczy");
    expect(db.sources[0].storedAs).toBe("");
    expect(db.framework).toBeNull();
    expect("pendingConsolidation" in db).toBe(false);
  });
});

describe("detectKind", () => {
  it("rozpoznaje formaty materiałów", () => {
    expect(detectKind("notatki.TXT", "")?.kind).toBe("text");
    expect(detectKind("poradnik.docx", "application/octet-stream")?.kind).toBe("text");
    expect(detectKind("skan.pdf", "")?.kind).toBe("pdf");
    expect(detectKind("zdjecie.JPG", "")).toEqual({ kind: "image", mediaType: "image/jpeg" });
    expect(detectKind("film.mp4", "video/mp4")).toBeNull();
  });
});
