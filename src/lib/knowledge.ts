import "server-only";
import { createHash } from "crypto";
import type Anthropic from "@anthropic-ai/sdk";
import {
  ClaudeTruncatedError,
  countTokens,
  deleteFromFilesApi,
  isMissingFileError,
  isRequestLimitError,
  structuredCall,
  uploadToFilesApi,
} from "./claude";
import { basename, detectKind, sanitizePath } from "./file-types";
import { UserError } from "./http";
import { estimatePdfPages, estimateTokens, extractText, folderStructureBlock, sourceBlocks } from "./materials";
import { METRIC_INFO, METRIC_KEYS } from "./metrics";
import { SynthesisSchema, slugify, type Category, type KnowledgeEntry, type KnowledgeSource, type Synthesis, type SynthesisProposal } from "./schema";
import { backupDb, deleteSourceFile, newEntry, newId, readDb, readSourceFile, saveSourceFile, updateDb } from "./store";

type Block = Anthropic.Beta.BetaContentBlockParam;

/** Limity jednego zapytania (model ma 1M kontekstu; API: maks. 600 obrazów i 600 stron PDF na zapytanie). */
const FULL_LIMITS = { tokens: 650_000, images: 500, pdfPages: 500 };
const BATCH_LIMITS = { tokens: 300_000, images: 250, pdfPages: 250 };

const METRIC_GUIDE = METRIC_KEYS.map((k) => `- ${k}: ${METRIC_INFO[k].label} - ${METRIC_INFO[k].description}`).join("\n");

const SYNTHESIS_SYSTEM = `Budujesz system oceny wyglądu twarzy WYŁĄCZNIE na podstawie materiałów autora aplikacji. Aplikacja będzie potem oceniać zdjęcia twarzy użytkowników tylko według tego, co tu zapiszesz - więc wszystko, czego nie przeniesiesz, przepadnie, a wszystko, co dodasz od siebie, zafałszuje wiedzę autora.

Jak pracujesz:
1. Przeczytaj KAŻDY materiał w całości: tekst, PDF-y, zdjęcia notatek, zrzuty ekranu, tabele, schematy, grafiki z oznaczeniami, slajdy, arkusze. Z obrazów odczytaj cały tekst i znaczenie oznaczeń.
2. Struktura folderów (<struktura_folderow_autora>) to sposób, w jaki autor sam uporządkował wiedzę - traktuj ją jako część wiedzy:
   - foldery to tematy autora: kategorie oceny wyprowadź z folderów (zwykle z folderów pierwszego poziomu; jeśli wszystko leży w jednym folderze głównym - z jego podfolderów), zachowując nazwy autora,
   - podfoldery to podtematy: zapisz je w topic wpisu (np. "Oczy › Canthal tilt"),
   - nazwy folderów i plików często same niosą informację (np. "dobre przykłady", "do unikania", "progi") - wykorzystaj ją,
   - jeśli materiał nie pasuje do struktury lub folderów nie ma, pogrupuj logicznie wg cech twarzy.
3. Odtwórz system oceny autora:
   - framework.summary: jak autor ocenia wygląd, co uważa za najważniejsze, jego terminologia i założenia.
   - framework.scoringNotes: jak autor przekłada cechy na ocenę (skale, progi, co obniża/podnosi wynik).
   - categories: kategorie oceny autora z wagą 1-5 wg tego, jak ważna jest kategoria w materiałach.
4. entries: wszystkie zasady, kryteria oceny i zalecenia - każda konkretna cecha lub zasada osobno. area = id kategorii.
   - content: pełna treść wg materiałów - zachowaj liczby, progi, wyjątki, warunki, terminologię autora. Lepiej za dużo szczegółów niż za mało.
   - assessmentCriteria: po czym na zdjęciu twarzy rozpoznać, czy cecha wypada dobrze czy źle - tylko wg materiałów. Jeśli materiały zawierają zdjęcia przykładów (dobrych/złych), opisz słowami, co na nich widać, żeby dało się to porównać ze zdjęciem użytkownika.
   - metric + ranges: gdy materiały podają progi liczbowe dla cechy, którą aplikacja mierzy automatycznie (lista niżej) - przenieś je dokładnie. Przedziały rozłączne, min włącznie, max wyłącznie. Jeśli materiał nie podaje oceny liczbowej przedziału, ustal ją z werdyktu (ideal 9-10, good 7-8, average 5-6, weak 1-4). Inaczej metric = null, ranges = [].
   - recommendations: każde zalecenie osobno, konkretnie, w brzmieniu bliskim materiałom.
   - priority 1-5: jak ważna jest cecha wg materiałów (3, jeśli nie wynika).
   - sourceFiles: dokładne pełne ścieżki plików (z folderami), z których pochodzi wpis.
   - Ta sama zasada w kilku materiałach = jeden wpis z połączonymi szczegółami i wszystkimi plikami w sourceFiles.
5. Ręczne wpisy autora (<reczne_wpisy_autora>) to jego poprawki - mają pierwszeństwo przed materiałami. Uwzględnij je (podając ich ID w fromManual) albo pomiń, a wtedy zostaną zachowane bez zmian.
6. Nie dodawaj NICZEGO spoza materiałów: żadnych ogólnie przyjętych kanonów, własnej wiedzy ani zaleceń. Nie poprawiaj autora. Sprzeczności zapisz w contradictions (ze ścieżkami plików) i w treści wpisu - nie rozstrzygaj ich.
7. gaps: czego brakuje, żeby rzetelnie oceniać twarz wg tych materiałów (np. cecha bez kryteriów, brak progów liczbowych, brak zaleceń). unreadable: pliki lub fragmenty nieczytelne - ze ścieżkami.
8. Pisz po polsku, ale zachowuj terminy autora (np. angielskie nazwy z looksmaxingu).

Pomiary liczone automatycznie przez aplikację ze zdjęcia (metric):
${METRIC_GUIDE}`;

