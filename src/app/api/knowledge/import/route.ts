import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { KnowledgeEntrySchema } from "@/lib/schema";
import { backupDb, updateDb } from "@/lib/store";

const ImportSchema = z.object({
  entries: z.array(KnowledgeEntrySchema),
  sources: z.array(z.any()),
  nextEntryNumber: z.number(),
});

// Przywraca bazę z pliku eksportu (np. z kopii zapasowej). Obecna baza trafia do data/backups.
export async function POST(req: Request) {
  try {
    const incoming = ImportSchema.parse(await req.json());
    await backupDb("przed-importem");
    await updateDb((db) => {
      db.entries = incoming.entries;
      db.sources = incoming.sources;
      db.nextEntryNumber = incoming.nextEntryNumber;
    });
    return NextResponse.json({ ok: true, entries: incoming.entries.length });
  } catch (err) {
    return errorResponse(err);
  }
}
