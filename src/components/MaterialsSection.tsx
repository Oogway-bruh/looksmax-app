"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ACCEPT_ATTR, buildTree, countFiles, type TreeNode } from "@/lib/file-types";
import { classify, entriesFromDrop, filesFromEntries, filesFromInput, hashFile, prepareForUpload, uploadRoots, type PickedFile, type Skipped } from "@/lib/folder-upload";
import type { KnowledgeSource } from "@/lib/schema";

const UPLOAD_CONCURRENCY = 4;
const KIND_LABEL = { text: "tekst", image: "obraz", pdf: "PDF" } as const;
const formatSize = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export type SourceState = "new" | "changed" | "ok";

type Summary = {
  added: number;
  updated: number;
  unchanged: number;
  moved: number;
  duplicates: { path: string; of: string }[];
  errors: { path: string; message: string }[];
  skipped: Skipped[];
  notes: { path: string; note: string }[];
  junk: number;
  removedStale: number;
};

const emptySummary = (): Summary => ({ added: 0, updated: 0, unchanged: 0, moved: 0, duplicates: [], errors: [], skipped: [], notes: [], junk: 0, removedStale: 0 });

class SessionExpired extends Error {}

async function postJson<T>(url: string, body: unknown, method = "POST"): Promise<T> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 401) throw new SessionExpired();
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Błąd ${res.status}`);
  return json as T;
}

export function MaterialsSection({
  sources,
  stateOf,
  disabled,
  onChanged,
  onBusyChange,
}: {
  sources: KnowledgeSource[];
  stateOf: (s: KnowledgeSource) => SourceState;
  disabled: boolean;
  onChanged: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [phase, setPhase] = useState<"idle" | "collecting" | "hashing" | "uploading" | "finishing" | "deleting">("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetFolder, setTargetFolder] = useState("");

  // Atrybut wyboru folderu nie jest w typach Reacta - ustawiamy go ręcznie.
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
    folderInput.current?.setAttribute("directory", "");
  }, []);

  useEffect(() => onBusyChange(phase !== "idle"), [phase, onBusyChange]);

  // Ostrzeżenie przed zamknięciem karty w trakcie wgrywania.
  useEffect(() => {
    if (phase === "idle") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  const refresh = async () => {
    try {
      await onChanged();
    } catch {
      // Odświeżenie listy nie powiodło się (np. wygasła sesja) - komunikat pokazuje panel.
    }
  };

  /**
   * Wgranie: 1) skróty oryginałów, 2) zapytanie serwera, co już jest (pomijamy niezmienione i przeniesione),
   * 3) wysłanie reszty, 4) przy wgraniu folderu - przeniesienia i pytanie o pliki usunięte z folderu.
   */
  async function upload(picked: PickedFile[], opts: { folderMode: boolean; failed?: Skipped[] }) {
    setError(null);
    const { accepted, skipped, junk } = classify(picked);
    const result: Summary = { ...emptySummary(), skipped: [...(opts.failed ?? []), ...skipped], junk };
    setSummary({ ...result });
    if (accepted.length === 0) {
      setPhase("idle");
      if (picked.length === 0) setError("Nie znaleziono plików. Jeśli przeciągasz folder, upuść go na pole poniżej albo użyj przycisku „Wybierz folder”.");
      return;
    }
    try {
      // 1) Skróty oryginałów.
      setPhase("hashing");
      setProgress({ done: 0, total: accepted.length, current: "" });
      const hashes = new Array<string | null>(accepted.length);
      let next = 0;
      let done = 0;
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, accepted.length) }, async () => {
          while (next < accepted.length) {
            const i = next++;
            hashes[i] = await hashFile(accepted[i].file);
            setProgress({ done: ++done, total: accepted.length, current: accepted[i].path });
          }
        }),
      );

      // 2) Co już jest na serwerze.
      const known = accepted.map((f, i) => ({ path: f.path, hash: hashes[i] })).filter((f): f is { path: string; hash: string } => Boolean(f.hash));
      let check = { unchanged: [] as string[], duplicates: [] as { path: string; of: string }[], moves: [] as { from: string; to: string }[] };
      if (known.length) check = await postJson("/api/knowledge/sources/check", { files: known });
      const skip = new Set([...check.unchanged, ...check.duplicates.map((d) => d.path), ...(opts.folderMode ? check.moves.map((m) => m.to) : [])]);
      result.unchanged = check.unchanged.length;
      result.duplicates = check.duplicates;
      const toSend = accepted.map((f, i) => ({ ...f, hash: hashes[i] })).filter((f) => !skip.has(f.path));

      // 3) Wysłanie nowych i zmienionych. Najpierw nowe wersje plików już w bazie - inaczej kopia starej treści
      // w innym miejscu folderu zostałaby uznana za duplikat pliku, który za chwilę się zmieni.
      setPhase("uploading");
      setProgress({ done: 0, total: toSend.length, current: "" });
      done = 0;
      let expired = false;
      const inDb = new Set(sources.map((s) => s.path));
      const sendAll = (list: typeof toSend) => {
        let next = 0;
        return Promise.all(
          Array.from({ length: Math.min(UPLOAD_CONCURRENCY, list.length) }, async () => {
            while (next < list.length && !expired) {
              const item = list[next++];
              setProgress((p) => ({ ...p, current: item.path }));
              try {
                const prepared = await prepareForUpload(item);
                const form = new FormData();
                form.append("file", prepared.file);
                form.append("path", prepared.path);
                if (item.hash) form.append("originalHash", item.hash);
                const res = await fetch("/api/knowledge/sources", { method: "POST", body: form });
                const json = await res.json().catch(() => ({}));
                if (res.status === 401) expired = true;
                else if (!res.ok) result.errors.push({ path: item.path, message: json.error ?? `Błąd ${res.status}` });
                else {
                  if (json.status === "added") result.added++;
                  else if (json.status === "updated") result.updated++;
                  else if (json.status === "unchanged") result.unchanged++;
                  else if (json.status === "duplicate") result.duplicates.push({ path: item.path, of: json.duplicateOf });
                  if (json.notes) result.notes.push({ path: item.path, note: json.notes });
                }
              } catch (e) {
                result.errors.push({ path: item.path, message: e instanceof Error ? e.message : "Nie udało się przygotować pliku" });
              }
              setProgress((p) => ({ ...p, done: ++done }));
              setSummary({ ...result, duplicates: [...result.duplicates], errors: [...result.errors] });
            }
          }),
        );
      };
      await sendAll(toSend.filter((f) => inDb.has(f.path)));
      await sendAll(toSend.filter((f) => !inDb.has(f.path)));
      if (expired) throw new SessionExpired();

      // 4) Folder: przeniesienia + pliki, których nie ma już w folderze.
      if (opts.folderMode) {
        setPhase("finishing");
        const roots = uploadRoots(accepted);
        const rec = await postJson<{ moved: number; stale: { id: string; path: string }[] }>("/api/knowledge/sources/reconcile", {
          roots,
          uploaded: accepted.map((f) => f.path),
          moves: check.moves,
        });
        result.moved = rec.moved;
        if (rec.stale.length) {
          const list = rec.stale.slice(0, 12).map((s) => `• ${s.path}`).join("\n");
          const ok = confirm(
            `W bazie jest ${rec.stale.length} plików z folderu „${roots.join("”, „")}”, których nie ma w wgranej wersji folderu (usunięte lub przeniesione poza ten folder):\n\n${list}${rec.stale.length > 12 ? "\n…" : ""}\n\nUsunąć je z bazy? (Anuluj = zostaw)`,
          );
          if (ok) {
            const del = await postJson<{ removedFiles: number }>("/api/knowledge/sources", { ids: rec.stale.map((s) => s.id) }, "DELETE");
            result.removedStale = del.removedFiles;
          }
        }
      }
    } catch (e) {
      setError(
        e instanceof SessionExpired
          ? "Sesja wygasła - zaloguj się ponownie i wgraj folder jeszcze raz (już wgrane pliki zostaną rozpoznane i pominięte)."
          : `Wgrywanie przerwane: ${e instanceof Error ? e.message : "nieznany błąd"}`,
      );
    } finally {
      setSummary({ ...result });
      setPhase("idle");
      await refresh();
    }
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (disabled || phase !== "idle") return;
    // Wpisy trzeba pobrać synchronicznie - po pierwszym await lista elementów przeciągania wygasa.
    const { entries, files } = entriesFromDrop(e.dataTransfer);
    setPhase("collecting");
    try {
      if (entries.length) {
        const folderMode = entries.some((en) => en.isDirectory);
        const { files: picked, failed } = await filesFromEntries(entries, folderMode ? "" : targetFolder);
        await upload(picked, { folderMode, failed });
      } else {
        await upload(
          files.map((file) => ({ file, path: targetFolder ? `${targetFolder}/${file.name}` : file.name })),
          { folderMode: false },
        );
      }
    } catch {
      setPhase("idle");
      setError("Nie udało się odczytać przeciągniętych plików. Użyj przycisku „Wybierz folder”.");
    }
  }

  async function remove(label: string, run: () => Promise<Response>) {
    setPhase("deleting");
    setError(null);
    try {
      const res = await run();
      if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? `Nie udało się usunąć: ${label}`);
    } catch {
      setError(`Nie udało się usunąć: ${label}`);
    }
    setPhase("idle");
    await refresh();
  }

  const deleteFolder = (path: string, count: number) => {
    if (!confirm(`Usunąć folder „${path}” (${count} plików)? Wpisy, które pochodzą tylko z tych plików, też znikną.`)) return;
    remove(path, () => fetch(`/api/knowledge/sources?folder=${encodeURIComponent(path)}`, { method: "DELETE" }));
  };
  const deleteFile = (id: string, path: string) => {
    if (!confirm(`Usunąć „${path}”? Wpisy, które pochodzą tylko z tego pliku, też znikną.`)) return;
    remove(path, () => fetch(`/api/knowledge/sources/${id}`, { method: "DELETE" }));
  };

  const busy = disabled || phase !== "idle";
  const tree = useMemo(() => buildTree(sources.map((s) => ({ id: s.id, path: s.path }))), [sources]);
  const byId = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const folders = useMemo(() => {
    const out: string[] = [];
    const walk = (n: TreeNode) => n.folders.forEach((f) => (out.push(f.path), walk(f)));
    walk(tree);
    return out;
  }, [tree]);
  const totalSize = sources.reduce((n, s) => n + s.size, 0);
  const phaseText = { collecting: "Odczytywanie folderów…", hashing: "Sprawdzanie plików", uploading: "Wgrywanie", finishing: "Porządkowanie…", deleting: "Usuwanie…", idle: "" }[phase];

  return (
    <section className="space-y-4 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6">
      <h2 className="text-lg font-semibold">1. Twoje materiały</h2>
      <p className="text-sm text-neutral-400">
        Wgraj <b>cały folder</b> z wiedzą - ze wszystkimi podfolderami. Układ folderów jest zachowany i traktowany jako część wiedzy (foldery = Twoje tematy i
        kategorie). Obsługiwane: tekst (.txt, .md, .csv, .rtf…), Word, PowerPoint, Excel (także z obrazami w środku), PDF, zdjęcia i zrzuty ekranu (.jpg, .png,
        .webp, .heic, .gif). Ponowne wgranie folderu wyśle tylko nowe i zmienione pliki, rozpozna przeniesione i zapyta o usunięte.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition ${dragOver ? "border-sky-400 bg-sky-500/10" : "border-neutral-700"} ${busy ? "opacity-60" : ""}`}
      >
        <p className="font-medium">{phase === "collecting" ? "Odczytywanie folderów…" : "Przeciągnij tutaj folder (albo pliki)"}</p>
        <p className="mt-1 text-xs text-neutral-500">albo</p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => folderInput.current?.click()}
            className="rounded-lg bg-sky-500 px-4 py-2 font-semibold text-neutral-950 hover:bg-sky-400 disabled:opacity-50"
          >
            Wybierz folder
          </button>
          <button type="button" disabled={busy} onClick={() => filesInput.current?.click()} className="rounded-lg border border-neutral-700 px-4 py-2 hover:bg-neutral-800 disabled:opacity-50">
            Wybierz pliki
          </button>
          {folders.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-neutral-400">
              pojedyncze pliki do:
              <select value={targetFolder} onChange={(e) => setTargetFolder(e.target.value)} className="max-w-56 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-200">
                <option value="">(folder główny)</option>
                {folders.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <input
          ref={folderInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const picked = filesFromInput(e.target.files);
            e.target.value = "";
            upload(picked, { folderMode: true });
          }}
        />
        <input
          ref={filesInput}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => {
            const picked = filesFromInput(e.target.files, targetFolder);
            e.target.value = "";
            upload(picked, { folderMode: false });
          }}
        />
      </div>

      {(phase === "hashing" || phase === "uploading") && (
        <div className="space-y-2 text-sm">
          <div className="h-2 overflow-hidden rounded bg-neutral-800">
            <div className="h-full bg-sky-500 transition-all" style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} />
          </div>
          <p className="truncate text-neutral-400">
            {phaseText} {progress.done}/{progress.total} · <span className="font-mono text-xs">{progress.current}</span>
          </p>
        </div>
      )}
      {(phase === "finishing" || phase === "deleting") && <p className="text-sm text-neutral-400">{phaseText}</p>}

      {summary && phase === "idle" && <UploadSummary summary={summary} />}
      {error && <p className="whitespace-pre-wrap rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}

      {sources.length > 0 && (
        <div className="space-y-1 text-sm">
          <p className="text-neutral-400">
            {sources.length} plików · {formatSize(totalSize)}
          </p>
          <FolderView node={tree} byId={byId} stateOf={stateOf} depth={0} busy={busy} onDeleteFolder={deleteFolder} onDeleteFile={deleteFile} />
        </div>
      )}
    </section>
  );
}

