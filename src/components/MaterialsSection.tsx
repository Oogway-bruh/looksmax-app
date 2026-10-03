"use client";

import { useEffect, useRef, useState } from "react";
import { ACCEPT_ATTR, buildTree, countFiles, type TreeNode } from "@/lib/file-types";
import { classify, entriesFromDrop, filesFromEntries, filesFromInput, prepareForUpload, type PickedFile, type Skipped } from "@/lib/folder-upload";
import type { KnowledgeSource } from "@/lib/schema";

const UPLOAD_CONCURRENCY = 4;
const KIND_LABEL = { text: "tekst", image: "obraz", pdf: "PDF" } as const;
const formatSize = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

type Summary = {
  added: number;
  updated: number;
  unchanged: number;
  duplicates: { path: string; of: string }[];
  errors: { path: string; message: string }[];
  skipped: Skipped[];
  junk: number;
};

const emptySummary = (): Summary => ({ added: 0, updated: 0, unchanged: 0, duplicates: [], errors: [], skipped: [], junk: 0 });

export function MaterialsSection({
  sources,
  analyzedIds,
  disabled,
  onChanged,
}: {
  sources: KnowledgeSource[];
  analyzedIds: Set<string>;
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [phase, setPhase] = useState<"idle" | "collecting" | "uploading">("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Atrybut wyboru folderu nie jest w typach Reacta - ustawiamy go ręcznie.
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
    folderInput.current?.setAttribute("directory", "");
  }, []);

  async function upload(picked: PickedFile[]) {
    setError(null);
    const { accepted, skipped, junk } = classify(picked);
    const result: Summary = { ...emptySummary(), skipped, junk };
    setSummary(result);
    if (accepted.length === 0) {
      setPhase("idle");
      if (picked.length === 0) setError("Nie znaleziono plików. Jeśli przeciągasz folder, upuść go na pole poniżej albo użyj przycisku „Wybierz folder”.");
      return;
    }
    setPhase("uploading");
    setProgress({ done: 0, total: accepted.length, current: "" });
    let next = 0;
    let done = 0;
    let stop = false;
    const worker = async () => {
      while (next < accepted.length && !stop) {
        const item = accepted[next++];
        setProgress((p) => ({ ...p, current: item.path }));
        try {
          const prepared = await prepareForUpload(item);
          const form = new FormData();
          form.append("file", prepared.file);
          form.append("path", prepared.path);
          if (prepared.width && prepared.height) {
            form.append("width", String(prepared.width));
            form.append("height", String(prepared.height));
          }
          const res = await fetch("/api/knowledge/sources", { method: "POST", body: form });
          const json = await res.json().catch(() => ({}));
          if (res.status === 401) {
            stop = true;
            setError("Sesja wygasła - zaloguj się ponownie i wgraj pozostałe pliki (już wgrane zostaną rozpoznane).");
          } else if (!res.ok) {
            result.errors.push({ path: item.path, message: json.error ?? `Błąd ${res.status}` });
          } else if (json.status === "added") result.added++;
          else if (json.status === "updated") result.updated++;
          else if (json.status === "unchanged") result.unchanged++;
          else if (json.status === "duplicate") result.duplicates.push({ path: item.path, of: json.duplicateOf });
        } catch (e) {
          result.errors.push({ path: item.path, message: e instanceof Error ? e.message : "Nie udało się przygotować pliku" });
        }
        done++;
        setProgress((p) => ({ ...p, done }));
        setSummary({ ...result });
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, accepted.length) }, worker));
    setPhase("idle");
    await onChanged();
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (disabled || phase !== "idle") return;
    // Wpisy trzeba pobrać synchronicznie - po pierwszym await lista elementów przeciągania wygasa.
    const { entries, files } = entriesFromDrop(e.dataTransfer);
    setPhase("collecting");
    try {
      const picked = entries.length ? await filesFromEntries(entries) : files.map((file) => ({ file, path: file.name }));
      await upload(picked);
    } catch {
      setPhase("idle");
      setError("Nie udało się odczytać przeciągniętych plików. Użyj przycisku „Wybierz folder”.");
    }
  }

  async function deleteFolder(path: string, count: number) {
    if (!confirm(`Usunąć folder „${path}” (${count} plików)? Wpisy, które pochodzą tylko z tych plików, też znikną.`)) return;
    const res = await fetch(`/api/knowledge/sources?folder=${encodeURIComponent(path)}`, { method: "DELETE" });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? "Nie udało się usunąć folderu.");
    await onChanged();
  }

  async function deleteFile(id: string, path: string) {
    if (!confirm(`Usunąć „${path}”? Wpisy, które pochodzą tylko z tego pliku, też znikną.`)) return;
    const res = await fetch(`/api/knowledge/sources/${id}`, { method: "DELETE" });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? "Nie udało się usunąć pliku.");
    await onChanged();
  }

  const busy = disabled || phase !== "idle";
  const tree = buildTree(sources.map((s) => ({ id: s.id, path: s.path })));
  const byId = new Map(sources.map((s) => [s.id, s]));
  const totalSize = sources.reduce((n, s) => n + s.size, 0);

  return (
    <section className="space-y-4 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6">
      <h2 className="text-lg font-semibold">1. Twoje materiały</h2>
      <p className="text-sm text-neutral-400">
        Wgraj <b>cały folder</b> z wiedzą - ze wszystkimi podfolderami. Układ folderów jest zachowany i traktowany jako część wiedzy (foldery = Twoje tematy i
        kategorie). Obsługiwane: tekst (.txt, .md, .csv…), Word (.docx), PowerPoint (.pptx), Excel (.xlsx), PDF, zdjęcia i zrzuty ekranu (.jpg, .png, .webp,
        .heic). Ponowne wgranie folderu doda tylko nowe i zmienione pliki.
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
        <div className="mt-3 flex flex-wrap justify-center gap-3">
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
        </div>
        <input
          ref={folderInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const picked = filesFromInput(e.target.files);
            e.target.value = "";
            upload(picked);
          }}
        />
        <input
          ref={filesInput}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => {
            const picked = filesFromInput(e.target.files);
            e.target.value = "";
            upload(picked);
          }}
        />
      </div>

      {phase === "uploading" && (
        <div className="space-y-2 text-sm">
          <div className="h-2 overflow-hidden rounded bg-neutral-800">
            <div className="h-full bg-sky-500 transition-all" style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} />
          </div>
          <p className="text-neutral-400">
            Wgrywanie {progress.done}/{progress.total} · <span className="font-mono text-xs">{progress.current}</span>
          </p>
        </div>
      )}

      {summary && phase !== "uploading" && <UploadSummary summary={summary} />}
      {error && <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}

      {sources.length > 0 && (
        <div className="space-y-1 text-sm">
          <p className="text-neutral-400">
            {sources.length} plików · {formatSize(totalSize)}
          </p>
          <FolderView node={tree} byId={byId} analyzedIds={analyzedIds} depth={0} busy={busy} onDeleteFolder={deleteFolder} onDeleteFile={deleteFile} />
        </div>
      )}
    </section>
  );
}

