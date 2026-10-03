import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeTruncatedError, countTokens, structuredCall } from "./claude";
import { UserError } from "./http";
import { allSourceBlocks, detectKind, sourceBlocks } from "./materials";
import { METRIC_INFO, METRIC_KEYS } from "./metrics";
import { SynthesisSchema, slugify, type Category, type KnowledgeEntry, type KnowledgeSource, type Synthesis, type SynthesisProposal } from "./schema";
import { backupDb, deleteSourceFile, newEntry, newId, readDb, saveSourceFile, updateDb } from "./store";

type Block = Anthropic.Beta.BetaContentBlockParam;

/** Do tylu tokenów wszystkie materiały są analizowane w jednym zapytaniu (model ma 1M kontekstu). */
const FULL_MODE_LIMIT = 650_000;
const BATCH_LIMIT = 300_000;

const METRIC_GUIDE = METRIC_KEYS.map((k) => `- ${k}: ${METRIC_INFO[k].label} - ${METRIC_INFO[k].description}`).join("\n");

const SYNTHESIS_SYSTEM = `Budujesz system oceny wyglądu twarzy WYŁĄCZNIE na podstawie materiałów autora aplikacji. Aplikacja będzie potem oceniać zdjęcia twarzy użytkowników tylko według tego, co tu zapiszesz - więc wszystko, czego nie przeniesiesz, przepadnie, a wszystko, co dodasz od siebie, zafałszuje wiedzę autora.

Jak pracujesz:
1. Przeczytaj KAŻDY materiał w całości: tekst, PDF-y, zdjęcia notatek, zrzuty ekranu, tabele, schematy, grafiki z oznaczeniami. Z obrazów odczytaj cały tekst i znaczenie oznaczeń.
2. Odtwórz system oceny autora:
   - framework.summary: jak autor ocenia wygląd, co uważa za najważniejsze, jego terminologia i założenia.
   - framework.scoringNotes: jak autor przekłada cechy na ocenę (skale, progi, co obniża/podnosi wynik).
   - categories: kategorie oceny tak, jak dzieli je autor (jego nazwy i podział). Jeśli autor nie dzieli wiedzy na kategorie, pogrupuj ją logicznie wg cech twarzy. Waga 1-5 wg tego, jak ważna jest kategoria w materiałach.
3. entries: wszystkie zasady, kryteria oceny i zalecenia - każda konkretna cecha lub zasada osobno. area = id kategorii.
   - content: pełna treść wg materiałów - zachowaj liczby, progi, wyjątki, warunki, terminologię autora. Lepiej za dużo szczegółów niż za mało.
   - assessmentCriteria: po czym na zdjęciu twarzy rozpoznać, czy cecha wypada dobrze czy źle - tylko wg materiałów.
   - metric + ranges: gdy materiały podają progi liczbowe dla cechy, którą aplikacja mierzy automatycznie (lista niżej) - przenieś je dokładnie. Przedziały rozłączne, min włącznie, max wyłącznie. Jeśli materiał nie podaje oceny liczbowej przedziału, ustal ją z werdyktu (ideal 9-10, good 7-8, average 5-6, weak 1-4). Inaczej metric = null, ranges = [].
   - recommendations: każde zalecenie osobno, konkretnie, w brzmieniu bliskim materiałom.
   - priority 1-5: jak ważna jest cecha wg materiałów (3, jeśli nie wynika).
   - sourceFiles: dokładne nazwy plików, z których pochodzi wpis.
   - Ta sama zasada w kilku materiałach = jeden wpis z połączonymi szczegółami i wszystkimi plikami w sourceFiles.
4. Ręczne wpisy autora (<reczne_wpisy_autora>) to jego poprawki - mają pierwszeństwo przed materiałami. Uwzględnij je (podając ich ID w fromManual) albo pomiń, a wtedy zostaną zachowane bez zmian.
5. Nie dodawaj NICZEGO spoza materiałów: żadnych ogólnie przyjętych kanonów, własnej wiedzy ani zaleceń. Nie poprawiaj autora. Sprzeczności zapisz w contradictions (z nazwami plików) i w treści wpisu - nie rozstrzygaj ich.
6. gaps: czego brakuje, żeby rzetelnie oceniać twarz wg tych materiałów (np. cecha bez kryteriów, brak progów liczbowych, brak zaleceń).
7. Pisz po polsku, ale zachowuj terminy autora (np. angielskie nazwy z looksmaxingu).

Pomiary liczone automatycznie przez aplikację ze zdjęcia (metric):
${METRIC_GUIDE}`;

