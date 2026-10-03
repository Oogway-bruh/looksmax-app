"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { METRIC_INFO, METRIC_KEYS, type MetricKey } from "@/lib/metrics";
import { VERDICTS, VERDICT_LABELS, categoryName, type Category, type Database, type DraftEntry, type KnowledgeEntry, type SynthesisProposal } from "@/lib/schema";

type JobState = { status: "running" | "done" | "error"; startedAt: string; stage: string; outputChars: number; error?: string };
type AdminData = Database & { job: JobState | null; apiKeyConfigured: boolean };
type UploadStatus = { name: string; state: "waiting" | "working" | "done" | "error"; message?: string };

const UPLOAD_CONCURRENCY = 3;
const ACCEPT = ".txt,.md,.csv,.json,.docx,.pdf,.jpg,.jpeg,.png,.webp,text/*,image/jpeg,image/png,image/webp,application/pdf";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 401) {
    window.location.href = "/login?next=/admin";
    throw new Error("Sesja wygasła - zaloguj się ponownie.");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Błąd ${res.status}`);
  return json;
}

/** Duże zdjęcia zmniejszamy w przeglądarce (limit API to 5 MB na obraz; 2400 px wystarcza do odczytu notatek). */
async function prepareFile(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!bitmap) return file;
  const maxSide = 2400;
  if (file.size < 3.5 * 1024 * 1024 && Math.max(bitmap.width, bitmap.height) <= maxSide) return file;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
  if (!blob) return file;
  return new File([blob], file.name.replace(/\.(png|webp|jpeg)$/i, ".jpg"), { type: "image/jpeg" });
}

const formatSize = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const KIND_LABEL = { text: "tekst", image: "obraz", pdf: "PDF" } as const;

const card = "rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6 space-y-4";
const button = "rounded-lg bg-sky-500 px-4 py-2 font-semibold text-neutral-950 hover:bg-sky-400 disabled:opacity-50";
const ghost = "rounded-lg border border-neutral-700 px-4 py-2 hover:bg-neutral-800 disabled:opacity-50";

const EMPTY_DRAFT: DraftEntry = { area: "", title: "", content: "", assessmentCriteria: "", metric: null, ranges: [], recommendations: [], priority: 3 };

export function KnowledgeAdmin() {
  const [db, setDb] = useState<AdminData | null>(null);
  const [uploads, setUploads] = useState<UploadStatus[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => api<AdminData>("/api/knowledge").then(setDb), []);
  useEffect(() => {
    reload().catch((e) => setMessage(e.message));
  }, [reload]);

  // Podczas analizy materiałów odświeżamy postęp co 2 s.
  const running = db?.job?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => reload().catch(() => undefined), 2000);
    return () => clearInterval(t);
  }, [running, reload]);

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setUploads(files.map((f) => ({ name: f.name, state: "waiting" })));
    setUploading(true);
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const i = next++;
        const set = (s: Partial<UploadStatus>) => setUploads((u) => u.map((x, j) => (j === i ? { ...x, ...s } : x)));
        set({ state: "working" });
        try {
          const form = new FormData();
          form.append("file", await prepareFile(files[i]));
          await api("/api/knowledge/sources", { method: "POST", body: form });
          set({ state: "done" });
        } catch (e) {
          set({ state: "error", message: (e as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker));
    setUploading(false);
    await reload();
  }

  async function action(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage(done);
      await reload();
    } catch (e) {
      setMessage((e as Error).message);
    }
    setBusy(false);
  }

  const startSynthesis = () => action(() => api("/api/knowledge/synthesize", { method: "POST" }));
  const decide = (accept: boolean) =>
    action(
      () => api("/api/knowledge/synthesize", { method: accept ? "PUT" : "DELETE" }),
      accept ? "Zatwierdzono. Analiza twarzy korzysta teraz z nowego systemu oceny. Kopia poprzedniej bazy jest w data/backups." : "Propozycja odrzucona - baza bez zmian.",
    );

  async function deleteSource(id: string, name: string) {
    if (!confirm(`Usunąć materiał „${name}”? Wpisy, które pochodzą tylko z niego, też znikną.`)) return;
    await action(() => api(`/api/knowledge/sources/${id}`, { method: "DELETE" }));
  }

  async function importFile(file: File) {
    if (!confirm("Zastąpić obecne wpisy i kategorie zawartością pliku? Kopia obecnej bazy trafi do data/backups.")) return;
    await action(async () => api("/api/knowledge/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: await file.text() }), "Zaimportowano bazę.");
  }

  async function saveEntry(id: string | "new", draft: DraftEntry) {
    const url = id === "new" ? "/api/knowledge/entries" : `/api/knowledge/entries/${id}`;
    await api(url, { method: id === "new" ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
    setEditing(null);
    await reload();
  }

  async function deleteEntry(id: string) {
    if (!confirm(`Usunąć wpis ${id}?`)) return;
    await action(() => api(`/api/knowledge/entries/${id}`, { method: "DELETE" }));
  }

  async function saveCategories(categories: Category[]) {
    await action(() => api("/api/knowledge/categories", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(categories) }), "Zapisano kategorie.");
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/";
  }

  const grouped = useMemo(() => {
    if (!db) return [];
    const q = filter.toLowerCase();
    const matches = db.entries.filter((e) => !q || `${e.id} ${e.title} ${e.content} ${e.recommendations.join(" ")}`.toLowerCase().includes(q));
    const order = [...new Set([...db.categories.map((c) => c.id), ...db.entries.map((e) => e.area)])];
    return order
      .map((area) => ({ area, name: categoryName(db.categories, area), entries: matches.filter((e) => e.area === area).sort((a, b) => b.priority - a.priority) }))
      .filter((g) => g.entries.length > 0);
  }, [db, filter]);

  if (!db) return <p className="text-neutral-400">Wczytywanie…</p>;

  const sourceName = new Map(db.sources.map((s) => [s.id, s.filename]));
  const analyzedIds = new Set(db.framework?.sourceIds ?? []);
  const newSources = db.sources.filter((s) => !analyzedIds.has(s.id));
  const removedSinceAnalysis = (db.framework?.sourceIds ?? []).filter((id) => !db.sources.some((s) => s.id === id)).length;
  const materialsChanged = db.sources.length > 0 && (newSources.length > 0 || removedSinceAnalysis > 0);
  const pending = db.pendingSynthesis;

  return (
    <div className="space-y-8">
      <div className="flex justify-end">
        <button onClick={logout} className="text-sm text-neutral-500 hover:text-neutral-300">
          Wyloguj
        </button>
      </div>

      {!db.apiKeyConfigured && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
          <b>Brak klucza API Anthropic.</b> Bez niego aplikacja nie przeanalizuje materiałów ani twarzy. Dopisz w pliku <code>.env.local</code> linię{" "}
          <code>ANTHROPIC_API_KEY=sk-ant-…</code> i uruchom aplikację ponownie (Ctrl+C, potem <code>npm run dev</code>).
        </div>
      )}

      <section className={card}>
        <h2 className="text-lg font-semibold">1. Twoje materiały</h2>
        <p className="text-sm text-neutral-400">
          Wrzuć wszystko, z czego ma korzystać ocena: notatki, poradniki, zrzuty ekranu, zdjęcia kartek, tabele, PDF-y, pliki Word i tekstowe. Możesz zaznaczyć wiele
          plików naraz albo przeciągnąć je tutaj. Pliki są przechowywane w całości.
        </p>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            uploadFiles(Array.from(e.dataTransfer.files));
          }}
          onClick={() => fileInput.current?.click()}
          className={`cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition ${dragOver ? "border-sky-400 bg-sky-500/10" : "border-neutral-700 hover:border-sky-500/60"}`}
        >
          <p className="font-medium">{uploading ? "Wgrywanie…" : "Kliknij albo przeciągnij pliki"}</p>
          <p className="mt-1 text-xs text-neutral-500">.txt .md .csv .docx .pdf .jpg .png .webp</p>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              uploadFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </div>
        {uploads.some((u) => u.state !== "done") && (
          <ul className="space-y-1 text-sm">
            {uploads
              .filter((u) => u.state !== "done")
              .map((u, i) => (
                <li key={`${u.name}-${i}`}>
                  <span className="font-mono">{u.name}</span> -{" "}
                  <span className={u.state === "error" ? "text-red-300" : "text-neutral-400"}>{{ waiting: "czeka", working: "wgrywanie…", done: "", error: "błąd" }[u.state]}</span>
                  {u.message && <span className="text-red-300"> · {u.message}</span>}
                </li>
              ))}
          </ul>
        )}
        {db.sources.length > 0 && (
          <ul className="divide-y divide-neutral-800 text-sm">
            {db.sources.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <a href={`/api/knowledge/sources/${s.id}`} target="_blank" className="font-mono hover:text-sky-300">
                    {s.filename}
                  </a>
                  <span className="ml-2 text-xs text-neutral-500">
                    {KIND_LABEL[s.kind]} · {formatSize(s.size)}
                    {analyzedIds.has(s.id) ? ` · ${s.entryCount} wpisów` : ""}
                  </span>
                  {!analyzedIds.has(s.id) && <span className="ml-2 rounded bg-sky-500/15 px-1.5 py-0.5 text-xs text-sky-300">nowy - jeszcze nieprzeanalizowany</span>}
                  {s.notes && <p className="text-xs text-amber-300/80">Uwagi: {s.notes}</p>}
                </div>
                <button onClick={() => deleteSource(s.id, s.filename)} disabled={busy || running} className="shrink-0 text-red-400 hover:text-red-300 disabled:opacity-40">
                  Usuń
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={card}>
        <h2 className="text-lg font-semibold">2. Analiza materiałów</h2>
        <p className="text-sm text-neutral-400">
          Claude czyta <b>wszystkie</b> materiały naraz, w całości, i buduje z nich Twój system oceny: Twoje kategorie i ich wagi, wszystkie zasady, progi, kryteria i
          zalecenia, sprzeczności między materiałami oraz to, czego brakuje. Bez dodawania wiedzy spoza materiałów. Ręczne poprawki wpisów są zachowywane. Przy dużej
          ilości materiałów może to potrwać kilka-kilkanaście minut.
        </p>
        {materialsChanged && !pending && !running && db.framework && (
          <p className="rounded-lg bg-sky-500/10 p-3 text-sm text-sky-200">Materiały zmieniły się od ostatniej analizy - uruchom ją ponownie, żeby baza je uwzględniła.</p>
        )}
        {!running && !pending && (
          <button onClick={startSynthesis} disabled={busy || db.sources.length === 0 || !db.apiKeyConfigured} className={button}>
            Przeanalizuj wszystkie materiały ({db.sources.length})
          </button>
        )}
        {db.job && db.job.status !== "done" && <JobView job={db.job} />}
        {pending && <ProposalView proposal={pending} db={db} busy={busy} onDecide={decide} />}
        {message && <pre className="whitespace-pre-wrap rounded-lg bg-neutral-800/60 p-3 text-sm text-neutral-300">{message}</pre>}
      </section>

      {db.framework && <FrameworkView db={db} onSaveCategories={saveCategories} busy={busy} />}

      {db.entries.length > 0 && <Coverage db={db} />}

      <section className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">Wpisy bazy ({db.entries.length})</h2>
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
        {db.entries.length === 0 && <p className="text-sm text-neutral-500">Wpisy pojawią się po analizie materiałów (krok 2).</p>}
        {editing === "new" && (
          <EntryEditor
            initial={{ ...EMPTY_DRAFT, area: db.categories[0]?.id ?? "ogolne" }}
            categories={db.categories}
            onSave={(d) => saveEntry("new", d)}
            onCancel={() => setEditing(null)}
          />
        )}
        {grouped.map(({ area, name, entries }) => (
          <div key={area}>
            <h3 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wide text-neutral-400">
              {name} ({entries.length})
            </h3>
            <div className="space-y-2">
              {entries.map((e) =>
                editing === e.id ? (
                  <EntryEditor key={e.id} initial={e} categories={db.categories} onSave={(d) => saveEntry(e.id, d)} onCancel={() => setEditing(null)} />
                ) : (
                  <EntryCard key={e.id} entry={e} sources={e.sourceIds.map((s) => sourceName.get(s) ?? s)} onEdit={() => setEditing(e.id)} onDelete={() => deleteEntry(e.id)} />
                ),
              )}
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-3 pt-4 text-sm">
          <a href="/api/knowledge/export" className={ghost}>
            Eksport bazy (JSON)
          </a>
          <label className={`${ghost} cursor-pointer`}>
            Import bazy (JSON)
            <input type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          </label>
        </div>
      </section>
    </div>
  );
}

function JobView({ job }: { job: JobState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (job.status === "error") {
    return <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-300">Analiza materiałów nie powiodła się: {job.error}</p>;
  }
  const secs = Math.max(0, Math.round((now - new Date(job.startedAt).getTime()) / 1000));
  return (
    <div className="space-y-3 rounded-xl border border-sky-500/40 bg-sky-500/5 p-4 text-sm">
      <div className="h-1.5 overflow-hidden rounded bg-neutral-800">
        <div className="h-full w-1/3 animate-pulse rounded bg-sky-500" />
      </div>
      <p>{job.stage}</p>
      <p className="text-xs text-neutral-400">
        Czas: {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
        {job.outputChars > 0 && ` · zapisano już ok. ${Math.round(job.outputChars / 1000)} tys. znaków systemu oceny`}
        {" · "}możesz zostawić tę stronę otwartą albo wrócić później.
      </p>
    </div>
  );
}

function ProposalView({ proposal, db, busy, onDecide }: { proposal: SynthesisProposal; db: Database; busy: boolean; onDecide: (accept: boolean) => void }) {
  const syn = proposal.synthesis;
  const kept = db.entries.filter((e) => e.manual && !syn.entries.some((x) => x.fromManual.includes(e.id))).length;
  return (
    <div className="space-y-4 rounded-xl border border-sky-500/40 bg-sky-500/5 p-4 text-sm">
      <p className="text-base font-semibold">
        Propozycja systemu oceny: {syn.categories.length} kategorii, {syn.entries.length} wpisów
        <span className="ml-2 text-sm font-normal text-neutral-400">
          (obecnie {proposal.basedOn.length} wpisów{proposal.materialTokens ? ` · materiały: ${Math.round(proposal.materialTokens / 1000)} tys. tokenów` : ""}
          {proposal.mode === "batched" ? " · czytane w częściach" : ""})
        </span>
      </p>
      <div>
        <p className="mb-1 font-medium text-neutral-200">Jak oceniasz wygląd (wg materiałów)</p>
        <p className="whitespace-pre-wrap text-neutral-300">{syn.framework.summary}</p>
        {syn.framework.scoringNotes && <p className="mt-2 whitespace-pre-wrap text-neutral-400">{syn.framework.scoringNotes}</p>}
      </div>
      <div>
        <p className="mb-1 font-medium text-neutral-200">Kategorie</p>
        <ul className="grid gap-1 sm:grid-cols-2">
          {syn.categories.map((c) => (
            <li key={c.id} className="text-neutral-300">
              <b>{c.name}</b> <span className="text-neutral-500">· waga {c.weight}/5 · {syn.entries.filter((e) => e.area === c.id).length} wpisów</span>
            </li>
          ))}
        </ul>
      </div>
      <ListBlock title="Sprzeczności między materiałami" items={syn.contradictions} tone="amber" />
      <ListBlock title="Czego brakuje w materiałach" items={syn.gaps} tone="neutral" />
      <ListBlock title="Nieczytelne pliki / fragmenty" items={syn.unreadable} tone="amber" />
      <details>
        <summary className="cursor-pointer text-neutral-300">Podgląd wszystkich wpisów ({syn.entries.length})</summary>
        <div className="mt-3 space-y-3">
          {syn.categories.map((c) => {
            const list = syn.entries.filter((e) => e.area === c.id);
            if (!list.length) return null;
            return (
              <div key={c.id}>
                <p className="text-xs font-semibold uppercase text-neutral-500">{c.name}</p>
                <ul className="mt-1 space-y-1">
                  {list.map((e, i) => (
                    <li key={i} className="text-neutral-300">
                      <b>{e.title}</b> <span className="text-neutral-500">- {e.content.slice(0, 160)}{e.content.length > 160 ? "…" : ""}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </details>
      {kept > 0 && <p className="text-neutral-400">{kept} ręcznie poprawionych wpisów zostanie zachowanych bez zmian.</p>}
      <div className="flex gap-3">
        <button onClick={() => onDecide(true)} disabled={busy} className={button}>
          Zatwierdź i używaj w analizie
        </button>
        <button onClick={() => onDecide(false)} disabled={busy} className={ghost}>
          Odrzuć
        </button>
      </div>
    </div>
  );
}

function ListBlock({ title, items, tone }: { title: string; items: string[]; tone: "amber" | "neutral" }) {
  if (!items.length) return null;
  return (
    <div>
      <p className={`mb-1 font-medium ${tone === "amber" ? "text-amber-300" : "text-neutral-200"}`}>
        {title} ({items.length})
      </p>
      <ul className="list-disc space-y-1 pl-5 text-neutral-400">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

/** Zatwierdzony system oceny + edycja kategorii (nazwa, waga). */
function FrameworkView({ db, onSaveCategories, busy }: { db: Database; onSaveCategories: (c: Category[]) => void; busy: boolean }) {
  const f = db.framework!;
  const [cats, setCats] = useState(db.categories);
  useEffect(() => setCats(db.categories), [db.categories]);
  const changed = JSON.stringify(cats) !== JSON.stringify(db.categories);
  return (
    <section className={card}>
      <h2 className="text-lg font-semibold">Twój system oceny</h2>
      <p className="text-xs text-neutral-500">Z analizy materiałów z {new Date(f.analyzedAt).toLocaleString("pl-PL")}. Tego używa analiza twarzy.</p>
      <p className="whitespace-pre-wrap text-sm text-neutral-300">{f.summary}</p>
      {f.scoringNotes && <p className="whitespace-pre-wrap text-sm text-neutral-400">{f.scoringNotes}</p>}
      <div className="space-y-2">
        <p className="text-sm font-medium">Kategorie i ich waga w ocenie ogólnej</p>
        {cats.map((c, i) => (
          <div key={c.id} className="flex items-center gap-3 text-sm">
            <input
              value={c.name}
              onChange={(e) => setCats(cats.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              className="flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-1.5"
            />
            <span className="text-xs text-neutral-500">{db.entries.filter((e) => e.area === c.id).length} wpisów</span>
            <select
              value={c.weight}
              onChange={(e) => setCats(cats.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)))}
              className="rounded-lg border border-neutral-700 bg-neutral-950 px-2 py-1.5"
            >
              {[1, 2, 3, 4, 5].map((w) => (
                <option key={w} value={w}>
                  waga {w}
                </option>
              ))}
            </select>
          </div>
        ))}
        {changed && (
          <button onClick={() => onSaveCategories(cats)} disabled={busy} className={button}>
            Zapisz kategorie
          </button>
        )}
      </div>
      <ListBlock title="Sprzeczności w materiałach" items={f.contradictions} tone="amber" />
      <ListBlock title="Co warto uzupełnić w materiałach" items={f.gaps} tone="neutral" />
    </section>
  );
}

/** Pokrycie: które pomiary mają progi, którym wpisom brakuje kryteriów/zaleceń. */
function Coverage({ db }: { db: Database }) {
  const metricsWithRules = new Set(db.entries.filter((e) => e.metric && e.ranges.length).map((e) => e.metric!));
  const noCriteria = db.entries.filter((e) => !e.assessmentCriteria && !(e.metric && e.ranges.length)).length;
  const noRecs = db.entries.filter((e) => e.recommendations.length === 0).length;
  return (
    <section className={card}>
      <h2 className="text-lg font-semibold">Pomiary automatyczne</h2>
      <p className="text-sm text-neutral-400">
        Pomiary z progami w bazie: <b className="text-neutral-200">{metricsWithRules.size}</b> / {METRIC_KEYS.length}. Gdy materiały podają progi liczbowe dla
        mierzonej cechy, wynik liczy kod - najbardziej powtarzalnie. Pozostałe cechy Claude ocenia na zdjęciu wg Twoich kryteriów.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {METRIC_KEYS.map((k) => (
          <span
            key={k}
            title={METRIC_INFO[k].description}
            className={`rounded px-1.5 py-0.5 text-xs ${metricsWithRules.has(k) ? "bg-emerald-500/15 text-emerald-300" : "bg-neutral-800 text-neutral-500"}`}
          >
            {METRIC_INFO[k].label}
          </span>
        ))}
      </div>
      {noCriteria > 0 && <p className="text-sm text-amber-300/90">{noCriteria} wpisów nie ma kryteriów oceny - zostaną ocenione tylko na podstawie samej zasady.</p>}
      {noRecs > 0 && <p className="text-sm text-amber-300/90">{noRecs} wpisów nie ma zaleceń - przy słabym wyniku raport nie podpowie, co zmienić.</p>}
    </section>
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
        {e.manual && <span className="ml-2 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-300">poprawione ręcznie</span>}
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

function EntryEditor({
  initial,
  categories,
  onSave,
  onCancel,
}: {
  initial: DraftEntry;
  categories: Category[];
  onSave: (d: DraftEntry) => Promise<void>;
  onCancel: () => void;
}) {
  const [d, setD] = useState<DraftEntry>({ ...EMPTY_DRAFT, ...initial });
  const [error, setError] = useState<string | null>(null);
  const field = "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm";
  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  return (
    <div className="space-y-3 rounded-xl border border-sky-500/40 bg-neutral-900 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <input className={`${field} sm:col-span-2`} placeholder="Tytuł" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
        <select className={field} value={d.area} onChange={(e) => setD({ ...d, area: e.target.value })}>
          {(categories.length ? categories : [{ id: "ogolne", name: "Ogólne" }]).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
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
