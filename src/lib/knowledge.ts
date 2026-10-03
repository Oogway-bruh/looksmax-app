import "server-only";
import { createHash } from "crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { countTokens, deleteFromFilesApi, isMissingFileError, isRequestLimitError, structuredCall, uploadToFilesApi } from "./claude";
import { ClaudeTruncatedError, UserError } from "./errors";
import { extractContent } from "./extract";
import { basename, detectKind, sanitizePath } from "./file-types";
import { normalizeImage } from "./images";
import { allItems, folderStructureBlock, type MaterialItem } from "./materials";
import { METRIC_INFO, METRIC_KEYS } from "./metrics";
import {
  DraftEntrySchema,
  SynthesisSchema,
  slugify,
  type Category,
  type KnowledgeEntry,
  type KnowledgeSource,
  type SourcePart,
  type Synthesis,
  type SynthesisProposal,
} from "./schema";
import { backupDb, deleteSourceFile, newEntry, newId, readDb, readSourceFile, saveSourceFile, updateDb } from "./store";

type Block = Anthropic.Beta.BetaContentBlockParam;

/** Limity jednego zapytania (model ma 1M kontekstu; API: maks. 600 obrazów i 600 stron PDF na zapytanie). */
const FULL_LIMITS = { tokens: 650_000, images: 500, pdfPages: 500 };
const BATCH_LIMITS = { tokens: 300_000, images: 250, pdfPages: 250 };
/** Maks. stron jednego PDF-a (więcej nie zmieści się w jednym zapytaniu). */
const MAX_PDF_PAGES = 500;
/** Obrazy osadzone w dokumentach: pomijamy ikonki i drobne grafiki, maks. tyle na dokument. */
const MAX_EMBEDDED_IMAGES = 60;
const MIN_EMBEDDED_BYTES = 8 * 1024;

const METRIC_GUIDE = METRIC_KEYS.map((k) => `- ${k}: ${METRIC_INFO[k].label} - ${METRIC_INFO[k].description}`).join("\n");

const SYNTHESIS_SYSTEM = `Budujesz system oceny wyglądu twarzy WYŁĄCZNIE na podstawie materiałów autora aplikacji. Aplikacja będzie potem oceniać zdjęcia twarzy użytkowników tylko według tego, co tu zapiszesz - więc wszystko, czego nie przeniesiesz, przepadnie, a wszystko, co dodasz od siebie, zafałszuje wiedzę autora.

Jak pracujesz:
1. Przeczytaj KAŻDY materiał w całości: tekst, PDF-y, zdjęcia notatek, zrzuty ekranu (także pocięte na kolejne części), tabele, schematy, grafiki z oznaczeniami, slajdy, arkusze i obrazy osadzone w dokumentach. Z obrazów odczytaj cały tekst i znaczenie oznaczeń.
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
7. gaps: czego brakuje, żeby rzetelnie oceniać twarz wg tych materiałów (np. cecha bez kryteriów, brak progów liczbowych, brak zaleceń). unreadable: pliki lub fragmenty nieczytelne - z pełnymi ścieżkami.
8. Pisz po polsku, ale zachowuj terminy autora (np. angielskie nazwy z looksmaxingu).

Pomiary liczone automatycznie przez aplikację ze zdjęcia (metric):
${METRIC_GUIDE}`;

const MERGE_FRAMEWORK_SYSTEM = `Materiały autora aplikacji do oceny wyglądu twarzy były za duże na jedno zapytanie, więc przeanalizowano je w częściach (zwykle folder po folderze). Dostajesz wyniki każdej części (<czesci>: opis systemu oceny, kategorie i listę tytułów wpisów) oraz pełną strukturę folderów autora.
Złóż z nich JEDEN spójny opis systemu oceny autora:
- framework: połączony opis założeń i sposobu oceniania autora (bez dodawania niczego spoza materiałów),
- categories: jedna wspólna lista kategorii wg struktury folderów autora (jego nazwy), z wagą 1-5,
- categoryMap: dla KAŻDEJ kategorii z KAŻDEJ części wskaż, do której wspólnej kategorii należy (part = numer części, from = id kategorii w części, to = id wspólnej kategorii),
- contradictions, gaps, unreadable: połączone listy (bez powtórzeń, ze ścieżkami plików).
Pisz po polsku, zachowuj terminy autora.`;

const MERGE_ENTRIES_SYSTEM = `Scalasz wpisy jednej kategorii systemu oceny wyglądu twarzy, zebrane z kilku części materiałów autora (oraz ewentualnie jego ręczne poprawki).
- Połącz wpisy opisujące tę samą zasadę/cechę w jeden, zachowując WSZYSTKIE szczegóły, liczby, progi, kryteria, zalecenia i wszystkie ścieżki plików w sourceFiles.
- Wpisy o różnych zasadach zostaw osobno. Nie gub żadnej wiedzy i nie dodawaj niczego spoza wpisów.
- Sprzeczne wpisy zostaw z wyraźnie zaznaczoną sprzecznością w treści - nie rozstrzygaj.
- Ręczne wpisy autora (<reczne_wpisy_autora>) mają pierwszeństwo; jeśli je uwzględniasz, podaj ich ID w fromManual.
- area każdego wpisu = id tej kategorii. Pisz po polsku, zachowuj terminy autora.`;

const SynthesisEntrySchema = SynthesisSchema.shape.entries.element;
type SynthesisEntry = z.infer<typeof SynthesisEntrySchema>;

const FrameworkMergeSchema = z.object({
  framework: SynthesisSchema.shape.framework,
  categories: SynthesisSchema.shape.categories,
  categoryMap: z.array(z.object({ part: z.number(), from: z.string(), to: z.string() })),
  contradictions: z.array(z.string()),
  gaps: z.array(z.string()),
  unreadable: z.array(z.string()),
});

