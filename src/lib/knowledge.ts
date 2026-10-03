import "server-only";
import { UserError } from "./http";
import type Anthropic from "@anthropic-ai/sdk";
import { structuredCall } from "./claude";
import { METRIC_INFO, METRIC_KEYS } from "./metrics";
import { AREAS, AREA_LABELS, ConsolidationSchema, ExtractionSchema, type ConsolidationProposal, type DraftEntry, type KnowledgeEntry } from "./schema";
import { backupDb, newEntry, newId, readDb, updateDb } from "./store";

const METRIC_GUIDE = METRIC_KEYS.map((k) => `- ${k}: ${METRIC_INFO[k].label} - ${METRIC_INFO[k].description}`).join("\n");
const AREA_GUIDE = AREAS.map((a) => `${a} (${AREA_LABELS[a]})`).join(", ");

const EXTRACTION_SYSTEM = `Porządkujesz prywatną bazę wiedzy autora aplikacji do oceny wyglądu twarzy ze zdjęcia.
Dostajesz jeden materiał autora (tekst, zdjęcie notatek/grafiki lub PDF). Wyciągnij z niego wszystkie zasady, kryteria oceny i zalecenia jako osobne wpisy.

Najważniejsza zasada: baza ma zawierać WYŁĄCZNIE wiedzę autora. Przenoś to, co jest w materiale - nie dodawaj niczego z własnej wiedzy, nie poprawiaj autora, nie uzupełniaj brakujących progów ani zaleceń. Jeśli coś jest niejasne lub nieczytelne, zapisz to w polu notes zamiast zgadywać.

Jak tworzyć wpisy:
- Jeden wpis = jedna konkretna cecha lub zasada (np. "nachylenie oczu", "proporcja ust do nosa"). Nie łącz niezwiązanych rzeczy.
- area: jedna z: ${AREA_GUIDE}.
- content: sedno zasady, zwięźle, ale bez gubienia szczegółów, które podał autor.
- assessmentCriteria: jak rozpoznać na zdjęciu twarzy, czy cecha wypada dobrze czy źle - tylko jeśli materiał to mówi.
- metric + ranges: wypełnij tylko, gdy materiał podaje progi liczbowe, które odpowiadają jednemu z pomiarów liczonych automatycznie przez aplikację (lista niżej). Przedziały mają być rozłączne; min włącznie, max wyłącznie. Jeśli materiał nie podaje oceny liczbowej, ustal score proporcjonalnie do werdyktu (ideal 9-10, good 7-8, average 5-6, weak 1-4). W pozostałych przypadkach metric = null i ranges = [].
- recommendations: konkretne działania, które materiał zaleca.
- priority 1-5: jak ważna jest ta cecha dla całego wyglądu według materiału (jeśli materiał nie mówi - 3).
- Pisz po polsku, nawet jeśli materiał jest w innym języku.

Pomiary liczone automatycznie przez aplikację:
${METRIC_GUIDE}`;

const CONSOLIDATION_SYSTEM = `Porządkujesz prywatną bazę wiedzy autora aplikacji do oceny wyglądu twarzy. Wpisy powstały z wielu materiałów, więc się powtarzają i są nierówne.
Twoje zadanie: uporządkować całą bazę do zestawu kluczowych, niepowtarzających się wpisów.

- Połącz duplikaty i wpisy o tej samej cesze w jeden, zachowując wszystkie istotne szczegóły, progi i zalecenia.
- Gdy wpisy są sprzeczne, zostaw oba warianty w treści i wyraźnie zaznacz sprzeczność (np. "UWAGA: sprzeczność - źródło A mówi..., źródło B mówi...") - nie rozstrzygaj sam.
- Usuń tylko to, co jest czystym powtórzeniem albo nie wnosi nic do oceny twarzy ani zaleceń.
- Ustaw priority (1-5) tak, by odzwierciedlało, co według tej bazy jest najważniejsze.
- W mergedFrom podaj ID wszystkich wpisów, z których powstał nowy wpis - każdy stary wpis, który zostaje, musi pojawić się w mergedFrom jakiegoś nowego wpisu.
- Nie dodawaj żadnej wiedzy spoza bazy. Pisz po polsku.
- area: jedna z: ${AREA_GUIDE}. metric (lub null): ${METRIC_KEYS.join(", ")}.`;

export type UploadedFile = { name: string; type: string; data: Buffer };

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];
const MAX_TEXT_CHARS = 120_000;

function fileToContent(file: UploadedFile): { kind: "text" | "image" | "pdf"; blocks: Anthropic.Beta.BetaContentBlockParam[][] } {
  if ((IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return {
      kind: "image",
      blocks: [[{ type: "image", source: { type: "base64", media_type: file.type as ImageType, data: file.data.toString("base64") } }]],
    };
  }
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    return {
      kind: "pdf",
      blocks: [[{ type: "document", source: { type: "base64", media_type: "application/pdf", data: file.data.toString("base64") } }]],
    };
  }
  // Tekst: długie pliki dzielimy na części po akapitach, żeby każda odpowiedź zmieściła się w limicie.
  const text = file.data.toString("utf8");
  const chunks: string[] = [];
  let current = "";
  for (const para of text.split(/\n\s*\n/)) {
    if (current.length + para.length > MAX_TEXT_CHARS && current) {
      chunks.push(current);
      current = "";
    }
    current += para + "\n\n";
  }
  if (current.trim()) chunks.push(current);
  return {
    kind: "text",
    blocks: chunks.map((c, i) => [
      { type: "text", text: `<material plik="${file.name}" czesc="${i + 1}/${chunks.length}">\n${c}\n</material>` },
    ]),
  };
}

