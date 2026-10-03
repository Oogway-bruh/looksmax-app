import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { KnowledgeEntrySchema } from "@/lib/schema";
import { backupDb, normalizeDb, updateDb } from "@/lib/store";

const ImportSchema = z
  .object({
    entries: z.array(KnowledgeEntrySchema),
    nextEntryNumber: z.number(),
  })
  .passthrough();

// Przywraca bazę z pliku eksportu (np. z kopii zapasowej). Obecna baza trafia do data/backups.
// Uwaga: oryginalne pliki materiałów nie są częścią eksportu JSON.
export async function POST(req: Request) {
  try {
    const incoming = normalizeDb(ImportSchema.parse(await req.json()));
    await backupDb("przed-importem");
    await updateDb((db) => {
      db.entries = incoming.entries;
      db.categories = incoming.categories;
      db.framework = incoming.framework;
      db.nextEntryNumber = Math.max(db.nextEntryNumber, incoming.nextEntryNumber);
      db.pendingSynthesis = null;
    });
    return NextResponse.json({ ok: true, entries: incoming.entries.length });
  } catch (err) {
    return errorResponse(err);
  }
}