const MERGE_SYSTEM = `${SYNTHESIS_SYSTEM}

UWAGA: materiałów było za dużo na jedno zapytanie, więc przeczytano je w częściach (zwykle folder po folderze). Dostajesz wyniki analizy każdej części (<czesc>) i pełną strukturę folderów. Złóż z nich jeden spójny system oceny: ujednolić kategorie (wg struktury folderów), połącz duplikaty wpisów, zachowując wszystkie szczegóły, progi, zalecenia, tematy i ścieżki plików źródłowych.`;

// --- Stan zadania w tle (analiza może trwać kilka-kilkanaście minut) ---

export type JobState = {
  kind: "synthesis";
  status: "running" | "done" | "error";
  startedAt: string;
  stage: string;
  outputChars: number;
  error?: string;
};

const g = globalThis as unknown as { __knowledgeJob?: JobState | null };
export const currentJob = () => g.__knowledgeJob ?? null;

// --- Materiały ---

export type AddResult = { status: "added" | "updated" | "unchanged" | "duplicate"; path: string; duplicateOf?: string; source?: KnowledgeSource };

/**
 * Zapisuje materiał pod jego ścieżką (z folderami).
 * Ta sama ścieżka i treść = bez zmian; ta sama ścieżka, inna treść = aktualizacja;
 * identyczna treść pod inną ścieżką = duplikat (pomijany, żeby nie płacić dwa razy za to samo).
 */
