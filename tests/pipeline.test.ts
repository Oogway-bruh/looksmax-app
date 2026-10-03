import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMissingFileError, isRequestLimitError } from "@/lib/claude";
import { sanitizePath } from "@/lib/file-types";
import { normalizeImage } from "@/lib/images";

const dataDir = mkdtempSync(path.join(tmpdir(), "looksmax-pipe-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

let knowledge: typeof import("@/lib/knowledge");
let store: typeof import("@/lib/store");
beforeAll(async () => {
  knowledge = await import("@/lib/knowledge");
  store = await import("@/lib/store");
});

const png = (w: number, h: number, alpha = 1) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha } } }).png().toBuffer();
const hex = (c: string) => c.repeat(64);

describe("normalizeImage", () => {
  it("każdy kawałek ≤ 2000 px; długi zrzut pocięty, a nie zmniejszony do nieczytelności", async () => {
    const tall = await normalizeImage(await png(1170, 8000));
    expect(tall.parts.length).toBeGreaterThan(3);
    for (const p of tall.parts) expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(2000);
    expect(tall.parts[0].width).toBe(1170);
    const big = await normalizeImage(await sharp({ create: { width: 5000, height: 4000, channels: 3, background: "#888" } }).jpeg().toBuffer());
    expect(big.parts).toHaveLength(1);
    expect(big.parts[0]).toMatchObject({ width: 2000, height: 1600, mediaType: "image/jpeg" });
  });

  it("przezroczystość na białym tle, GIF jako PNG", async () => {
    const r = await normalizeImage(await png(50, 50, 0));
    const { data } = await sharp(r.parts[0].data).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBe(255);
    const gif = await normalizeImage(await sharp({ create: { width: 300, height: 200, channels: 3, background: "#f00" } }).gif().toBuffer());
    expect(gif.parts[0].mediaType).toBe("image/png");
  });

  it("odrzuca pliki, które nie są obrazami", async () => {
    await expect(normalizeImage(Buffer.from("to nie jest obraz"))).rejects.toThrow();
  });
});

describe("ścieżki", () => {
  it("NFC: ten sam folder z macOS (NFD) i Windows daje tę samą ścieżkę", () => {
    expect(sanitizePath("Żuchwa/plik.txt")).toBe(sanitizePath("Żuchwa/plik.txt"));
  });
  it("długie nazwy: zachowane rozszerzenie i brak zlewania się różnych plików", () => {
    const a = sanitizePath(`${"a".repeat(200)}-1.pdf`);
    const b = sanitizePath(`${"a".repeat(200)}-2.pdf`);
    expect(a.endsWith(".pdf")).toBe(true);
    expect(a.length).toBeLessThanOrEqual(150);
    expect(a).not.toBe(b);
  });
});

describe("błędy API", () => {
  const bad = (message: string, status = 400) =>
    status === 400
      ? new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message } }, undefined, new Headers())
      : new Anthropic.NotFoundError(404, { type: "error", error: { type: "not_found_error", message } }, undefined, new Headers());

  it("limit zapytania rozpoznany tylko dla prawdziwych limitów", () => {
    expect(isRequestLimitError(bad("prompt is too long: 1200000 tokens > 1000000 maximum"))).toBe(true);
    expect(isRequestLimitError(bad("Too many images: maximum 600 per request"))).toBe(true);
    expect(isRequestLimitError(bad("max_tokens: 200000 > 128000, which is the maximum allowed"))).toBe(false);
    expect(isRequestLimitError(bad("You have reached your specified API usage limits (spend limit)"))).toBe(false);
    expect(isRequestLimitError(bad("messages.0.content.3.image.source: invalid base64 data"))).toBe(false);
  });

  it("brakujący plik w Files API - bez fałszywych trafień", () => {
    expect(isMissingFileError(bad("File `file_123` not found.", 404))).toBe(true);
    expect(isMissingFileError(bad("messages.0.content.2: file_id file_1 does not exist"))).toBe(true);
    expect(isMissingFileError(bad("prompt is too long"))).toBe(false);
    expect(isMissingFileError(bad("Invalid file type: image/tiff"))).toBe(false);
  });
});

