import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTree, detectKind, isJunkFile, sanitizePath, treeText } from "@/lib/file-types";

// Osobny katalog danych na czas testów (store czyta DATA_DIR przy imporcie).
const dataDir = mkdtempSync(path.join(tmpdir(), "looksmax-test-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

let knowledge: typeof import("@/lib/knowledge");
let store: typeof import("@/lib/store");
beforeAll(async () => {
  knowledge = await import("@/lib/knowledge");
  store = await import("@/lib/store");
});

describe("ścieżki i formaty", () => {
  it("sanitizePath nie pozwala wyjść poza folder i czyści ścieżkę", () => {
    expect(sanitizePath("../../etc/passwd")).toBe("etc/passwd");
    expect(sanitizePath("/Looksmax\\Oczy\\canthal.txt")).toBe("Looksmax/Oczy/canthal.txt");
    expect(sanitizePath("A/./B//c.txt")).toBe("A/B/c.txt");
    expect(sanitizePath("a\u0000b/c\u001f.txt")).toBe("ab/c.txt");
    expect(sanitizePath("")).toBe("plik");
  });

  it("pomija pliki systemowe", () => {
    expect(isJunkFile("Wiedza/.DS_Store")).toBe(true);
    expect(isJunkFile("Wiedza/Thumbs.db")).toBe(true);
    expect(isJunkFile("__MACOSX/Wiedza/._a.jpg")).toBe(true);
    expect(isJunkFile("Wiedza/~$notatki.docx")).toBe(true);
    expect(isJunkFile("Wiedza/Oczy/canthal.txt")).toBe(false);
  });

  it("rozpoznaje formaty biurowe, HEIC przekonwertowany na JPG i odrzuca nieobsługiwane", () => {
    expect(detectKind("a/slajdy.PPTX")?.kind).toBe("text");
    expect(detectKind("a/tabela.xlsx")?.kind).toBe("text");
    expect(detectKind("a/zdjecie.heic", "image/jpeg")).toEqual({ kind: "image", mediaType: "image/jpeg" });
    expect(detectKind("a/stary.doc")).toBeNull();
  });

  it("buduje drzewo folderów", () => {
    const tree = buildTree([
      { id: "1", path: "Wiedza/Oczy/b.txt" },
      { id: "2", path: "Wiedza/Oczy/a.txt" },
      { id: "3", path: "Wiedza/Żuchwa/x.pdf" },
      { id: "4", path: "luzem.txt" },
    ]);
    expect(tree.files.map((f) => f.name)).toEqual(["luzem.txt"]);
    expect(tree.folders[0].folders.map((f) => f.name)).toEqual(["Oczy", "Żuchwa"]);
    expect(tree.folders[0].folders[0].files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    expect(treeText(tree)).toContain("Wiedza/\n  Oczy/\n    a.txt");
  });
});

describe("materiały w bazie", () => {
  it("rozpoznaje bez zmian, aktualizację i duplikat; usuwa cały folder", async () => {
    const add = (p: string, content: string) => knowledge.addSource({ name: p.split("/").pop()!, path: p, type: "text/plain", data: Buffer.from(content) });
    expect((await add("Wiedza/Oczy/canthal.txt", "v1")).status).toBe("added");
    expect((await add("Wiedza/Oczy/canthal.txt", "v1")).status).toBe("unchanged");
    expect((await add("Wiedza/Oczy/canthal.txt", "v2")).status).toBe("updated");
    const dup = await add("Wiedza/Kopie/canthal-kopia.txt", "v2");
    expect(dup).toMatchObject({ status: "duplicate", duplicateOf: "Wiedza/Oczy/canthal.txt" });
    expect((await add("Wiedza/Żuchwa/jaw.txt", "jaw")).status).toBe("added");
    expect((await add("../../poza.txt", "x")).path).toBe("poza.txt");

    let db = await store.readDb();
    expect(db.sources.map((s) => s.path).sort()).toEqual(["Wiedza/Oczy/canthal.txt", "Wiedza/Żuchwa/jaw.txt", "poza.txt"]);
    const canthal = db.sources.find((s) => s.path === "Wiedza/Oczy/canthal.txt")!;
    expect((await store.readSourceFile(canthal.storedAs))?.toString()).toBe("v2");

    // Wpis z jednego źródła znika razem z folderem; ręczny wpis zostaje.
    await store.updateDb((d) => {
      d.entries.push(store.newEntry(d, { area: "oczy", title: "t", content: "", assessmentCriteria: "", metric: null, ranges: [], recommendations: [], priority: 3 }, [canthal.id]));
      d.entries.push(store.newEntry(d, { area: "oczy", title: "ręczny", content: "", assessmentCriteria: "", metric: null, ranges: [], recommendations: [], priority: 3 }, [canthal.id], true));
    });
    const res = await knowledge.deleteSources({ folder: "Wiedza/Oczy" });
    expect(res).toEqual({ removedFiles: 1, removedEntries: 1 });
    db = await store.readDb();
    expect(db.sources.map((s) => s.path).sort()).toEqual(["Wiedza/Żuchwa/jaw.txt", "poza.txt"]);
    expect(db.entries.map((e) => e.title)).toEqual(["ręczny"]);
    // Prefiks "Wiedza/Ż" nie może usunąć folderu "Wiedza/Żuchwa" (tylko całe foldery).
    await expect(knowledge.deleteSources({ folder: "Wiedza/Ż" })).rejects.toThrow();
  });

  it("zatwierdzenie analizy łączy wpisy z plikami po ścieżkach i zapisuje temat", async () => {
    const db0 = await store.readDb();
    const jaw = db0.sources.find((s) => s.path === "Wiedza/Żuchwa/jaw.txt")!;
    await store.updateDb((d) => {
      d.pendingSynthesis = {
        createdAt: "",
        mode: "full",
        materialTokens: 100,
        basedOn: d.entries.map((e) => e.id),
        sourceIds: d.sources.map((s) => s.id),
        synthesis: {
          framework: { summary: "s", scoringNotes: "" },
          categories: [{ id: "Żuchwa", name: "Żuchwa", description: "", weight: 4 }],
          entries: [
            {
              area: "Żuchwa",
              topic: "Żuchwa › Szerokość",
              title: "Szeroka żuchwa",
              content: "",
              assessmentCriteria: "",
              metric: null,
              ranges: [],
              recommendations: [],
              priority: 5,
              sourceFiles: ["Wiedza/Żuchwa/jaw.txt", "nie-istnieje.txt"],
              fromManual: [],
            },
          ],
          contradictions: [],
          gaps: [],
          unreadable: [],
        },
      };
    });
    await knowledge.applySynthesis();
    const db = await store.readDb();
    const entry = db.entries.find((e) => e.title === "Szeroka żuchwa")!;
    expect(entry.sourceIds).toEqual([jaw.id]);
    expect(entry.topic).toBe("Żuchwa › Szerokość");
    expect(entry.area).toBe("zuchwa");
    expect(db.categories.map((c) => c.name)).toContain("Żuchwa");
    // Ręczny wpis (nieuwzględniony przez model) został zachowany.
    expect(db.entries.some((e) => e.title === "ręczny")).toBe(true);
  });
});

describe("packBatches", () => {
  const item = (p: string, tokens: number, images = 0, pages = 0) => ({ source: { path: p }, tokens, images, pages });

  it("trzyma się limitów tokenów, obrazów i stron", () => {
    const items = [item("A/1", 60), item("A/2", 60), item("A/3", 60), item("B/1", 10, 3), item("B/2", 10, 3), item("C/1", 10, 0, 7)];
    const batches = knowledge.packBatches(items, { tokens: 130, images: 4, pdfPages: 6 });
    for (const b of batches) {
      expect(b.reduce((s, i) => s + i.tokens, 0) <= 130 || b.length === 1).toBe(true);
      expect(b.reduce((s, i) => s + i.images, 0) <= 4 || b.length === 1).toBe(true);
    }
    expect(batches.flat()).toHaveLength(items.length);
  });

  it("zaczyna nową część na granicy folderu, gdy bieżąca jest już w połowie pełna", () => {
    const items = [item("Wiedza/Oczy/1", 60), item("Wiedza/Oczy/2", 10), item("Wiedza/Nos/1", 10), item("Wiedza/Nos/2", 10)];
    const batches = knowledge.packBatches(items, { tokens: 100, images: 100, pdfPages: 100 });
    expect(batches.map((b) => b.map((i) => i.source.path))).toEqual([
      ["Wiedza/Oczy/1", "Wiedza/Oczy/2"],
      ["Wiedza/Nos/1", "Wiedza/Nos/2"],
    ]);
  });
});

describe("równoległe wgrywanie", () => {
  it("wykrywa duplikat treści także przy jednoczesnym wgrywaniu", async () => {
    const add = (p: string) => knowledge.addSource({ name: p.split("/").pop()!, path: p, type: "text/plain", data: Buffer.from("ta sama treść równolegle") });
    const results = await Promise.all([add("R/a.txt"), add("R/b.txt"), add("R/c.txt")]);
    expect(results.filter((r) => r.status === "added")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(2);
    const db = await store.readDb();
    expect(db.sources.filter((s) => s.path.startsWith("R/"))).toHaveLength(1);
  });
});