export async function addSource(file: { name: string; path?: string; type: string; data: Buffer; width?: number; height?: number }): Promise<AddResult> {
  const path = sanitizePath(file.path || file.name);
  const detected = detectKind(path, file.type);
  if (!detected) throw new UserError(`Nieobsługiwany format pliku: ${path}.`);
  if (detected.kind === "image" && file.data.length > 7 * 1024 * 1024) throw new UserError(`Obraz ${path} jest większy niż 7 MB - zmniejsz go.`);
  if (file.data.length === 0) throw new UserError(`Plik ${path} jest pusty.`);

  const hash = createHash("sha256").update(file.data).digest("hex");
  // Szybka ścieżka (bez zapisu pliku) - właściwa decyzja zapada niżej, pod blokadą bazy.
  const before = await readDb();
  if (before.sources.find((s) => s.path === path)?.hash === hash) return { status: "unchanged", path };

  // Sprawdzenie, czy plik da się odczytać (np. uszkodzony .docx), zanim trafi do bazy.
  if (detected.kind === "text") {
    try {
      await extractText({ mediaType: detected.mediaType, path }, file.data);
    } catch {
      throw new UserError(`Nie udało się odczytać pliku ${path} (uszkodzony lub zabezpieczony?).`);
    }
  }

  const id = newId("S");
  const storedAs = await saveSourceFile(id, path, file.data);
  const source: KnowledgeSource = {
    id,
    path,
    filename: basename(path),
    kind: detected.kind,
    mediaType: detected.mediaType,
    storedAs,
    size: file.data.length,
    hash,
    ...(detected.kind === "image" && file.width && file.height ? { width: file.width, height: file.height } : {}),
    ...(detected.kind === "pdf" ? { pages: estimatePdfPages(file.data) } : {}),
    fileId: null,
    uploadedAt: new Date().toISOString(),
    entryCount: 0,
    notes: "",
  };

  // Decyzja pod blokadą bazy - równoległe wgrywanie wielu plików nie może ominąć wykrywania duplikatów.
  const decision = await updateDb((db): { result: AddResult; cleanup: { storedAs?: string; fileId?: string | null } } => {
    const existing = db.sources.find((s) => s.path === path);
    if (existing?.hash === hash) return { result: { status: "unchanged", path }, cleanup: { storedAs } };
    const sameContent = db.sources.find((s) => s.hash === hash && s.path !== path);
    if (sameContent && !existing) return { result: { status: "duplicate", path, duplicateOf: sameContent.path }, cleanup: { storedAs } };
    if (existing) {
      // Nowa wersja pliku pod tą samą ścieżką: zachowujemy ID materiału (wpisy dalej na niego wskazują).
      const old = { storedAs: existing.storedAs, fileId: existing.fileId };
      Object.assign(existing, { ...source, id: existing.id, entryCount: existing.entryCount });
      return { result: { status: "updated", path, source: existing }, cleanup: old };
    }
    db.sources.push(source);
    return { result: { status: "added", path, source }, cleanup: {} };
  });
  if (decision.cleanup.storedAs) await deleteSourceFile(decision.cleanup.storedAs);
  if (decision.cleanup.fileId) await deleteFromFilesApi(decision.cleanup.fileId);
  return decision.result;
}

/** Usuwa materiał (po ID) albo cały folder (po prefiksie ścieżki) i wpisy, które pochodziły tylko z nich. */
export async function deleteSources(target: { id?: string; folder?: string }) {
  await backupDb("przed-usunieciem-materialow");
  const folder = target.folder ? sanitizePath(target.folder) : null;
  const removed = await updateDb((db) => {
    const toRemove = db.sources.filter((s) => (target.id ? s.id === target.id : folder ? s.path === folder || s.path.startsWith(`${folder}/`) : false));
    if (toRemove.length === 0) throw new UserError("Nie znaleziono materiałów do usunięcia.", 404);
    const ids = new Set(toRemove.map((s) => s.id));
    const before = db.entries.length;
    db.entries = db.entries.flatMap((e) => {
      if (!e.sourceIds.some((id) => ids.has(id))) return [e];
      const rest = e.sourceIds.filter((id) => !ids.has(id));
      // Wpis znika tylko wtedy, gdy usuwane materiały były jego jedynymi źródłami (ręczne poprawki zostają).
      return rest.length > 0 || e.manual ? [{ ...e, sourceIds: rest }] : [];
    });
    db.sources = db.sources.filter((s) => !ids.has(s.id));
    return { files: toRemove, removedEntries: before - db.entries.length };
  });
  for (const s of removed.files) {
    await deleteSourceFile(s.storedAs);
    if (s.fileId) await deleteFromFilesApi(s.fileId);
  }
  return { removedFiles: removed.files.length, removedEntries: removed.removedEntries };
}

/** Wgrywa obrazy i PDF-y do Files API (raz na plik) - zapytania zostają małe mimo setek plików. */
async function ensureFileIds(job: JobState | null, force = false) {
  const db = await readDb();
  const pending = db.sources.filter((s) => s.kind !== "text" && (force || !s.fileId));
  let done = 0;
  const ids = new Map<string, string>();
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const s = pending[next++];
      const data = await readSourceFile(s.storedAs);
      if (!data) continue;
      ids.set(s.id, await uploadToFilesApi(data, s.filename, s.mediaType));
      done++;
      if (job) job.stage = `Przygotowanie obrazów i PDF-ów: ${done}/${pending.length}…`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  if (ids.size) {
    await updateDb((d) => {
      for (const s of d.sources) if (ids.has(s.id)) s.fileId = ids.get(s.id)!;
    });
  }
}

