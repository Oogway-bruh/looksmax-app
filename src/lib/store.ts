import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { DEFAULT_CATEGORIES, type Database, type DraftEntry, type KnowledgeEntry } from "./schema";

// Prosta baza w pliku JSON (data/db.json) + oryginalne materiały w data/sources.
// Przy wdrożeniu na serwer bez stałego dysku (np. Vercel) wymień na Postgres/Storage - interfejs zostaje ten sam.
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const SOURCES_DIR = path.join(DATA_DIR, "sources");

const empty = (): Database => ({ entries: [], categories: [], sources: [], framework: null, nextEntryNumber: 1, pendingSynthesis: null });

/** Uzupełnia bazy zapisane przez starsze wersje aplikacji. */
export function normalizeDb(raw: Partial<Database> & Record<string, unknown>): Database {
  const db: Database = { ...empty(), ...raw } as Database;
  db.entries = db.entries ?? [];
  const sourceDefaults = { mediaType: "", storedAs: "", size: 0, notes: "", entryCount: 0, hash: "" };
  db.sources = (db.sources ?? []).map((s) => ({ ...sourceDefaults, ...s, path: s.path || s.filename }));
  if (!db.categories || db.categories.length === 0) {
    const used = new Set(db.entries.map((e) => e.area));
    db.categories = DEFAULT_CATEGORIES.filter((c) => used.has(c.id));
  }
  // Wpisy z kategorią, której nie ma na liście - dopisujemy kategorię, żeby nic nie zginęło.
  for (const id of new Set(db.entries.map((e) => e.area))) {
    if (!db.categories.some((c) => c.id === id)) {
      db.categories.push(DEFAULT_CATEGORIES.find((c) => c.id === id) ?? { id, name: id, description: "", weight: 3 });
    }
  }
  delete (db as unknown as Record<string, unknown>).pendingConsolidation;
  return db;
}

let queue: Promise<unknown> = Promise.resolve();

export async function readDb(): Promise<Database> {
  try {
    return normalizeDb(JSON.parse(await fs.readFile(DB_PATH, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw err;
  }
}

async function writeDb(db: Database) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DB_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2));
  await fs.rename(tmp, DB_PATH);
}

/** Wykonuje zmianę bazy po kolei (bez wyścigów między równoległymi żądaniami). */
export function updateDb<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const db = await readDb();
    const result = await fn(db);
    await writeDb(db);
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

export async function backupDb(reason: string) {
  const db = await readDb();
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.writeFile(path.join(BACKUP_DIR, `${stamp}-${reason}.json`), JSON.stringify(db, null, 2));
}

export function newEntry(db: Database, draft: DraftEntry, sourceIds: string[], manual = false): KnowledgeEntry {
  const id = `K${String(db.nextEntryNumber++).padStart(3, "0")}`;
  return { ...draft, id, sourceIds, updatedAt: new Date().toISOString(), ...(manual ? { manual: true } : {}) };
}

export function newId(prefix: string) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Zapisuje oryginalny plik materiału; zwraca nazwę pliku w data/sources. */
export async function saveSourceFile(id: string, filename: string, data: Buffer): Promise<string> {
  await fs.mkdir(SOURCES_DIR, { recursive: true });
  const ext = path.extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8);
  const storedAs = `${id}${ext}`;
  await fs.writeFile(path.join(SOURCES_DIR, storedAs), data);
  return storedAs;
}

export async function readSourceFile(storedAs: string): Promise<Buffer | null> {
  if (!storedAs) return null;
  try {
    return await fs.readFile(path.join(SOURCES_DIR, path.basename(storedAs)));
  } catch {
    return null;
  }
}

export async function deleteSourceFile(storedAs: string) {
  if (!storedAs) return;
  await fs.rm(path.join(SOURCES_DIR, path.basename(storedAs)), { force: true });
}