function UploadSummary({ summary: s }: { summary: Summary }) {
  const parts = [
    s.added && `dodano ${s.added}`,
    s.updated && `zaktualizowano ${s.updated}`,
    s.moved && `przeniesiono ${s.moved}`,
    s.unchanged && `bez zmian ${s.unchanged}`,
    s.duplicates.length && `duplikaty ${s.duplicates.length}`,
    s.removedStale && `usunięto ${s.removedStale}`,
    s.skipped.length && `pominięto ${s.skipped.length}`,
    s.errors.length && `błędy ${s.errors.length}`,
  ].filter(Boolean);
  return (
    <div className="space-y-2 rounded-lg bg-neutral-800/50 p-3 text-sm">
      <p className={s.errors.length ? "text-amber-300" : "text-emerald-300"}>
        Gotowe: {parts.join(", ") || "brak plików do wgrania"}.{s.junk > 0 && <span className="text-neutral-500"> Pominięte pliki systemowe (np. .DS_Store): {s.junk}.</span>}
      </p>
      {s.errors.length > 0 && <Details title="Błędy" items={s.errors.map((e) => `${e.path} - ${e.message}`)} tone="text-red-300" open />}
      {s.skipped.length > 0 && <Details title="Pominięte" items={s.skipped.map((x) => `${x.path} - ${x.reason}`)} tone="text-amber-300" />}
      {s.notes.length > 0 && <Details title="Uwagi" items={s.notes.map((x) => `${x.path} - ${x.note}`)} tone="text-neutral-300" />}
      {s.duplicates.length > 0 && <Details title="Duplikaty (ta sama treść jest już w bazie)" items={s.duplicates.map((d) => `${d.path} = ${d.of}`)} tone="text-neutral-400" />}
    </div>
  );
}