const MERGE_SYSTEM = `${SYNTHESIS_SYSTEM}

UWAGA: materiałów było za dużo na jedno zapytanie, więc przeczytano je w częściach. Dostajesz wyniki analizy każdej części (<czesc>). Złóż z nich jeden spójny system oceny: połącz kategorie i duplikaty wpisów, zachowując wszystkie szczegóły, progi, zalecenia i nazwy plików źródłowych.`;

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

export async function addSource(file: { name: string; type: string; data: Buffer }) {
  const detected = detectKind(file.name, file.type);
  if (!detected) {
    throw new UserError(`Nieobsługiwany format pliku: ${file.name}. Obsługiwane: tekst (.txt, .md, .csv…), Word (.docx), PDF i obrazy (.jpg, .png, .webp).`);
  }
  if (detected.kind === "image" && file.data.length > 5 * 1024 * 1024) {
    throw new UserError(`Obraz ${file.name} jest większy niż 5 MB - zmniejsz go.`);
  }
  const id = newId("S");
  const storedAs = await saveSourceFile(id, file.name, file.data);
  const source: KnowledgeSource = {
    id,
    filename: file.name,
    kind: detected.kind,
    mediaType: detected.mediaType,
    storedAs,
    size: file.data.length,
    uploadedAt: new Date().toISOString(),
    entryCount: 0,
    notes: "",
  };
  // Sprawdzenie, czy plik da się odczytać (np. uszkodzony .docx), zanim trafi do bazy.
  try {
    await sourceBlocks(source);
  } catch {
    await deleteSourceFile(storedAs);
    throw new UserError(`Nie udało się odczytać pliku ${file.name}.`);
  }
  await updateDb((db) => {
    db.sources.push(source);
  });
  return source;
}

export async function deleteSource(sourceId: string) {
  await backupDb("przed-usunieciem-materialu");
  return updateDb(async (db) => {
    const source = db.sources.find((s) => s.id === sourceId);
    if (!source) throw new UserError("Nie ma takiego materiału.", 404);
    const before = db.entries.length;
    db.entries = db.entries.flatMap((e) => {
      if (!e.sourceIds.includes(sourceId)) return [e];
      const rest = e.sourceIds.filter((s) => s !== sourceId);
      // Wpis znika tylko wtedy, gdy ten materiał był jego jedynym źródłem (ręczne poprawki zostają).
      return rest.length > 0 || e.manual ? [{ ...e, sourceIds: rest }] : [];
    });
    db.sources = db.sources.filter((s) => s.id !== sourceId);
    await deleteSourceFile(source.storedAs);
    return { removedEntries: before - db.entries.length };
  });
}

// --- Analiza wszystkich materiałów ---