function UploadSummary({ summary: s }: { summary: Summary }) {
  const parts = [
    s.added && `dodano ${s.added}`,
    s.updated && `zaktualizowano ${s.updated}`,
    s.unchanged && `bez zmian ${s.unchanged}`,
    s.duplicates.length && `duplikaty ${s.duplicates.length}`,
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
      {s.duplicates.length > 0 && <Details title="Duplikaty (ta sama treść jest już wgrana)" items={s.duplicates.map((d) => `${d.path} = ${d.of}`)} tone="text-neutral-400" />}
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

function FolderView({
  node,
  byId,
  analyzedIds,
  depth,
  busy,
  onDeleteFolder,
  onDeleteFile,
}: {
  node: TreeNode;
  byId: Map<string, KnowledgeSource>;
  analyzedIds: Set<string>;
  depth: number;
  busy: boolean;
  onDeleteFolder: (path: string, count: number) => void;
  onDeleteFile: (id: string, path: string) => void;
}) {
  return (
    <div className={depth ? "ml-4 border-l border-neutral-800 pl-3" : ""}>
      {node.folders.map((f) => {
        const count = countFiles(f);
        const fresh = collectIds(f).filter((id) => !analyzedIds.has(id)).length;
        return (
          <details key={f.path} open={depth < 1} className="group">
            <summary className="flex cursor-pointer items-center gap-2 py-1">
              <span className="text-neutral-500 group-open:rotate-90">▸</span>
              <span className="font-medium">{f.name}/</span>
              <span className="text-xs text-neutral-500">{count} plików</span>
              {fresh > 0 && <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-xs text-sky-300">{fresh} nowych</span>}
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
            <FolderView node={f} byId={byId} analyzedIds={analyzedIds} depth={depth + 1} busy={busy} onDeleteFolder={onDeleteFolder} onDeleteFile={onDeleteFile} />
          </details>
        );
      })}
      {node.files.map((file) => {
        const s = byId.get(file.id);
        if (!s) return null;
        return (
          <div key={file.id} className="flex items-center gap-2 py-0.5">
            <a href={`/api/knowledge/sources/${s.id}`} target="_blank" className="min-w-0 truncate font-mono text-xs hover:text-sky-300">
              {file.name}
            </a>
            <span className="shrink-0 text-xs text-neutral-500">
              {KIND_LABEL[s.kind]} · {formatSize(s.size)}
              {analyzedIds.has(s.id) ? ` · ${s.entryCount} wpisów` : ""}
            </span>
            {!analyzedIds.has(s.id) && <span className="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-xs text-sky-300">nowy</span>}
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
}

function collectIds(node: TreeNode): string[] {
  return [...node.files.map((f) => f.id), ...node.folders.flatMap(collectIds)];
}