const EntriesMergeSchema = z.object({ entries: z.array(SynthesisEntrySchema) });

// --- Stan zadania w tle (analiza może trwać kilka-kilkanaście minut) ---

export type JobState = {
  kind: "synthesis";
  status: "running" | "done" | "error";
  startedAt: string;
  stage: string;
  outputChars: number;
  error?: string;
};

const g = globalThis as unknown as { __knowledgeJob?: JobState | null; __fileIdsRunning?: Promise<void> | null; __migration?: Promise<void> | null };
export const currentJob = () => g.__knowledgeJob ?? null;

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const isHex64 = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
/** Skrót identyfikujący zawartość "jak u autora" (z przeglądarki), a dla starszych materiałów - zapisanych bajtów. */
const contentKey = (s: KnowledgeSource) => s.originalHash || s.hash;

// --- Materiały: przygotowanie plików ---

type Prepared = {
  kind: KnowledgeSource["kind"];
  mediaType: string;
  pages?: number;
  width?: number;
  height?: number;
  parts: Omit<SourcePart, "storedAs">[];
  partData: Buffer[];
  notes: string;
};

/** Sprawdza i przygotowuje plik: obrazy normalizowane (≤ 2000 px), PDF-y sprawdzone, z dokumentów wyciągnięte obrazy. */
async function prepareFile(path: string, type: string, data: Buffer): Promise<Prepared> {
  const detected = detectKind(path, type);
  if (!detected) throw new UserError(`Nieobsługiwany format pliku: ${path}.`);
  if (data.length === 0) throw new UserError(`Plik ${path} jest pusty.`);

  if (detected.kind === "image") {
    if (data.length > 40 * 1024 * 1024) throw new UserError(`Obraz ${path} jest większy niż 40 MB.`);
    let norm;
    try {
      norm = await normalizeImage(data);
    } catch (err) {
      throw new UserError(`${path}: ${err instanceof Error ? err.message : "nie udało się odczytać obrazu"}`);
    }
    return {
      kind: "image",
      mediaType: detected.mediaType,
      width: norm.width,
      height: norm.height,
      parts: norm.parts.map((p, i) => ({ mediaType: p.mediaType, width: p.width, height: p.height, label: norm.parts.length > 1 ? `część ${i + 1}/${norm.parts.length}` : "obraz" })),
      partData: norm.parts.map((p) => p.data),
      notes: "",
    };
  }

  if (detected.kind === "pdf") {
    let pages: number;
    try {
      const pdf = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });
      if (pdf.isEncrypted) throw new UserError(`PDF ${path} jest zabezpieczony hasłem - zapisz go bez zabezpieczenia (np. „Drukuj → Zapisz jako PDF”).`);
      pages = pdf.getPageCount();
    } catch (err) {
      if (err instanceof UserError) throw err;
      throw new UserError(`Nie udało się odczytać PDF-a ${path} (uszkodzony?). Spróbuj zapisać go ponownie jako PDF.`);
    }
    if (pages > MAX_PDF_PAGES) throw new UserError(`PDF ${path} ma ${pages} stron - podziel go na części do ${MAX_PDF_PAGES} stron.`);
    return { kind: "pdf", mediaType: detected.mediaType, pages, parts: [], partData: [], notes: "" };
  }

  // Tekst / Office: sprawdzenie odczytu + obrazy osadzone w dokumencie.
  let images: { data: Buffer; label: string }[];
  try {
    images = (await extractContent({ mediaType: detected.mediaType, path }, data)).images;
  } catch {
    throw new UserError(`Nie udało się odczytać pliku ${path} (uszkodzony lub zabezpieczony hasłem?).`);
  }
  const parts: Prepared["parts"] = [];
  const partData: Buffer[] = [];
  let skipped = 0;
  let unreadable = 0;
  for (const im of images) {
    if (im.data.length < MIN_EMBEDDED_BYTES) continue;
    if (parts.length >= MAX_EMBEDDED_IMAGES) {
      skipped++;
      continue;
    }
    try {
      const norm = await normalizeImage(im.data, { minSide: 200 });
      norm.parts.forEach((p, i) => {
        parts.push({ mediaType: p.mediaType, width: p.width, height: p.height, label: norm.parts.length > 1 ? `${im.label} (część ${i + 1})` : im.label });
        partData.push(p.data);
      });
    } catch {
      // Formaty bez podglądu (np. EMF/WMF - wklejone wykresy/tabele) - autor dostaje informację.
      unreadable++;
    }
  }
  const notes = [
    skipped && `pominięto ${skipped} obrazów osadzonych (limit ${MAX_EMBEDDED_IMAGES} na dokument)`,
    unreadable && `nie udało się odczytać ${unreadable} obrazów osadzonych (np. EMF/WMF) - jeśli są ważne, zapisz je jako PNG/JPG i wgraj osobno`,
  ]
    .filter(Boolean)
    .join("; ");
  return { kind: "text", mediaType: detected.mediaType, parts, partData, notes };
}

async function removeStoredFiles(s: Pick<KnowledgeSource, "storedAs" | "parts" | "fileId">) {
  const tasks: Promise<unknown>[] = [deleteSourceFile(s.storedAs).catch(() => undefined)];
  for (const p of s.parts ?? []) {
    tasks.push(deleteSourceFile(p.storedAs).catch(() => undefined));
    if (p.fileId) tasks.push(deleteFromFilesApi(p.fileId));
  }
  if (s.fileId) tasks.push(deleteFromFilesApi(s.fileId));
  await Promise.all(tasks);
}

/** Propozycja analizy przygotowana na innych materiałach niż obecne - oznaczamy ją jako nieaktualną. */
function invalidateProposal(db: Awaited<ReturnType<typeof readDb>>) {
  if (db.pendingSynthesis) db.pendingSynthesis.stale = true;
}