/** Gotowe źródła z blokami treści i szacunkiem rozmiaru. */
async function preparedSources() {
  const db = await readDb();
  const sorted = [...db.sources].sort((a, b) => a.path.localeCompare(b.path, "pl"));
  const items = [];
  for (const s of sorted) {
    const blocks = await sourceBlocks(s);
    const textLength = blocks.reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0);
    items.push({ source: s, blocks, tokens: estimateTokens(s, textLength), images: s.kind === "image" ? 1 : 0, pages: s.kind === "pdf" ? (s.pages ?? 1) : 0 });
  }
  return { db, items };
}

type Item = Awaited<ReturnType<typeof preparedSources>>["items"][number];
type Limits = typeof FULL_LIMITS;

/** Dzieli materiały na części mieszczące się w limitach - folder po folderze, w kolejności ścieżek. */
export function packBatches<T extends { tokens: number; images: number; pages: number; source: { path: string } }>(items: T[], limits: Limits): T[][] {
  const topFolder = (p: string) => (p.includes("/") ? p.split("/").slice(0, 2).join("/") : "");
  const batches: T[][] = [];
  let current: T[] = [];
  let sum = { tokens: 0, images: 0, pages: 0 };
  const fits = (i: T) => sum.tokens + i.tokens <= limits.tokens && sum.images + i.images <= limits.images && sum.pages + i.pages <= limits.pdfPages;
  for (const [idx, item] of items.entries()) {
    const prev = items[idx - 1];
    // Nowa część na granicy folderu, jeśli bieżąca jest już w ponad połowie pełna - foldery zostają razem.
    const folderBoundary = prev && topFolder(prev.source.path) !== topFolder(item.source.path) && sum.tokens > limits.tokens / 2;
    if (current.length && (!fits(item) || folderBoundary)) {
      batches.push(current);
      current = [];
      sum = { tokens: 0, images: 0, pages: 0 };
    }
    current.push(item);
    sum = { tokens: sum.tokens + item.tokens, images: sum.images + item.images, pages: sum.pages + item.pages };
  }
  if (current.length) batches.push(current);
  return batches;
}

// --- Analiza wszystkich materiałów ---

function stripEntry(e: KnowledgeEntry) {
  return {
    id: e.id,
    area: e.area,
    topic: e.topic ?? "",
    title: e.title,
    content: e.content,
    assessmentCriteria: e.assessmentCriteria,
    metric: e.metric,
    ranges: e.ranges,
    recommendations: e.recommendations,
    priority: e.priority,
  };
}

function manualEntriesBlock(entries: KnowledgeEntry[]): Block[] {
  const manual = entries.filter((e) => e.manual);
  if (manual.length === 0) return [];
  return [{ type: "text", text: `<reczne_wpisy_autora>\n${JSON.stringify(manual.map(stripEntry), null, 1)}\n</reczne_wpisy_autora>` }];
}

/** Uruchamia analizę wszystkich materiałów w tle; postęp jest widoczny w currentJob(). */
export async function startSynthesis() {
  if (currentJob()?.status === "running") throw new UserError("Analiza materiałów już trwa.", 409);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new UserError("Brak klucza API Anthropic - dopisz ANTHROPIC_API_KEY w pliku .env.local i uruchom aplikację ponownie.", 503);
  }
  const db = await readDb();
  if (db.sources.length === 0) throw new UserError("Najpierw wgraj materiały.", 409);
  const job: JobState = { kind: "synthesis", status: "running", startedAt: new Date().toISOString(), stage: "Przygotowanie materiałów…", outputChars: 0 };
  g.__knowledgeJob = job;
  runSynthesis(job).catch((err) => {
    console.error(err);
    job.status = "error";
    job.error = err instanceof Error ? err.message : "Nieznany błąd";
  });
  return job;
}

async function runSynthesis(job: JobState) {
  await ensureFileIds(job);
  try {
    await synthesize(job);
  } catch (err) {
    // Pliki w Files API zniknęły (np. inny klucz API) - wgrywamy je ponownie i próbujemy raz jeszcze.
    if (!isMissingFileError(err)) throw err;
    job.stage = "Ponowne przygotowanie plików…";
    await ensureFileIds(job, true);
    await synthesize(job);
  }
  job.status = "done";
  job.stage = "Gotowe";
}

