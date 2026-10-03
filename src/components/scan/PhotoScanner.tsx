"use client";

import { useState } from "react";
import { encodeForAnalysis, facePreview, fileToCanvas, scanCanvas, type FrameScan } from "@/lib/face-detector";
import type { ScanResult } from "@/lib/scan-types";
import { buildScanResult } from "./build-result";
import { FaceOverlay } from "./FaceOverlay";
import { QualityList, StatusBadge } from "./QualityList";

type Photo = {
  id: string;
  name: string;
  canvas?: HTMLCanvasElement;
  preview?: { image: string; landmarks: FrameScan["landmarks"] };
  scan?: FrameScan;
  error?: string;
  include: boolean;
};

const MAX_PHOTOS = 5;

export function PhotoScanner({ onComplete, disabled }: { onComplete: (r: ScanResult) => void; disabled: boolean }) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [profile, setProfile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addFiles(files: FileList) {
    setError(null);
    const list = Array.from(files).slice(0, MAX_PHOTOS - photos.length);
    if (list.length === 0) return;
    setBusy(true);
    for (const file of list) {
      const id = `${file.name}-${Date.now()}-${Math.random()}`;
      setPhotos((p) => [...p, { id, name: file.name, include: false }]);
      const update = (patch: Partial<Photo>) => setPhotos((p) => p.map((x) => (x.id === id ? { ...x, ...patch } : x)));
      try {
        const canvas = await fileToCanvas(file);
        const scan = await scanCanvas(canvas);
        update({ canvas, scan, preview: facePreview(canvas, scan.landmarks, 600), include: scan.quality.status !== "bad" });
      } catch (err) {
        update({ error: err instanceof Error ? err.message : "Nie udało się przetworzyć zdjęcia." });
      }
    }
    setBusy(false);
  }

  async function addProfile(file: File) {
    const canvas = await fileToCanvas(file);
    setProfile(encodeForAnalysis(canvas));
  }

  function finish() {
    const used = photos.filter((p) => p.include && p.scan && p.canvas) as Required<Pick<Photo, "canvas" | "scan">>[];
    if (used.length === 0) {
      setError("Zaznacz przynajmniej jedno zdjęcie do pomiaru.");
      return;
    }
    onComplete(buildScanResult(used, profile ?? undefined));
  }

  const usable = photos.filter((p) => p.include && p.scan).length;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label
          className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition ${
            disabled || photos.length >= MAX_PHOTOS ? "cursor-not-allowed border-neutral-800 opacity-50" : "cursor-pointer border-sky-500/50 hover:bg-sky-500/5"
          }`}
        >
          <span className="font-medium">Zdjęcia twarzy na wprost</span>
          <span className="mt-1 text-xs text-neutral-400">1-5 zdjęć. Kilka zdjęć = dokładniejszy pomiar (liczona jest mediana).</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={disabled || busy || photos.length >= MAX_PHOTOS}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        <label
          className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition ${
            disabled ? "cursor-not-allowed border-neutral-800 opacity-50" : "cursor-pointer border-neutral-700 hover:bg-neutral-800/40"
          }`}
        >
          <span className="font-medium">{profile ? "Zmień zdjęcie profilu" : "Zdjęcie profilu (opcjonalnie)"}</span>
          <span className="mt-1 text-xs text-neutral-400">Z boku, 90°. Pomaga ocenić żuchwę, brodę i nos.</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={disabled}
            className="hidden"
            onChange={(e) => e.target.files?.[0] && addProfile(e.target.files[0])}
          />
        </label>
      </div>

      {photos.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {photos.map((p) => (
            <div key={p.id} className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
              {p.preview && p.scan ? (
                <FaceOverlay image={p.preview.image} landmarks={p.preview.landmarks} />
              ) : (
                <div className="flex aspect-square items-center justify-center rounded-lg bg-neutral-800/50 text-sm text-neutral-400">
                  {p.error ? "Błąd" : "Skanowanie…"}
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs text-neutral-400">{p.name}</span>
                {p.scan && <StatusBadge status={p.scan.quality.status} />}
              </div>
              {p.error && <p className="text-xs text-red-300">{p.error}</p>}
              {p.scan && <QualityList report={p.scan.quality} compact />}
              <div className="flex items-center justify-between text-xs">
                {p.scan && (
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={p.include} onChange={(e) => setPhotos((x) => x.map((y) => (y.id === p.id ? { ...y, include: e.target.checked } : y)))} />
                    użyj do pomiaru
                  </label>
                )}
                <button onClick={() => setPhotos((x) => x.filter((y) => y.id !== p.id))} className="text-neutral-500 hover:text-red-400">
                  usuń
                </button>
              </div>
            </div>
          ))}
          {profile && (
            <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={profile} alt="Profil" className="w-full rounded-lg" />
              <div className="flex justify-between text-xs text-neutral-400">
                <span>Profil</span>
                <button onClick={() => setProfile(null)} className="hover:text-red-400">
                  usuń
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}

      {photos.length > 0 && (
        <button
          onClick={finish}
          disabled={busy || usable === 0}
          className="w-full rounded-xl bg-sky-500 px-4 py-3 font-semibold text-neutral-950 hover:bg-sky-400 disabled:opacity-50"
        >
          {busy ? "Skanowanie zdjęć…" : `Dalej: pomiar z ${usable} ${usable === 1 ? "zdjęcia" : "zdjęć"}`}
        </button>
      )}
    </div>
  );
}