export type AddResult = { status: "added" | "updated" | "unchanged" | "duplicate"; path: string; duplicateOf?: string; notes?: string };

/**
 * Zapisuje materiał pod jego ścieżką (z folderami).
 * Ta sama ścieżka i treść = bez zmian; ta sama ścieżka, inna treść = aktualizacja (ten sam materiał, wymaga ponownej analizy);
 * identyczna treść pod inną ścieżką = duplikat (pomijany).
 * `originalHash` - skrót oryginalnego pliku policzony w przeglądarce (przed zmniejszeniem/konwersją).
 */
export async function addSource(file: { name: string; path?: string; type: string; data: Buffer; originalHash?: string }): Promise<AddResult> {
  await migrateLegacySources();
  const path = sanitizePath(file.path || file.name);
  const hash = sha256(file.data);
  const originalHash = isHex64(file.originalHash) ? file.originalHash : hash;

  const before = await readDb();
  const existingBefore = before.sources.find((s) => s.path === path);
  if (existingBefore && contentKey(existingBefore) === originalHash) return { status: "unchanged", path };

  const prepared = await prepareFile(path, file.type, file.data);
  const id = newId("S");
  const storedAs = await saveSourceFile(id, path, file.data);
  const parts: SourcePart[] = [];
  for (const [i, p] of prepared.parts.entries()) {
    parts.push({ ...p, storedAs: await saveSourceFile(`${id}-p${i}`, p.mediaType === "image/png" ? "x.png" : "x.jpg", prepared.partData[i]), fileId: null });
  }
  const source: KnowledgeSource = {
    id,
    path,
    filename: basename(path),
    kind: prepared.kind,
    mediaType: prepared.mediaType,
    storedAs,
    size: file.data.length,
    hash,
    originalHash,
    ...(prepared.width ? { width: prepared.width, height: prepared.height } : {}),
    ...(prepared.pages ? { pages: prepared.pages } : {}),
    parts,
    fileId: null,
    uploadedAt: new Date().toISOString(),
    entryCount: 0,
    notes: prepared.notes,
  };

  // Decyzja pod blokadą bazy - równoległe wgrywanie wielu plików nie może ominąć wykrywania duplikatów.
  type Decision = { result: AddResult; cleanup: Pick<KnowledgeSource, "storedAs" | "parts" | "fileId"> | null };
  const decision = await updateDb((db): Decision => {
    const existing = db.sources.find((s) => s.path === path);
    if (existing && contentKey(existing) === originalHash) return { result: { status: "unchanged", path }, cleanup: source };
    const sameContent = db.sources.find((s) => s.path !== path && (contentKey(s) === originalHash || s.hash === hash));
    if (sameContent && !existing) return { result: { status: "duplicate", path, duplicateOf: sameContent.path }, cleanup: source };
    if (existing) {
      // Nowa wersja pliku pod tą samą ścieżką: zachowujemy ID materiału (wpisy dalej na niego wskazują).
      const old = { storedAs: existing.storedAs, parts: existing.parts, fileId: existing.fileId };
      Object.assign(existing, { ...source, id: existing.id, entryCount: existing.entryCount });
      invalidateProposal(db);
      return { result: { status: "updated", path, notes: source.notes }, cleanup: old };
    }
    invalidateProposal(db);
    db.sources.push(source);
    return { result: { status: "added", path, notes: source.notes }, cleanup: null };
  });
  if (decision.cleanup) await removeStoredFiles(decision.cleanup);
  return decision.result;
}

const underAny = (roots: string[]) => (p: string) => roots.some((r) => p.startsWith(`${r}/`));

/**
 * Wstępne sprawdzenie przed ponownym wgraniem folderu (po skrótach oryginałów z przeglądarki):
 * które pliki są bez zmian (nie trzeba ich wysyłać), które to duplikaty, a które zostały tylko przeniesione.
 */
export async function checkUploads(files: { path: string; hash: string }[], uploadRoots: string[] = []) {
  await migrateLegacySources();
  const db = await readDb();
  const inRoots = underAny(uploadRoots.map(sanitizePath));
  const incoming = files.filter((f) => isHex64(f.hash)).map((f) => ({ path: sanitizePath(f.path), hash: f.hash }));
  const incomingHash = new Map(incoming.map((f) => [f.path, f.hash]));
  const byPath = new Map(db.sources.map((s) => [s.path, s]));
  const unchanged: string[] = [];
  const duplicates: { path: string; of: string }[] = [];
  const moves: { from: string; to: string }[] = [];
  const usedAsMove = new Set<string>();
  const seenHashes = new Map<string, string>();
  for (const f of incoming) {
    const existing = byPath.get(f.path);
    if (existing && contentKey(existing) === f.hash) {
      unchanged.push(f.path);
      continue;
    }
    if (existing) continue; // zmieniony plik pod tą samą ścieżką - do wysłania
    // Ta sama treść dwa razy w tym samym wgraniu - wysyłamy tylko pierwszy plik.
    const sameInUpload = seenHashes.get(f.hash);
    if (sameInUpload) {
      duplicates.push({ path: f.path, of: sameInUpload });
      continue;
    }
    seenHashes.set(f.hash, f.path);
    const other = db.sources.find((s) => contentKey(s) === f.hash && !usedAsMove.has(s.id));
    if (!other) continue;
    const otherIncoming = incomingHash.get(other.path);
    // Plik o tej treści dostaje w tym wgraniu nową wersję - ta treść zniknie z bazy, więc to nie duplikat.
    if (otherIncoming && otherIncoming !== f.hash) continue;
    if (!otherIncoming && inRoots(other.path)) {
      // Plik zniknął ze starego miejsca we wgrywanym folderze i pojawił się w nowym = przeniesienie (bez ponownego wysyłania).
      moves.push({ from: other.path, to: f.path });
      usedAsMove.add(other.id);
    } else {
      duplicates.push({ path: f.path, of: other.path });
    }
  }
  return { unchanged, duplicates, moves };
}