async function synthesize(job: JobState) {
  const { db, items } = await preparedSources();
  const manual = manualEntriesBlock(db.entries);
  const sources = items.map((i) => i.source);
  const structure = folderStructureBlock(sources);
  const onText = (chunk: string) => {
    job.outputChars += chunk.length;
  };
  const totals = items.reduce((s, i) => ({ tokens: s.tokens + i.tokens, images: s.images + i.images, pages: s.pages + i.pages }), { tokens: 0, images: 0, pages: 0 });

  job.stage = "Liczenie rozmiaru materiałów…";
  const allBlocks = [structure, ...items.flatMap((i) => i.blocks), ...manual];
  let total: number | null = null;
  try {
    total = await countTokens(SYNTHESIS_SYSTEM, allBlocks);
  } catch (err) {
    if (isMissingFileError(err)) throw err;
    console.warn("count_tokens nie powiodło się - używam szacunku", err);
  }
  const tokens = total ?? totals.tokens;

  let synthesis: Synthesis;
  let mode: SynthesisProposal["mode"] = "full";
  const fitsFull = tokens <= FULL_LIMITS.tokens && totals.images <= FULL_LIMITS.images && totals.pages <= FULL_LIMITS.pdfPages;
  try {
    if (!fitsFull) throw new ClaudeTruncatedError("Za dużo materiałów na jedno zapytanie");
    job.stage = `Czytanie i analiza wszystkich materiałów naraz (${sources.length} plików, ~${Math.round(tokens / 1000)} tys. tokenów)…`;
    synthesis = await structuredCall({
      schema: SynthesisSchema,
      system: [{ type: "text", text: SYNTHESIS_SYSTEM }],
      content: [...allBlocks, { type: "text", text: `Przeanalizuj wszystkie materiały (${sources.length} plików) i zbuduj z nich kompletny system oceny.` }],
      effort: "high",
      maxTokens: 128000,
      onText,
    });
  } catch (err) {
    // Za duże na jedno zapytanie (wg szacunku albo wg odpowiedzi API) - czytamy w częściach.
    if (!(err instanceof ClaudeTruncatedError) && !isRequestLimitError(err)) throw err;
    mode = "batched";
    job.outputChars = 0;
    synthesis = await batchedSynthesis(job, items, structure, manual, onText);
  }

  job.stage = "Zapisywanie propozycji…";
  await updateDb((d) => {
    d.pendingSynthesis = {
      createdAt: new Date().toISOString(),
      mode,
      materialTokens: tokens,
      basedOn: d.entries.map((e) => e.id),
      sourceIds: sources.map((s) => s.id),
      synthesis,
    };
  });
}

/** Dla bardzo dużych zbiorów: analiza w częściach (folder po folderze), potem złożenie wyników w jeden system. */
async function batchedSynthesis(job: JobState, items: Item[], structure: Block, manual: Block[], onText: (c: string) => void): Promise<Synthesis> {
  let limits: Limits = BATCH_LIMITS;
  for (let attempt = 0; attempt < 3; attempt++) {
    const batches = packBatches(items, limits);
    try {
      const parts: Synthesis[] = [];
      for (const [i, batch] of batches.entries()) {
        const folders = [...new Set(batch.map((b) => b.source.path.split("/").slice(0, -1).join("/") || "(główny folder)"))];
        job.stage = `Analiza części ${i + 1}/${batches.length}: ${batch.length} plików (${folders.slice(0, 3).join(", ")}${folders.length > 3 ? "…" : ""})`;
        parts.push(
          await structuredCall({
            schema: SynthesisSchema,
            system: [{ type: "text", text: SYNTHESIS_SYSTEM }],
            content: [
              structure,
              ...batch.flatMap((b) => b.blocks),
              { type: "text", text: `To część ${i + 1}/${batches.length} materiałów (pełna struktura folderów jest wyżej). Przeanalizuj dokładnie pliki z tej części.` },
            ],
            effort: "high",
            maxTokens: 128000,
            onText,
          }),
        );
      }
      if (parts.length === 1) return parts[0];
      job.stage = `Składanie wyników ${parts.length} części w jeden system…`;
      return await structuredCall({
        schema: SynthesisSchema,
        system: [{ type: "text", text: MERGE_SYSTEM }],
        content: [
          structure,
          ...parts.map((p, i): Block => ({ type: "text", text: `<czesc nr="${i + 1}">\n${JSON.stringify(p)}\n</czesc>` })),
          ...manual,
          { type: "text", text: "Złóż jeden kompletny system oceny." },
        ],
        effort: "high",
        maxTokens: 128000,
        onText,
      });
    } catch (err) {
      // Część nadal za duża (szacunek był za niski albo za dużo treści do zapisania) - mniejsze części.
      if (!(err instanceof ClaudeTruncatedError) && !isRequestLimitError(err)) throw err;
      limits = { tokens: Math.floor(limits.tokens / 2), images: Math.floor(limits.images / 2), pdfPages: Math.floor(limits.pdfPages / 2) };
      job.outputChars = 0;
    }
  }
  throw new Error("Nie udało się przeanalizować materiałów nawet w małych częściach. Sprawdź, czy któryś plik nie jest wyjątkowo duży.");
}