describe("wgrywanie i porządkowanie materiałów", () => {
  it("obraz zapisuje części ≤ 2000 px; PDF zaszyfrowany jest odrzucany, zwykły ma liczbę stron", async () => {
    const res = await knowledge.addSource({ name: "dlugi.png", path: "W/Oczy/dlugi.png", type: "image/png", data: await png(1000, 5000) });
    expect(res.status).toBe("added");
    const db = await store.readDb();
    const src = db.sources.find((s) => s.path === "W/Oczy/dlugi.png")!;
    expect(src.parts!.length).toBeGreaterThan(1);
    for (const p of src.parts!) expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(2000);

    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage();
    doc.addPage();
    const pdf = Buffer.from(await doc.save());
    await knowledge.addSource({ name: "a.pdf", path: "W/Skora/a.pdf", type: "application/pdf", data: pdf });
    expect((await store.readDb()).sources.find((s) => s.path === "W/Skora/a.pdf")?.pages).toBe(3);
    await expect(knowledge.addSource({ name: "x.pdf", path: "W/x.pdf", type: "application/pdf", data: Buffer.from("%PDF-1.4 śmieci") })).rejects.toThrow(/PDF/);
  });

  it("wstępne sprawdzenie: bez zmian, przeniesienie, duplikat w wgraniu; potem uporządkowanie i usunięcie zbędnych", async () => {
    const add = (p: string, content: string, h: string) => knowledge.addSource({ name: p.split("/").pop()!, path: p, type: "text/plain", data: Buffer.from(content), originalHash: hex(h) });
    await add("K/Oczy/tilt.txt", "tilt", "a");
    await add("K/Oczy/stary.txt", "stary", "b");
    await add("K/Nos/nos.txt", "nos", "c");

    const check = await knowledge.checkUploads([
      { path: "K/Oczy/tilt.txt", hash: hex("a") }, // bez zmian
      { path: "K/Nos/Szerokosc/nos.txt", hash: hex("c") }, // przeniesiony
      { path: "K/Nowe/1.txt", hash: hex("d") }, // nowy
      { path: "K/Nowe/2.txt", hash: hex("d") }, // duplikat w tym samym wgraniu
    ]);
    expect(check.unchanged).toEqual(["K/Oczy/tilt.txt"]);
    expect(check.moves).toEqual([{ from: "K/Nos/nos.txt", to: "K/Nos/Szerokosc/nos.txt" }]);
    expect(check.duplicates).toEqual([{ path: "K/Nowe/2.txt", of: "K/Nowe/1.txt" }]);

    const rec = await knowledge.reconcileUpload({
      roots: ["K"],
      uploaded: ["K/Oczy/tilt.txt", "K/Nos/Szerokosc/nos.txt", "K/Nowe/1.txt", "K/Nowe/2.txt"],
      moves: check.moves,
    });
    expect(rec.moved).toBe(1);
    expect(rec.stale.map((s) => s.path)).toEqual(["K/Oczy/stary.txt"]);
    await knowledge.deleteSources({ ids: rec.stale.map((s) => s.id) });
    const paths = (await store.readDb()).sources.map((s) => s.path).filter((p) => p.startsWith("K/")).sort();
    expect(paths).toEqual(["K/Nos/Szerokosc/nos.txt", "K/Oczy/tilt.txt"]);
  });

  it("kopia starej treści pliku, który w tym wgraniu dostaje nową wersję, nie jest duplikatem", async () => {
    await knowledge.addSource({ name: "progi.txt", path: "D/Oczy/progi.txt", type: "text/plain", data: Buffer.from("stare progi"), originalHash: hex("e") });
    const check = await knowledge.checkUploads([
      { path: "D/Oczy/progi.txt", hash: hex("f") }, // nowa wersja
      { path: "D/Skora/kopia.txt", hash: hex("e") }, // kopia starej wersji - musi zostać wysłana
    ]);
    expect(check.duplicates).toEqual([]);
    expect(check.moves).toEqual([]);
    expect(check.unchanged).toEqual([]);
  });

  it("migracja: stare materiały dostają skrót treści, a stare obrazy - części ≤ 2000 px", async () => {
    const big = await png(3000, 1000);
    const storedAs = await store.saveSourceFile("SOLD", "stary.png", big);
    await store.updateDb((d) => {
      d.sources.push({ id: "SOLD", path: "Stare/stary.png", filename: "stary.png", kind: "image", mediaType: "image/png", storedAs, size: big.length, hash: "", uploadedAt: "", entryCount: 0, notes: "" });
    });
    await knowledge.migrateLegacySources();
    const s = (await store.readDb()).sources.find((x) => x.id === "SOLD")!;
    expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.parts![0].width).toBe(2000);
  });
});

