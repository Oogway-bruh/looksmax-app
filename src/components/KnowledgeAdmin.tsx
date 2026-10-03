"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { METRIC_INFO, METRIC_KEYS, type MetricKey } from "@/lib/metrics";
import { AREAS, AREA_LABELS, VERDICTS, VERDICT_LABELS, type Area, type Database, type DraftEntry, type KnowledgeEntry } from "@/lib/schema";

type UploadStatus = { name: string; state: "waiting" | "working" | "done" | "error"; message?: string };

const EMPTY_DRAFT: DraftEntry = {
  area: "general",
  title: "",
  content: "",
  assessmentCriteria: "",
  metric: null,
  ranges: [],
  recommendations: [],
  priority: 3,
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `Błąd ${res.status}`);
  return json;
}

export function KnowledgeAdmin() {
  const [db, setDb] = useState<Database | null>(null);
  const [uploads, setUploads] = useState<UploadStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  const reload = useCallback(() => api<Database>("/api/knowledge").then(setDb), []);
  useEffect(() => {
    reload().catch((e) => setMessage(e.message));
  }, [reload]);

  async function uploadFiles(files: FileList) {
    const list = Array.from(files);
    setUploads(list.map((f) => ({ name: f.name, state: "waiting" })));
    setBusy("upload");
    for (const [i, file] of list.entries()) {
      const set = (s: Partial<UploadStatus>) => setUploads((u) => u.map((x, j) => (j === i ? { ...x, ...s } : x)));
      set({ state: "working" });
      try {
        const form = new FormData();
        form.append("file", file);
        const r = await api<{ created: number; notes: string }>("/api/knowledge/ingest", { method: "POST", body: form });
        set({ state: "done", message: `${r.created} wpisów${r.notes ? ` · uwagi: ${r.notes}` : ""}` });
      } catch (e) {
        set({ state: "error", message: (e as Error).message });
      }
      await reload();
    }
    setBusy(null);
  }

  async function runConsolidation() {
    if (!confirm("Uporządkować całą bazę? Duplikaty zostaną połączone. Kopia obecnej bazy trafi do data/backups.")) return;
    setBusy("consolidate");
    setMessage("Porządkowanie bazy… przy dużej bazie może to potrwać kilka minut.");
    try {
      const r = await api<{ before: number; after: number; changes: string[] }>("/api/knowledge/consolidate", { method: "POST" });
      setMessage(`Gotowe: ${r.before} → ${r.after} wpisów.\n${r.changes.map((c) => `• ${c}`).join("\n")}`);
      await reload();
    } catch (e) {
      setMessage((e as Error).message);
    }
    setBusy(null);
  }

  async function importFile(file: File) {
    if (!confirm("Zastąpić obecną bazę zawartością pliku? Kopia obecnej trafi do data/backups.")) return;
    try {
      await api("/api/knowledge/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: await file.text() });
      setMessage("Zaimportowano bazę.");
      await reload();
    } catch (e) {
      setMessage((e as Error).message);
    }
  }

  async function saveEntry(id: string | "new", draft: DraftEntry) {
    const url = id === "new" ? "/api/knowledge/entries" : `/api/knowledge/entries/${id}`;
    await api(url, { method: id === "new" ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
    setEditing(null);
    await reload();
  }

  async function deleteEntry(id: string) {
    if (!confirm(`Usunąć wpis ${id}?`)) return;
    await api(`/api/knowledge/entries/${id}`, { method: "DELETE" });
    await reload();
  }

  const grouped = useMemo(() => {
    const q = filter.toLowerCase();
    const matches = (db?.entries ?? []).filter(
      (e) => !q || `${e.id} ${e.title} ${e.content} ${e.recommendations.join(" ")}`.toLowerCase().includes(q),
    );
    return AREAS.map((area) => ({
      area,
      entries: matches.filter((e) => e.area === area).sort((a, b) => b.priority - a.priority),
    })).filter((g) => g.entries.length > 0);
  }, [db, filter]);

  const sourceName = new Map(db?.sources.map((s) => [s.id, s.filename]));

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6 space-y-4">
        <h2 className="text-lg font-semibold">1. Wgraj materiały</h2>
        <p className="text-sm text-neutral-400">
          Pliki .txt / .md, zdjęcia notatek lub grafik (.jpg, .png, .webp) i PDF-y. Każdy plik jest czytany, a zawarta w
          nim wiedza zamieniana na uporządkowane wpisy - bez dodawania czegokolwiek spoza Twojego materiału.
        </p>
        <input
          type="file"
          multiple
          accept=".txt,.md,.pdf,image/jpeg,image/png,image/webp,image/gif,text/plain,text/markdown,application/pdf"
          disabled={busy != null}
          onChange={(e) => e.target.files && uploadFiles(e.target.files)}
          className="block text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-sky-500 file:px-4 file:py-2 file:font-semibold file:text-neutral-950"
        />
        {uploads.length > 0 && (
          <ul className="space-y-1 text-sm">
            {uploads.map((u) => (
              <li key={u.name}>
                <span className="font-mono">{u.name}</span> -{" "}
                <span className={u.state === "error" ? "text-red-300" : u.state === "done" ? "text-emerald-300" : "text-neutral-400"}>
                  {{ waiting: "czeka", working: "przetwarzanie…", done: "gotowe", error: "błąd" }[u.state]}
                </span>
                {u.message && <span className="text-neutral-400"> · {u.message}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6 space-y-4">
        <h2 className="text-lg font-semibold">2. Uporządkuj bazę</h2>
        <p className="text-sm text-neutral-400">
          Łączy duplikaty z różnych materiałów, oznacza sprzeczności i ustawia priorytety, żeby baza składała się z
          kluczowych punktów. Uruchom po wgraniu nowej porcji materiałów.
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={runConsolidation}
            disabled={busy != null || !db?.entries.length}
            className="rounded-lg bg-sky-500 px-4 py-2 font-semibold text-neutral-950 disabled:opacity-50"
          >
            {busy === "consolidate" ? "Porządkowanie…" : "Uporządkuj bazę"}
          </button>
          <a href="/api/knowledge/export" className="rounded-lg border border-neutral-700 px-4 py-2">
            Eksport JSON
          </a>
          <label className="cursor-pointer rounded-lg border border-neutral-700 px-4 py-2">
            Import JSON
            <input type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          </label>
        </div>
        {message && <pre className="whitespace-pre-wrap rounded-lg bg-neutral-800/60 p-3 text-sm text-neutral-300">{message}</pre>}
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">Baza wiedzy ({db?.entries.length ?? 0} wpisów, {db?.sources.length ?? 0} materiałów)</h2>
          <input
            placeholder="Szukaj…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="ml-auto rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm"
          />
          <button onClick={() => setEditing("new")} className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm">
            + Dodaj wpis ręcznie
          </button>
        </div>
        {editing === "new" && <EntryEditor initial={EMPTY_DRAFT} onSave={(d) => saveEntry("new", d)} onCancel={() => setEditing(null)} />}
        {grouped.map(({ area, entries }) => (
          <div key={area}>
            <h3 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wide text-neutral-400">{AREA_LABELS[area]}</h3>
            <div className="space-y-2">
              {entries.map((e) =>
                editing === e.id ? (
                  <EntryEditor key={e.id} initial={e} onSave={(d) => saveEntry(e.id, d)} onCancel={() => setEditing(null)} />
                ) : (
                  <EntryCard
                    key={e.id}
                    entry={e}
                    sources={e.sourceIds.map((s) => sourceName.get(s) ?? s)}
                    onEdit={() => setEditing(e.id)}
                    onDelete={() => deleteEntry(e.id)}
                  />
                ),
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function EntryCard({ entry: e, sources, onEdit, onDelete }: { entry: KnowledgeEntry; sources: string[]; onEdit: () => void; onDelete: () => void }) {
  return (
    <details className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
      <summary className="cursor-pointer">
        <span className="mr-2 font-mono text-xs text-neutral-500">{e.id}</span>
        <span className="font-medium">{e.title}</span>
        <span className="ml-2 text-xs text-amber-300">{"★".repeat(Math.max(1, Math.min(5, Math.round(e.priority))))}</span>
        {e.metric && <span className="ml-2 rounded bg-sky-500/10 px-1.5 py-0.5 text-xs text-sky-300">{METRIC_INFO[e.metric].label}</span>}
      </summary>
      <div className="mt-3 space-y-2 text-sm text-neutral-300">
        <p className="whitespace-pre-wrap">{e.content}</p>
        {e.assessmentCriteria && (
          <p>
            <b>Jak oceniać:</b> {e.assessmentCriteria}
          </p>
        )}
        {e.ranges.length > 0 && (
          <ul className="font-mono text-xs">
            {e.ranges.map((r, i) => (
              <li key={i}>
                [{r.min ?? "−∞"}, {r.max ?? "∞"}) → {VERDICT_LABELS[r.verdict]} ({r.score}/10) {r.note}
              </li>
            ))}
          </ul>
        )}
        {e.recommendations.length > 0 && (
          <ul className="list-disc pl-5">
            {e.recommendations.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-neutral-500">Źródła: {sources.join(", ") || "ręcznie"}</p>
        <div className="flex gap-3">
          <button onClick={onEdit} className="text-sky-400">
            Edytuj
          </button>
          <button onClick={onDelete} className="text-red-400">
            Usuń
          </button>
        </div>
      </div>
    </details>
  );
}

function EntryEditor({ initial, onSave, onCancel }: { initial: DraftEntry; onSave: (d: DraftEntry) => Promise<void>; onCancel: () => void }) {
  const [d, setD] = useState<DraftEntry>({ ...EMPTY_DRAFT, ...initial });
  const [error, setError] = useState<string | null>(null);
  const field = "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm";
  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  return (
    <div className="space-y-3 rounded-xl border border-sky-500/40 bg-neutral-900 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <input className={`${field} sm:col-span-2`} placeholder="Tytuł" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
        <select className={field} value={d.area} onChange={(e) => setD({ ...d, area: e.target.value as Area })}>
          {AREAS.map((a) => (
            <option key={a} value={a}>
              {AREA_LABELS[a]}
            </option>
          ))}
        </select>
      </div>
      <textarea className={field} rows={4} placeholder="Treść / zasada" value={d.content} onChange={(e) => setD({ ...d, content: e.target.value })} />
      <textarea
        className={field}
        rows={2}
        placeholder="Jak oceniać na zdjęciu"
        value={d.assessmentCriteria}
        onChange={(e) => setD({ ...d, assessmentCriteria: e.target.value })}
      />
      <textarea
        className={field}
        rows={3}
        placeholder="Zalecenia - jedno w linii"
        value={d.recommendations.join("\n")}
        onChange={(e) => setD({ ...d, recommendations: e.target.value.split("\n") })}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Priorytet (1-5)
          <input type="number" min={1} max={5} className={field} value={d.priority} onChange={(e) => setD({ ...d, priority: Number(e.target.value) })} />
        </label>
        <label className="text-sm">
          Pomiar automatyczny
          <select
            className={field}
            value={d.metric ?? ""}
            onChange={(e) => setD({ ...d, metric: (e.target.value || null) as MetricKey | null })}
          >
            <option value="">— brak —</option>
            {METRIC_KEYS.map((k) => (
              <option key={k} value={k}>
                {METRIC_INFO[k].label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {d.metric && (
        <div className="space-y-2">
          <p className="text-xs text-neutral-400">Przedziały (od włącznie, do wyłącznie; puste = bez granicy)</p>
          {d.ranges.map((r, i) => {
            const setR = (patch: Partial<typeof r>) => setD({ ...d, ranges: d.ranges.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div key={i} className="grid grid-cols-6 gap-2">
                <input className={field} placeholder="od" value={r.min ?? ""} onChange={(e) => setR({ min: num(e.target.value) })} />
                <input className={field} placeholder="do" value={r.max ?? ""} onChange={(e) => setR({ max: num(e.target.value) })} />
                <select className={field} value={r.verdict} onChange={(e) => setR({ verdict: e.target.value as typeof r.verdict })}>
                  {VERDICTS.map((v) => (
                    <option key={v} value={v}>
                      {VERDICT_LABELS[v]}
                    </option>
                  ))}
                </select>
                <input className={field} type="number" placeholder="ocena" value={r.score} onChange={(e) => setR({ score: Number(e.target.value) })} />
                <input className={`${field} col-span-2`} placeholder="komentarz" value={r.note} onChange={(e) => setR({ note: e.target.value })} />
              </div>
            );
          })}
          <button
            onClick={() => setD({ ...d, ranges: [...d.ranges, { min: null, max: null, verdict: "average", score: 5, note: "" }] })}
            className="text-sm text-sky-400"
          >
            + przedział
          </button>
        </div>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
      <div className="flex gap-3">
        <button
          onClick={() =>
            onSave({ ...d, recommendations: d.recommendations.map((r) => r.trim()).filter(Boolean), ranges: d.metric ? d.ranges : [] }).catch((e) =>
              setError(e.message),
            )
          }
          className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-neutral-950"
        >
          Zapisz
        </button>
        <button onClick={onCancel} className="rounded-lg border border-neutral-700 px-4 py-2 text-sm">
          Anuluj
        </button>
      </div>
    </div>
  );
}