/**
 * Po wgraniu folderu: wykonuje przeniesienia plików i zwraca materiały z tych folderów, których nie było w nowej wersji
 * (np. usunięte lub przeniesione przez autora) - panel pyta, czy je usunąć.
 */
export async function reconcileUpload(input: { roots: string[]; uploaded: string[]; unreadable?: string[]; moves: { from: string; to: string }[] }) {
  const inRoots = underAny(input.roots.map(sanitizePath));
  const uploaded = new Set(input.uploaded.map(sanitizePath));
  // Pliki i foldery, których przeglądarka nie odczytała albo które pominęliśmy - nadal są u autora, więc nie są „usunięte”.
  const unreadable = (input.unreadable ?? []).map(sanitizePath);
  const notRead = (p: string) => unreadable.some((u) => p === u || p.startsWith(`${u}/`));
  return updateDb((db) => {
    let moved = 0;
    for (const m of input.moves) {
      const from = sanitizePath(m.from);
      const to = sanitizePath(m.to);
      const src = db.sources.find((s) => s.path === from);
      if (!src || uploaded.has(from) || !inRoots(from) || db.sources.some((s) => s.path === to)) continue;
      src.path = to;
      src.filename = basename(to);
      moved++;
    }
    if (moved) invalidateProposal(db);
    const stale = db.sources.filter((s) => inRoots(s.path) && !uploaded.has(s.path) && !notRead(s.path)).map((s) => ({ id: s.id, path: s.path }));
    return { moved, stale };
  });
}

/** Usuwa materiały (po ID, liście ID albo całym folderze) i wpisy, które pochodziły tylko z nich. */
export async function deleteSources(target: { id?: string; ids?: string[]; folder?: string }) {
  const folder = target.folder ? sanitizePath(target.folder) : null;
  const wanted = new Set(target.ids ?? (target.id ? [target.id] : []));
  const matches = (s: KnowledgeSource) => wanted.has(s.id) || (folder != null && (s.path === folder || s.path.startsWith(`${folder}/`)));
  if (!(await readDb()).sources.some(matches)) throw new UserError("Nie znaleziono materiałów do usunięcia (może już zostały usunięte).", 404);
  await backupDb("przed-usunieciem-materialow");
  const removed = await updateDb((db) => {
    const toRemove = db.sources.filter(matches);
    const ids = new Set(toRemove.map((s) => s.id));
    const before = db.entries.length;
    db.entries = db.entries.flatMap((e) => {
      if (!e.sourceIds.some((id) => ids.has(id))) return [e];
      const rest = e.sourceIds.filter((id) => !ids.has(id));
      // Wpis znika tylko wtedy, gdy usuwane materiały były jego jedynymi źródłami (ręczne poprawki zostają).
      return rest.length > 0 || e.manual ? [{ ...e, sourceIds: rest }] : [];
    });
    db.sources = db.sources.filter((s) => !ids.has(s.id));
    if (toRemove.length) invalidateProposal(db);
    return { files: toRemove, removedEntries: before - db.entries.length };
  });
  // Sprzątanie plików po zatwierdzeniu zmian w bazie - błąd pojedynczego pliku nie przerywa reszty.
  for (const s of removed.files) await removeStoredFiles(s);
  return { removedFiles: removed.files.length, removedEntries: removed.removedEntries };
}

/**
 * Uzupełnia materiały zapisane przez starsze wersje: skróty treści i znormalizowane obrazy (≤ 2000 px).
 * Jedno uruchomienie naraz - równoległe żądania czekają na to samo.
 */
export function migrateLegacySources(): Promise<void> {
  if (!g.__migration) g.__migration = runLegacyMigration().finally(() => (g.__migration = null));
  return g.__migration;
}

async function runLegacyMigration() {
  const db = await readDb();
  const legacy = db.sources.filter((s) => !s.hash || (s.kind === "image" && s.parts === undefined));
  if (legacy.length === 0) return;
  const updates = new Map<string, { patch: Partial<KnowledgeSource>; storedAs: string }>();
  for (const s of legacy) {
    const data = await readSourceFile(s.storedAs);
    if (!data) continue;
    const patch: Partial<KnowledgeSource> = {};
    if (!s.hash) patch.hash = sha256(data);
    if (s.kind === "image" && s.parts === undefined) {
      try {
        const norm = await normalizeImage(data);
        patch.parts = [];
        for (const [i, p] of norm.parts.entries()) {
          patch.parts.push({
            storedAs: await saveSourceFile(`${s.id}-p${i}`, p.mediaType === "image/png" ? "x.png" : "x.jpg", p.data),
            mediaType: p.mediaType,
            width: p.width,
            height: p.height,
            label: norm.parts.length > 1 ? `część ${i + 1}/${norm.parts.length}` : "obraz",
            fileId: null,
          });
        }
        patch.width = norm.width;
        patch.height = norm.height;
      } catch {
        patch.notes = "nie udało się odczytać obrazu - usuń go i wgraj ponownie jako JPG/PNG";
        patch.parts = [];
      }
      if (s.fileId) await deleteFromFilesApi(s.fileId);
      patch.fileId = null;
    }
    updates.set(s.id, { patch, storedAs: s.storedAs });
  }
  const discarded = await updateDb((d) => {
    const unused: Partial<KnowledgeSource>[] = [];
    for (const s of d.sources) {
      const u = updates.get(s.id);
      if (!u) continue;
      // Materiał podmieniony w międzyczasie (nowa wersja pliku) - łatka dotyczy starej treści.
      if (s.storedAs !== u.storedAs || (u.patch.parts && s.parts !== undefined)) unused.push(u.patch);
      else Object.assign(s, u.patch);
      updates.delete(s.id);
    }
    return [...unused, ...[...updates.values()].map((u) => u.patch)];
  });
  for (const patch of discarded) for (const p of patch.parts ?? []) await deleteSourceFile(p.storedAs);
}

