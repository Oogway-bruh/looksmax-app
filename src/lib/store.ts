import "server-only";
import { promises as fs } from "fs";
import path from "path";
import type { Database, DraftEntry, KnowledgeEntry } from "./schema";

// Prosta baza w pliku JSON (data/db.json). Wystarczy na start i łatwo ją podejrzeć;
// przy wdrożeniu na serwer bez stałego dysku (np. Vercel) wymień na Postgres - interfejs zostaje ten sam.
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");

const EMPTY: Database = { entries: [], sources: [], nextEntryNumber: 1 };

let queue: Promise<unknown> = Promise.resolve();

export async function readDb(): Promise<Database> {
  try {
    return JSON.parse(await fs.readFile(DB_PATH, "utf8")) as Database;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY);
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

export function newEntry(db: Database, draft: DraftEntry, sourceIds: string[]): KnowledgeEntry {
  const id = `K${String(db.nextEntryNumber++).padStart(3, "0")}`;
  return { ...draft, id, sourceIds, updatedAt: new Date().toISOString() };
}

export function newId(prefix: string) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
