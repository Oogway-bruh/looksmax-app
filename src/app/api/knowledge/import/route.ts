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

/**
 * Przywraca wpisy, kategorie i system oceny z pliku eksportu (np. z kopii zapasowej). Obecna baza trafia do data/backups.
 * Pliki materiałów nie są częścią eksportu - zostają obecne, a odnośniki wpisów do materiałów są dopasowywane po ścieżkach.
 */
export async function POST(req: Request) {
  try {
    const incoming = normalizeDb(ImportSchema.parse(await req.json()));
    await backupDb("przed-importem");
    const result = await updateDb((db) => {
      const importedPath = new Map(incoming.sources.map((s) => [s.id, s.path]));
      const currentByPath = new Map(db.sources.map((s) => [s.path, s.id]));
      const remap = (id: string) => currentByPath.get(importedPath.get(id) ?? "") ?? (db.sources.some((s) => s.id === id) ? id : null);
      let unlinked = 0;
      db.entries = incoming.entries.map((e) => {
        const ids = e.sourceIds.map(remap).filter((x): x is string => Boolean(x));
        if (ids.length < e.sourceIds.length) unlinked++;
        return { ...e, sourceIds: [...new Set(ids)] };
      });
      db.categories = incoming.categories;
      if (incoming.framework) {
        const ids = incoming.framework.sourceIds.map(remap).filter((x): x is string => Boolean(x));
        // Skróty z eksportu nie pasują do obecnych plików - materiały zostaną oznaczone do ponownej analizy, jeśli się różnią.
        const hashes = Object.fromEntries(
          Object.entries(incoming.framework.sourceHashes ?? {}).flatMap(([id, h]) => {
            const to = remap(id);
            return to ? [[to, h]] : [];
          }),
        );
        const { sourceHashes, ...framework } = incoming.framework;
        db.framework = { ...framework, sourceIds: ids, ...(sourceHashes ? { sourceHashes: hashes } : {}) };
      } else db.framework = null;
      db.nextEntryNumber = Math.max(db.nextEntryNumber, incoming.nextEntryNumber);
      db.pendingSynthesis = null;
      for (const s of db.sources) s.entryCount = db.entries.filter((e) => e.sourceIds.includes(s.id)).length;
      return { entries: db.entries.length, unlinked };
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return errorResponse(err);
  }
}