/** Zatwierdza propozycję: zastępuje kategorie, wpisy i opis systemu oceny. */
export async function applySynthesis() {
  await backupDb("przed-analiza-materialow");
  return updateDb((db) => {
    const proposal = db.pendingSynthesis;
    if (!proposal) throw new UserError("Brak propozycji do zatwierdzenia.", 409);
    const syn = proposal.synthesis;

    // Kategorie: unikalne ID, waga 1-5.
    const categories: Category[] = [];
    const idMap = new Map<string, string>();
    for (const c of syn.categories) {
      let id = slugify(c.id || c.name);
      while (categories.some((x) => x.id === id)) id = `${id}_2`;
      idMap.set(c.id, id);
      categories.push({ id, name: c.name.trim() || id, description: c.description, weight: Math.min(5, Math.max(1, Math.round(c.weight) || 3)) });
    }
    const ensureCategory = (raw: string) => {
      const id = idMap.get(raw) ?? slugify(raw);
      if (!categories.some((c) => c.id === id)) {
        const old = db.categories.find((c) => c.id === id);
        categories.push(old ?? { id, name: raw, description: "", weight: 3 });
      }
      return id;
    };

    // Ścieżka → materiał (dokładnie, a gdy model podał samą nazwę pliku - po nazwie, jeśli jest jednoznaczna).
    const byPath = new Map(db.sources.map((s) => [s.path, s.id]));
    const byName = new Map<string, string | null>();
    for (const s of db.sources) byName.set(s.filename, byName.has(s.filename) ? null : s.id);
    const resolve = (f: string) => byPath.get(sanitizePath(f)) ?? byName.get(basename(f)) ?? undefined;

    const manualUsed = new Set(syn.entries.flatMap((e) => e.fromManual));
    const created = syn.entries.map(({ sourceFiles, fromManual, topic, ...draft }) => {
      const sourceIds = [...new Set(sourceFiles.map(resolve).filter((x): x is string => Boolean(x)))];
      const entry = newEntry(db, { ...draft, area: ensureCategory(draft.area) }, sourceIds, fromManual.length > 0);
      return topic?.trim() ? { ...entry, topic: topic.trim() } : entry;
    });

    // Zostają: ręczne wpisy, których model nie uwzględnił, i wpisy dodane po przygotowaniu propozycji.
    const basedOn = new Set(proposal.basedOn);
    const kept = db.entries.filter((e) => (e.manual && !manualUsed.has(e.id)) || !basedOn.has(e.id));
    for (const e of kept) e.area = ensureCategory(e.area);

    const before = db.entries.length;
    db.entries = [...created, ...kept];
    db.categories = categories;
    db.framework = {
      summary: syn.framework.summary,
      scoringNotes: syn.framework.scoringNotes,
      contradictions: syn.contradictions,
      gaps: syn.gaps,
      materialTokens: proposal.materialTokens,
      analyzedAt: new Date().toISOString(),
      sourceIds: proposal.sourceIds,
    };
    for (const s of db.sources) {
      s.entryCount = db.entries.filter((e) => e.sourceIds.includes(s.id)).length;
      s.notes = syn.unreadable.filter((u) => u.includes(s.path) || u.includes(s.filename)).join("; ");
    }
    db.pendingSynthesis = null;
    return { before, after: db.entries.length, categories: categories.length };
  });
}

export async function rejectSynthesis() {
  await updateDb((db) => {
    db.pendingSynthesis = null;
  });
}

/** Do analizy twarzy: upewnia się, że obrazy/PDF-y mają file_id (wywoływane przed dołączeniem pełnych materiałów). */
export async function prepareMaterialsForAnalysis(force = false) {
  await ensureFileIds(null, force);
}