// --- Files API ---

/**
 * Wgrywa obrazy i PDF-y do Files API (raz na plik) - zapytania zostają małe mimo setek plików.
 * Każdy plik osobno: postęp zapisywany na bieżąco, błąd jednego pliku nie przekreśla reszty,
 * a ID trafia do bazy tylko wtedy, gdy plik nie zmienił się w międzyczasie.
 */
async function ensureFileIds(job: JobState | null, opts: { force?: boolean; only?: Set<string> } = {}) {
  const db = await readDb();
  type Task = { sourceId: string; path: string; hash: string; part: number | null; storedAs: string; filename: string; mediaType: string; oldFileId: string | null };
  const tasks: Task[] = [];
  for (const s of db.sources) {
    if (opts.only && !opts.only.has(s.id)) continue;
    if (s.kind === "pdf" && (opts.force || !s.fileId)) {
      tasks.push({ sourceId: s.id, path: s.path, hash: s.hash, part: null, storedAs: s.storedAs, filename: s.filename, mediaType: s.mediaType, oldFileId: s.fileId ?? null });
    }
    (s.parts ?? []).forEach((p, i) => {
      if (opts.force || !p.fileId) {
        const ext = p.mediaType === "image/png" ? "png" : "jpg";
        tasks.push({ sourceId: s.id, path: s.path, hash: s.hash, part: i, storedAs: p.storedAs, filename: `${s.filename}-${i + 1}.${ext}`, mediaType: p.mediaType, oldFileId: p.fileId ?? null });
      }
    });
  }
  if (tasks.length === 0) return;
  const failures: string[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const t = tasks[next++];
      try {
        const data = await readSourceFile(t.storedAs);
        if (!data) throw new Error("brak pliku na dysku");
        const fileId = await uploadToFilesApi(data, t.filename, t.mediaType);
        let attached = false;
        await updateDb((d) => {
          const s = d.sources.find((x) => x.id === t.sourceId);
          // Plik zmieniony lub usunięty w trakcie - nie przypisujemy ID starej wersji.
          if (!s || s.hash !== t.hash) return;
          if (t.part === null) s.fileId = fileId;
          else if (s.parts?.[t.part]?.storedAs === t.storedAs) s.parts[t.part].fileId = fileId;
          else return;
          attached = true;
        });
        if (!attached) await deleteFromFilesApi(fileId);
        else if (t.oldFileId && t.oldFileId !== fileId) await deleteFromFilesApi(t.oldFileId);
      } catch (err) {
        failures.push(`${t.path}: ${err instanceof Error ? err.message.slice(0, 160) : "błąd"}`);
      }
      done++;
      if (job) job.stage = `Przygotowanie obrazów i PDF-ów: ${done}/${tasks.length}…`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, worker));
  if (failures.length) {
    throw new UserError(
      `Nie udało się przygotować ${failures.length} plików (pozostałe są gotowe - ponowna próba dokończy resztę):\n${failures.slice(0, 5).join("\n")}${failures.length > 5 ? "\n…" : ""}`,
      502,
    );
  }
}

/** W tle (bez blokowania żądań użytkownika) - np. po zatwierdzeniu analizy, żeby analiza twarzy miała gotowe pliki. */
function ensureFileIdsInBackground(only?: Set<string>) {
  if (g.__fileIdsRunning) return;
  g.__fileIdsRunning = ensureFileIds(null, { only })
    .catch((err) => console.warn("Przygotowanie plików w tle nie powiodło się:", err))
    .finally(() => {
      g.__fileIdsRunning = null;
    });
}

/** Do analizy twarzy: czy wszystkie podane materiały mają file_id; jeśli nie - uruchamia przygotowanie w tle. */
export function materialsReady(sources: KnowledgeSource[]): boolean {
  const ready = sources.every((s) => (s.kind !== "pdf" || s.fileId) && (s.parts ?? []).every((p) => p.fileId));
  if (!ready) ensureFileIdsInBackground(new Set(sources.map((s) => s.id)));
  return ready;
}

/** Po błędzie "brak pliku" w Files API: ponowne wgranie w tle (wyczyszczone ID). */
export async function resetFileIds(sources: KnowledgeSource[]) {
  const ids = new Set(sources.map((s) => s.id));
  await updateDb((d) => {
    for (const s of d.sources) {
      if (!ids.has(s.id)) continue;
      s.fileId = null;
      for (const p of s.parts ?? []) p.fileId = null;
    }
  });
  ensureFileIdsInBackground(ids);
}

// --- Dzielenie na części ---

type Limits = typeof FULL_LIMITS;

/**
 * Dzieli materiały na części mieszczące się w limitach - folder po folderze, w kolejności ścieżek.
 * Grupą jest folder tematu: przy wspólnym folderze głównym jego podfolder, inaczej folder pierwszego poziomu.
 */