export async function ingestFile(file: UploadedFile) {
  const { kind, blocks } = fileToContent(file);
  const drafts: DraftEntry[] = [];
  const notes: string[] = [];
  for (const content of blocks) {
    const result = await structuredCall({
      schema: ExtractionSchema,
      system: [{ type: "text", text: EXTRACTION_SYSTEM }],
      content: [...content, { type: "text", text: `Plik: ${file.name}. Wyciągnij wiedzę z tego materiału.` }],
      effort: "medium",
    });
    drafts.push(...result.entries);
    if (result.notes) notes.push(result.notes);
  }

  return updateDb((db) => {
    const sourceId = newId("S");
    const created = drafts.map((d) => newEntry(db, d, [sourceId]));
    db.entries.push(...created);
    db.sources.push({
      id: sourceId,
      filename: file.name,
      kind,
      uploadedAt: new Date().toISOString(),
      entryCount: created.length,
      notes: notes.join("\n"),
    });
    return { sourceId, created: created.length, notes: notes.join("\n") };
  });
}

export function entriesForPrompt(entries: KnowledgeEntry[]) {
  // Bez pól technicznych - model widzi tylko treść i ID.
  return JSON.stringify(
    entries.map((e) => ({
      id: e.id,
      area: e.area,
      title: e.title,
      content: e.content,
      assessmentCriteria: e.assessmentCriteria,
      metric: e.metric,
      ranges: e.ranges,
      recommendations: e.recommendations,
      priority: e.priority,
    })),
    null,
    1,
  );
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Przygotowuje propozycję uporządkowania bazy (nic jeszcze nie zmienia).
 * Każdy obszar jest porządkowany osobnym zapytaniem - działa też dla bardzo dużych baz.
 */
export async function proposeConsolidation(): Promise<ConsolidationProposal> {
  const db = await readDb();
  if (db.entries.length === 0) throw new UserError("Baza jest pusta.", 409);

  const groups = AREAS.map((area) => db.entries.filter((e) => e.area === area)).filter((g) => g.length > 0);
  const results = await mapLimit(groups, 3, async (group) => {
    // Pojedynczy wpis nie ma z czym się łączyć.
    if (group.length === 1) {
      const { id, sourceIds, updatedAt, ...draft } = group[0];
      return { entries: [{ ...draft, mergedFrom: [id] }], changes: [] as string[] };
    }
    return structuredCall({
      schema: ConsolidationSchema,
      system: [{ type: "text", text: CONSOLIDATION_SYSTEM }],
      content: [
        {
          type: "text",
          text: `<baza_wiedzy obszar="${AREA_LABELS[group[0].area]}">\n${entriesForPrompt(group)}\n</baza_wiedzy>\n\nUporządkuj wpisy z tego obszaru.`,
        },
      ],
      effort: "high",
      maxTokens: 128000,
    });
  });

  const known = new Set(db.entries.map((e) => e.id));
  const proposal: ConsolidationProposal = {
    createdAt: new Date().toISOString(),
    basedOn: [...known],
    entries: results.flatMap((r) => r.entries.map((e) => ({ ...e, mergedFrom: e.mergedFrom.filter((id) => known.has(id)) }))),
    changes: results.flatMap((r) => r.changes),
  };
  await updateDb((d) => {
    d.pendingConsolidation = proposal;
  });
  return proposal;
}

export async function applyConsolidation() {
  await backupDb("przed-porzadkowaniem");
  return updateDb((db) => {
    const proposal = db.pendingConsolidation;
    if (!proposal) throw new UserError("Brak propozycji do zatwierdzenia.", 409);
    const byId = new Map(db.entries.map((e) => [e.id, e]));
    const merged = proposal.entries.map(({ mergedFrom, ...draft }) => {
      const sourceIds = [...new Set(mergedFrom.flatMap((id) => byId.get(id)?.sourceIds ?? []))];
      return newEntry(db, draft, sourceIds);
    });
    // Wpisy dodane po przygotowaniu propozycji nie mogą zniknąć.
    const basedOn = new Set(proposal.basedOn);
    const addedMeanwhile = db.entries.filter((e) => !basedOn.has(e.id));
    const before = db.entries.length;
    db.entries = [...merged, ...addedMeanwhile];
    db.pendingConsolidation = null;
    return { before, after: db.entries.length };
  });
}

export async function rejectConsolidation() {
  await updateDb((db) => {
    db.pendingConsolidation = null;
  });
}

/** Usuwa materiał i wpisy, które pochodziły tylko z niego. */
export async function deleteSource(sourceId: string) {
  await backupDb("przed-usunieciem-materialu");
  return updateDb((db) => {
    const before = db.entries.length;
    db.entries = db.entries.flatMap((e) => {
      if (!e.sourceIds.includes(sourceId)) return [e];
      const rest = e.sourceIds.filter((s) => s !== sourceId);
      // Wpis znika tylko wtedy, gdy ten materiał był jego jedynym źródłem.
      return rest.length > 0 ? [{ ...e, sourceIds: rest }] : [];
    });
    db.sources = db.sources.filter((s) => s.id !== sourceId);
    return { removedEntries: before - db.entries.length };
  });
}