function Details({ title, items, tone, open }: { title: string; items: string[]; tone: string; open?: boolean }) {
  return (
    <details open={open}>
      <summary className={`cursor-pointer ${tone}`}>
        {title} ({items.length})
      </summary>
      <ul className="mt-1 max-h-48 space-y-0.5 overflow-auto pl-4 font-mono text-xs text-neutral-400">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </details>
  );
}

const BADGE: Record<SourceState, string | null> = { new: "nowy", changed: "zmieniony", ok: null };

type FolderViewProps = {
  node: TreeNode;
  byId: Map<string, KnowledgeSource>;
  stateOf: (s: KnowledgeSource) => SourceState;
  depth: number;
  busy: boolean;
  onDeleteFolder: (path: string, count: number) => void;
  onDeleteFile: (id: string, path: string) => void;
};

const FolderView = memo(function FolderView({ node, byId, stateOf, depth, busy, onDeleteFolder, onDeleteFile }: FolderViewProps) {
  return (
    <div className={depth ? "ml-4 border-l border-neutral-800 pl-3" : ""}>
      {node.folders.map((f) => {
        const count = countFiles(f);
        const pending = collectIds(f).filter((id) => {
          const s = byId.get(id);
          return s && stateOf(s) !== "ok";
        }).length;
        return (
          <details key={f.path} open={depth < 1} className="group">
            <summary className="flex cursor-pointer items-center gap-2 py-1">
              <span className="text-neutral-500 group-open:rotate-90">▸</span>
              <span className="font-medium">{f.name}/</span>
              <span className="text-xs text-neutral-500">{count} plików</span>
              {pending > 0 && <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-xs text-sky-300">{pending} do analizy</span>}
              <button
                type="button"
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault();
                  onDeleteFolder(f.path, count);
                }}
                className="ml-auto text-xs text-red-400/80 hover:text-red-300 disabled:opacity-40"
              >
                Usuń folder
              </button>
            </summary>
            <FolderView node={f} byId={byId} stateOf={stateOf} depth={depth + 1} busy={busy} onDeleteFolder={onDeleteFolder} onDeleteFile={onDeleteFile} />
          </details>
        );
      })}
      {node.files.map((file) => {
        const s = byId.get(file.id);
        if (!s) return null;
        const state = stateOf(s);
        const extra = s.parts && s.parts.length > 1 ? (s.kind === "image" ? ` · ${s.parts.length} części` : ` · ${s.parts.length} obrazów`) : "";
        return (
          <div key={file.id} className="flex items-center gap-2 py-0.5">
            <a href={`/api/knowledge/sources/${s.id}`} target="_blank" rel="noreferrer" className="min-w-0 truncate font-mono text-xs hover:text-sky-300">
              {file.name}
            </a>
            <span className="shrink-0 text-xs text-neutral-500">
              {KIND_LABEL[s.kind]} · {formatSize(s.size)}
              {s.pages ? ` · ${s.pages} str.` : ""}
              {extra}
              {state === "ok" ? ` · ${s.entryCount} wpisów` : ""}
            </span>
            {BADGE[state] && <span className="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-xs text-sky-300">{BADGE[state]}</span>}
            {s.notes && (
              <span className="truncate text-xs text-amber-300/80" title={s.notes}>
                ⚠ {s.notes}
              </span>
            )}
            <button type="button" disabled={busy} onClick={() => onDeleteFile(s.id, s.path)} className="ml-auto shrink-0 text-xs text-red-400/80 hover:text-red-300 disabled:opacity-40">
              Usuń
            </button>
          </div>
        );
      })}
    </div>
  );
});

function collectIds(node: TreeNode): string[] {
  return [...node.files.map((f) => f.id), ...node.folders.flatMap(collectIds)];
}