export function packBatches<T extends { tokens: number; images: number; pages: number; source: { path: string } }>(items: T[], limits: Limits): T[][] {
  const roots = new Set(items.map((i) => (i.source.path.includes("/") ? i.source.path.split("/")[0] : "")));
  const commonRoot = roots.size === 1 && !roots.has("");
  const groupOf = (p: string) => {
    const segs = p.split("/").slice(0, -1);
    return commonRoot ? segs.slice(0, 2).join("/") : (segs[0] ?? "");
  };
  const batches: T[][] = [];
  let current: T[] = [];
  let sum = { tokens: 0, images: 0, pages: 0 };
  const fits = (i: T) => sum.tokens + i.tokens <= limits.tokens && sum.images + i.images <= limits.images && sum.pages + i.pages <= limits.pdfPages;
  for (const [idx, item] of items.entries()) {
    const prev = items[idx - 1];
    // Nowa część na granicy folderu, jeśli bieżąca jest już w ponad połowie pełna - foldery zostają razem.
    const folderBoundary = prev && groupOf(prev.source.path) !== groupOf(item.source.path) && sum.tokens > limits.tokens / 2;
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

/** Podział listy na dwie części możliwie na granicy folderu blisko środka. */
export function splitInTwo<T extends { source: { path: string } }>(items: T[]): [T[], T[]] {
  const mid = Math.floor(items.length / 2);
  const dir = (i: number) => items[i].source.path.split("/").slice(0, -1).join("/");
  let best = mid;
  for (let d = 0; d <= Math.floor(items.length / 4); d++) {
    if (mid - d > 0 && dir(mid - d) !== dir(mid - d - 1)) {
      best = mid - d;
      break;
    }
    if (mid + d < items.length && mid + d > 0 && dir(mid + d) !== dir(mid + d - 1)) {
      best = mid + d;
      break;
    }
  }
  best = Math.min(Math.max(best, 1), items.length - 1);
  return [items.slice(0, best), items.slice(best)];
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
type ManualEntry = ReturnType<typeof stripEntry>;

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
  await migrateLegacySources();
  await ensureFileIds(job);
  try {
    await synthesize(job);
  } catch (err) {
    // Pliki w Files API zniknęły (np. inny klucz API) - wgrywamy je ponownie i próbujemy raz jeszcze.
    if (!isMissingFileError(err)) throw err;
    job.stage = "Ponowne przygotowanie plików…";
    await ensureFileIds(job, { force: true });
    await synthesize(job);
  }
  job.status = "done";
  job.stage = "Gotowe";
}

type Ctx = {
  job: JobState;
  structure: Block;
  manual: ManualEntry[];
  manualVersions: Record<string, string>;
  /** Nazwy obecnych kategorii (ID → nazwa) - do dopasowania ręcznych wpisów */
  categoryNames: Record<string, string>;
  onText: (c: string) => void;
};

const manualBlock = (manual: ManualEntry[]): Block[] =>
  manual.length ? [{ type: "text", text: `<reczne_wpisy_autora>\n${JSON.stringify(manual, null, 1)}\n</reczne_wpisy_autora>` }] : [];

async function synthesize(job: JobState) {
  const db = await readDb();
  const sources = [...db.sources].sort((a, b) => a.path.localeCompare(b.path, "pl"));
  const items = await allItems(sources);
  const ctx: Ctx = {
    job,
    structure: folderStructureBlock(sources),
    manual: db.entries.filter((e) => e.manual).map(stripEntry),
    manualVersions: Object.fromEntries(db.entries.filter((e) => e.manual).map((e) => [e.id, e.updatedAt])),
    categoryNames: Object.fromEntries(db.categories.map((c) => [c.id, c.name])),
    onText: (chunk) => {
      job.outputChars += chunk.length;
    },
  };
  const totals = items.reduce((s, i) => ({ tokens: s.tokens + i.tokens, images: s.images + i.images, pages: s.pages + i.pages }), { tokens: 0, images: 0, pages: 0 });

  job.stage = "Liczenie rozmiaru materiałów…";
  const allBlocks = [ctx.structure, ...items.flatMap((i) => i.blocks), ...manualBlock(ctx.manual)];
  let total: number | null = null;
  if (totals.tokens <= FULL_LIMITS.tokens * 1.5 && totals.images <= FULL_LIMITS.images && totals.pages <= FULL_LIMITS.pdfPages) {
    try {
      total = await countTokens(SYNTHESIS_SYSTEM, allBlocks);
    } catch (err) {
      if (isMissingFileError(err)) throw err;
      console.warn("count_tokens nie powiodło się - używam szacunku", err);
    }
  }
  const tokens = total ?? totals.tokens;

  let synthesis: Synthesis | null = null;
  let mode: SynthesisProposal["mode"] = "full";
  if (tokens <= FULL_LIMITS.tokens && totals.images <= FULL_LIMITS.images && totals.pages <= FULL_LIMITS.pdfPages) {
    try {
      job.stage = `Czytanie i analiza wszystkich materiałów naraz (${sources.length} plików, ~${Math.round(tokens / 1000)} tys. tokenów)…`;
      synthesis = await structuredCall({
        schema: SynthesisSchema,
        system: [{ type: "text", text: SYNTHESIS_SYSTEM }],
        content: [...allBlocks, { type: "text", text: `Przeanalizuj wszystkie materiały (${sources.length} plików) i zbuduj z nich kompletny system oceny.` }],
        effort: "high",
        maxTokens: 128000,
        onText: ctx.onText,
      });
    } catch (err) {
      // Za dużo do przeczytania lub do zapisania naraz - przechodzimy na analizę w częściach.
      if (!(err instanceof ClaudeTruncatedError) && !isRequestLimitError(err)) throw err;
      job.outputChars = 0;
    }
  }
  if (!synthesis) {
    mode = "batched";
    const batches = packBatches(items, BATCH_LIMITS);
    const parts: Synthesis[] = [];
    for (const [i, batch] of batches.entries()) parts.push(...(await synthesizeBatch(ctx, batch, `${i + 1}/${batches.length}`)));
    synthesis = await mergeParts(ctx, parts);
  }

  job.stage = "Zapisywanie propozycji…";
  const final = synthesis;
  await updateDb((d) => {
    d.pendingSynthesis = {
      createdAt: new Date().toISOString(),
      mode,
      materialTokens: tokens,
      basedOn: d.entries.map((e) => e.id),
      sourceIds: sources.map((s) => s.id),
      sources: sources.map((s) => ({ id: s.id, path: s.path, hash: s.hash })),
      synthesis: final,
      stale: false,
      manualVersions: ctx.manualVersions,
    };
  });
}

/**
 * Analiza jednej części. Gdy jest za duża (do przeczytania albo do zapisania) - dzieli ją na pół i analizuje osobno;
 * gotowe części nie są powtarzane.
 */
async function synthesizeBatch(ctx: Ctx, items: MaterialItem[], label: string): Promise<Synthesis[]> {
  const files = [...new Set(items.map((i) => i.source.path))];
  const folders = [...new Set(files.map((p) => p.split("/").slice(0, -1).join("/") || "(główny folder)"))];
  ctx.job.stage = `Analiza części ${label}: ${files.length} plików (${folders.slice(0, 3).join(", ")}${folders.length > 3 ? "…" : ""})`;
  try {
    return [
      await structuredCall({
        schema: SynthesisSchema,
        system: [{ type: "text", text: SYNTHESIS_SYSTEM }],
        content: [
          ctx.structure,
          ...items.flatMap((i) => i.blocks),
          { type: "text", text: `To część ${label} materiałów (pełna struktura folderów jest wyżej). Przeanalizuj dokładnie pliki z tej części.` },
        ],
        effort: "high",
        maxTokens: 128000,
        onText: ctx.onText,
      }),
    ];
  } catch (err) {
    if (!(err instanceof ClaudeTruncatedError) && !isRequestLimitError(err)) throw err;
    if (items.length === 1) {
      throw new UserError(
        `Materiał „${items[0].source.path}” jest za duży, żeby przeanalizować go w jednym zapytaniu${err instanceof ClaudeTruncatedError ? " (za dużo treści do zapisania)" : ""}. Podziel go na mniejsze pliki.`,
        413,
      );
    }
    const [a, b] = splitInTwo(items);
    return [...(await synthesizeBatch(ctx, a, `${label}a`)), ...(await synthesizeBatch(ctx, b, `${label}b`))];
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

/**
 * Składanie wyników części w dwóch krokach, żeby żaden krok nie musiał zapisać wszystkiego naraz:
 * 1) wspólny opis systemu oceny i kategorie (+ mapowanie kategorii części), 2) scalenie wpisów osobno dla każdej kategorii.
 */
async function mergeParts(ctx: Ctx, parts: Synthesis[]): Promise<Synthesis> {
  if (parts.length === 1 && ctx.manual.length === 0) return parts[0];
  ctx.job.stage = `Składanie ${parts.length} części: wspólny system oceny i kategorie…`;
  const overview = parts.map((p, i) => ({
    part: i + 1,
    framework: p.framework,
    categories: p.categories,
    entryTitles: p.entries.map((e) => `${e.area}: ${e.title}${e.topic ? ` [${e.topic}]` : ""}`),
    contradictions: p.contradictions,
    gaps: p.gaps,
    unreadable: p.unreadable,
  }));
  const fw = await structuredCall({
    schema: FrameworkMergeSchema,
    system: [{ type: "text", text: MERGE_FRAMEWORK_SYSTEM }],
    content: [ctx.structure, { type: "text", text: `<czesci>\n${JSON.stringify(overview)}\n</czesci>\n\nZłóż wspólny opis systemu oceny i kategorie.` }],
    effort: "high",
    maxTokens: 64000,
    onText: ctx.onText,
  });
  const catIds = new Set(fw.categories.map((c) => c.id));
  const mapCat = (part: number, from: string) => {
    const hit = fw.categoryMap.find((m) => m.part === part && m.from === from)?.to;
    if (hit && catIds.has(hit)) return hit;
    if (catIds.has(from)) return from;
    return fw.categories.find((c) => slugify(c.name) === slugify(from))?.id ?? fw.categories[0]?.id ?? from;
  };

  // Wpisy wszystkich części przypisane do wspólnych kategorii.
  const byCategory = new Map<string, SynthesisEntry[]>();
  parts.forEach((p, i) => {
    for (const e of p.entries) {
      const area = mapCat(i + 1, e.area);
      byCategory.set(area, [...(byCategory.get(area) ?? []), { ...e, area }]);
    }
  });
  // Kategoria ręcznego wpisu w nowym układzie: to samo ID albo ta sama nazwa (ID kategorii mogą się zmienić między analizami).
  const manualArea = (m: ManualEntry) => {
    if (catIds.has(m.area)) return m.area;
    const names = [m.area, ctx.categoryNames[m.area]].filter(Boolean).map((n) => slugify(n));
    return fw.categories.find((c) => names.includes(slugify(c.name)))?.id ?? null;
  };
  // Ręczne wpisy z kategorii bez wpisów z materiałów też trafiają do scalania.
  for (const m of ctx.manual) {
    const area = manualArea(m);
    if (area && !byCategory.has(area)) byCategory.set(area, []);
  }

  const categories = [...byCategory.keys()];
  let done = 0;
  const merged = await mapLimit(categories, 3, async (area) => {
    const entries = byCategory.get(area)!;
    const manual = ctx.manual.filter((m) => manualArea(m) === area);
    const result = parts.length === 1 && manual.length === 0 ? entries : await mergeCategory(ctx, area, entries, manual);
    ctx.job.stage = `Scalanie wpisów w kategoriach: ${++done}/${categories.length}…`;
    return result;
  });
  return {
    framework: fw.framework,
    categories: fw.categories,
    entries: merged.flat(),
    contradictions: fw.contradictions,
    gaps: fw.gaps,
    unreadable: fw.unreadable,
  };
}

/** Scalenie wpisów jednej kategorii; przy zbyt dużej liczbie - po połowie (wg tematów). */
async function mergeCategory(ctx: Ctx, area: string, entries: SynthesisEntry[], manual: ManualEntry[]): Promise<SynthesisEntry[]> {
  if (entries.length <= 1 && manual.length === 0) return entries;
  try {
    const res = await structuredCall({
      schema: EntriesMergeSchema,
      system: [{ type: "text", text: MERGE_ENTRIES_SYSTEM }],
      content: [
        {
          type: "text",
          text: `<kategoria id="${area}">\n${JSON.stringify(entries)}\n</kategoria>${manual.length ? `\n<reczne_wpisy_autora>\n${JSON.stringify(manual)}\n</reczne_wpisy_autora>` : ""}\n\nScal wpisy tej kategorii.`,
        },
      ],
      effort: "medium",
      maxTokens: 128000,
      onText: ctx.onText,
    });
    return res.entries.map((e) => ({ ...e, area }));
  } catch (err) {
    if (!(err instanceof ClaudeTruncatedError) && !isRequestLimitError(err)) throw err;
    if (entries.length < 4) return entries; // nie da się już podzielić - zostawiamy bez scalania (nic nie ginie)
    const sorted = [...entries].sort((a, b) => (a.topic ?? "").localeCompare(b.topic ?? "", "pl"));
    const mid = Math.floor(sorted.length / 2);
    return [...(await mergeCategory(ctx, area, sorted.slice(0, mid), manual)), ...(await mergeCategory(ctx, area, sorted.slice(mid), []))];
  }
}

/** Zatwierdza propozycję: zastępuje kategorie, wpisy i opis systemu oceny. */
export async function applySynthesis() {
  await backupDb("przed-analiza-materialow");
  const result = await updateDb((db) => {
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

    // Ścieżki wskazane przez model -> materiały. Stan z chwili analizy (pliki mogły zostać potem przeniesione/usunięte).
    const snapshot = proposal.sources ?? db.sources.map((s) => ({ id: s.id, path: s.path, hash: s.hash }));
    const byPath = new Map(snapshot.map((s) => [s.path, s.id]));
    const byName = new Map<string, string | null>();
    for (const s of snapshot) {
      const name = basename(s.path);
      byName.set(name, byName.has(name) ? null : s.id);
    }
    const existing = new Set(db.sources.map((s) => s.id));
    const resolve = (f: string) => byPath.get(sanitizePath(f)) ?? byName.get(basename(sanitizePath(f))) ?? undefined;

    // Ręczne wpisy poprawione po tym, jak analiza je przeczytała (także w trakcie jej trwania) - zachowujemy obecną wersję
    // (poprawka autora nie może zginąć).
    const versions = proposal.manualVersions;
    const editedAfter = new Set(
      db.entries.filter((e) => e.manual && (versions ? versions[e.id] !== e.updatedAt : e.updatedAt > proposal.createdAt)).map((e) => e.id),
    );
    const manualUsed = new Set(syn.entries.flatMap((e) => e.fromManual).filter((id) => !editedAfter.has(id)));
    let droppedDeleted = 0;
    const created = syn.entries.flatMap(({ sourceFiles, fromManual, topic, ...draft }) => {
      const resolved = [...new Set(sourceFiles.map(resolve).filter((x): x is string => Boolean(x)))];
      const sourceIds = resolved.filter((id) => existing.has(id));
      // Wpis pochodzący wyłącznie z materiałów usuniętych po analizie - pomijamy (to wiedza, której autor już nie chce).
      if (resolved.length > 0 && sourceIds.length === 0 && fromManual.length === 0) {
        droppedDeleted++;
        return [];
      }
      const parsed = DraftEntrySchema.safeParse({ ...draft, area: ensureCategory(draft.area) });
      if (!parsed.success) return [];
      const entry = newEntry(db, parsed.data, sourceIds, fromManual.length > 0);
      return [topic?.trim() ? { ...entry, topic: topic.trim() } : entry];
    });

    // Zostają: ręczne wpisy, których model nie uwzględnił (lub poprawione później), i wpisy dodane po przygotowaniu propozycji.
    const basedOn = new Set(proposal.basedOn);
    const kept = db.entries.filter((e) => (e.manual && !manualUsed.has(e.id)) || !basedOn.has(e.id));
    for (const e of kept) e.area = ensureCategory(e.area);

    const before = db.entries.length;
    db.entries = [...created, ...kept];
    db.categories = categories;
    const analyzed = db.sources.filter((s) => proposal.sourceIds.includes(s.id));
    const snapHash = new Map(snapshot.map((s) => [s.id, s.hash]));
    db.framework = {
      summary: syn.framework.summary,
      scoringNotes: syn.framework.scoringNotes,
      contradictions: syn.contradictions,
      gaps: syn.gaps,
      materialTokens: proposal.materialTokens,
      analyzedAt: new Date().toISOString(),
      sourceIds: analyzed.map((s) => s.id),
      // Skrót z chwili analizy: plik zmieniony później zostanie oznaczony jako "zmieniony".
      sourceHashes: Object.fromEntries(analyzed.map((s) => [s.id, snapHash.get(s.id) ?? s.hash])),
    };
    for (const s of db.sources) {
      s.entryCount = db.entries.filter((e) => e.sourceIds.includes(s.id)).length;
      // Uwagi o nieczytelności - tylko po pełnej ścieżce (albo nazwie, jeśli jest jednoznaczna).
      const unique = byName.get(s.filename) === s.id;
      const unreadable = syn.unreadable.filter((u) => u.includes(s.path) || (unique && u.includes(s.filename)));
      s.notes = [s.notes.startsWith("pominięto") ? s.notes : "", ...unreadable].filter(Boolean).join("; ");
    }
    db.pendingSynthesis = null;
    return { before, after: db.entries.length, categories: categories.length, droppedDeleted, analyzed };
  });
  // Pliki dla analizy twarzy (Files API) - w tle, żeby pierwsza analiza nie czekała.
  ensureFileIdsInBackground(new Set(result.analyzed.map((s) => s.id)));
  return { before: result.before, after: result.after, categories: result.categories, droppedDeleted: result.droppedDeleted };
}

export async function rejectSynthesis() {
  await updateDb((db) => {
    db.pendingSynthesis = null;
  });
}