describe("zatwierdzanie propozycji po zmianach w materiałach", () => {
  it("pomija wpisy wyłącznie z usuniętych plików i zachowuje ręczne poprawki zrobione po analizie", async () => {
    const add = (p: string) => knowledge.addSource({ name: p.split("/").pop()!, path: p, type: "text/plain", data: Buffer.from(p), originalHash: hex(p.length.toString(16).slice(-1)) });
    await add("Z/a.txt");
    await add("Z/bb.txt");
    let db = await store.readDb();
    const a = db.sources.find((s) => s.path === "Z/a.txt")!;
    const manualId = await store.updateDb((d) => {
      const e = store.newEntry(d, { area: "x", title: "ręczny", content: "v1", assessmentCriteria: "", metric: null, ranges: [], recommendations: [], priority: 3 }, [], true);
      e.updatedAt = "2000-01-01T00:00:00.000Z";
      d.entries.push(e);
      return e.id;
    });
    db = await store.readDb();
    const entry = (title: string, files: string[], fromManual: string[] = []) => ({
      area: "x",
      topic: "",
      title,
      content: "",
      assessmentCriteria: "",
      metric: null,
      ranges: [],
      recommendations: [],
      priority: 3,
      sourceFiles: files,
      fromManual,
    });
    await store.updateDb((d) => {
      d.pendingSynthesis = {
        createdAt: "2001-01-01T00:00:00.000Z",
        mode: "full",
        materialTokens: 1,
        basedOn: d.entries.map((e) => e.id),
        sourceIds: d.sources.map((s) => s.id),
        sources: d.sources.map((s) => ({ id: s.id, path: s.path, hash: s.hash })),
        synthesis: {
          framework: { summary: "", scoringNotes: "" },
          categories: [{ id: "x", name: "X", description: "", weight: 3 }],
          entries: [entry("z usuniętego", ["Z/a.txt"]), entry("z obu", ["Z/a.txt", "Z/bb.txt"]), entry("scalony ręczny", [], [manualId])],
          contradictions: [],
          gaps: [],
          unreadable: [],
        },
      };
    });
    // Po przygotowaniu propozycji: usunięty plik i poprawiony ręczny wpis.
    await knowledge.deleteSources({ id: a.id });
    await store.updateDb((d) => {
      const m = d.entries.find((e) => e.id === manualId)!;
      m.content = "v2 poprawione";
      m.updatedAt = "2002-01-01T00:00:00.000Z";
    });
    expect((await store.readDb()).pendingSynthesis?.stale).toBe(true);
    const res = await knowledge.applySynthesis();
    expect(res.droppedDeleted).toBe(1);
    db = await store.readDb();
    const titles = db.entries.map((e) => e.title);
    expect(titles).not.toContain("z usuniętego");
    expect(titles).toContain("z obu");
    expect(db.entries.find((e) => e.id === manualId)?.content).toBe("v2 poprawione");
    expect(db.framework?.sourceHashes?.[db.sources.find((s) => s.path === "Z/bb.txt")!.id]).toBeTruthy();
  });
});

describe("dzielenie na części", () => {
  const item = (p: string, tokens: number) => ({ source: { path: p }, tokens, images: 0, pages: 0 });
  it("bez wspólnego folderu głównego grupuje po folderach pierwszego poziomu", () => {
    const items = [item("Oczy/a", 40), item("Oczy/b", 40), item("Nos/a", 40), item("Nos/b", 40)];
    const batches = knowledge.packBatches(items, { tokens: 100, images: 10, pdfPages: 10 });
    expect(batches.map((b) => b.map((i) => i.source.path))).toEqual([
      ["Oczy/a", "Oczy/b"],
      ["Nos/a", "Nos/b"],
    ]);
  });
  it("splitInTwo dzieli na granicy folderu blisko środka", () => {
    const [a, b] = knowledge.splitInTwo([item("A/1", 1), item("A/2", 1), item("A/3", 1), item("B/1", 1), item("B/2", 1)]);
    expect(a.map((i) => i.source.path)).toEqual(["A/1", "A/2", "A/3"]);
    expect(b.map((i) => i.source.path)).toEqual(["B/1", "B/2"]);
  });
});