function stripEntry(e: KnowledgeEntry) {
  return {
    id: e.id,
    area: e.area,
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
  const db = await readDb();
  const sources = db.sources;
  const manual = manualEntriesBlock(db.entries);
  const onText = (chunk: string) => {
    job.outputChars += chunk.length;
  };

  job.stage = "Liczenie rozmiaru materiałów…";
  const blocks = await allSourceBlocks(sources);
  let total: number | null = null;
  try {
    total = await countTokens(SYNTHESIS_SYSTEM, [...blocks, ...manual]);
  } catch (err) {
    console.warn("count_tokens nie powiodło się", err);
  }

  let synthesis: Synthesis;
  let mode: SynthesisProposal["mode"] = "full";
  try {
    if (total != null && total > FULL_MODE_LIMIT) throw new ClaudeTruncatedError("Za dużo materiałów na jedno zapytanie");
    job.stage = `Czytanie i analiza wszystkich materiałów naraz${total ? ` (${Math.round(total / 1000)} tys. tokenów)` : ""}…`;
    synthesis = await structuredCall({
      schema: SynthesisSchema,
      system: [{ type: "text", text: SYNTHESIS_SYSTEM }],
      content: [...blocks, ...manual, { type: "text", text: `Przeanalizuj wszystkie materiały (${sources.length}) i zbuduj z nich kompletny system oceny.` }],
      effort: "high",
      maxTokens: 128000,
      onText,
    });
  } catch (err) {
    if (!(err instanceof ClaudeTruncatedError)) throw err;
    mode = "batched";
    job.outputChars = 0;
    synthesis = await batchedSynthesis(job, sources, manual, onText);
  }

  job.stage = "Zapisywanie propozycji…";
  await updateDb((d) => {
    d.pendingSynthesis = {
      createdAt: new Date().toISOString(),
      mode,
      materialTokens: total,
      basedOn: d.entries.map((e) => e.id),
      sourceIds: sources.map((s) => s.id),
      synthesis,
    };
  });
  job.status = "done";
  job.stage = "Gotowe";
}

/** Dla bardzo dużych zbiorów: analiza w częściach, potem złożenie wyników w jeden system. */
async function batchedSynthesis(job: JobState, sources: KnowledgeSource[], manual: Block[], onText: (c: string) => void) {
  job.stage = "Materiałów jest dużo - dzielenie na części…";
  const sized: { name: string; blocks: Block[]; tokens: number }[] = [];
  for (const s of sources) {
    const blocks = await sourceBlocks(s);
    let tokens: number;
    try {
      tokens = await countTokens("", blocks);
    } catch {
      tokens = Math.ceil(s.size / 3);
    }
    sized.push({ name: s.filename, blocks, tokens });
  }
  const batches: { blocks: Block[]; names: string[]; tokens: number }[] = [];
  let current = { blocks: [] as Block[], names: [] as string[], tokens: 0 };
  for (const item of sized) {
    if (current.tokens + item.tokens > BATCH_LIMIT && current.blocks.length) {
      batches.push(current);
      current = { blocks: [], names: [], tokens: 0 };
    }
    current.blocks.push(...item.blocks);
    current.names.push(item.name);
    current.tokens += item.tokens;
  }
  if (current.blocks.length) batches.push(current);

  const parts: Synthesis[] = [];
  for (const [i, batch] of batches.entries()) {
    job.stage = `Analiza części ${i + 1}/${batches.length} (${batch.names.length} plików)…`;
    parts.push(
      await structuredCall({
        schema: SynthesisSchema,
        system: [{ type: "text", text: SYNTHESIS_SYSTEM }],
        content: [...batch.blocks, { type: "text", text: `To część ${i + 1}/${batches.length} materiałów. Przeanalizuj je dokładnie.` }],
        effort: "high",
        maxTokens: 128000,
        onText,
      }),
    );
  }
  job.stage = "Składanie wyników wszystkich części w jeden system…";
  return structuredCall({
    schema: SynthesisSchema,
    system: [{ type: "text", text: MERGE_SYSTEM }],
    content: [
      ...parts.map((p, i): Block => ({ type: "text", text: `<czesc nr="${i + 1}">\n${JSON.stringify(p)}\n</czesc>` })),
      ...manual,
      { type: "text", text: "Złóż jeden kompletny system oceny." },
    ],
    effort: "high",
    maxTokens: 128000,
    onText,
  });
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

    const byName = new Map(db.sources.map((s) => [s.filename, s.id]));
    const manualUsed = new Set(syn.entries.flatMap((e) => e.fromManual));
    const created = syn.entries.map(({ sourceFiles, fromManual, ...draft }) => {
      const sourceIds = [...new Set(sourceFiles.map((f) => byName.get(f)).filter((x): x is string => Boolean(x)))];
      return newEntry(db, { ...draft, area: ensureCategory(draft.area) }, sourceIds, fromManual.length > 0);
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
      s.notes = syn.unreadable.filter((u) => u.includes(s.filename)).join("; ");
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
