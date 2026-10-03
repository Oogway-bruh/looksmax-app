"use client";

import { useEffect, useRef, useState } from "react";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { computeFaceGeometry, METRIC_INFO, OVERLAY_POINTS, type FaceGeometry, type MetricKey } from "@/lib/metrics";
import type { AnalysisResponse } from "@/lib/schema";
import { Report } from "./Report";

// Model jest serwowany z public/ (pobiera go scripts/copy-mediapipe.mjs); gdyby go brakowało - z Google.
const MODEL_URLS = [
  "/mediapipe/face_landmarker.task",
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
];
const MAX_SIDE = 1280;

let landmarkerPromise: Promise<FaceLandmarker> | null = null;
function getLandmarker() {
  landmarkerPromise ??= (async () => {
    const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
    for (const [i, url] of MODEL_URLS.entries()) {
      try {
        return await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: url },
          runningMode: "IMAGE",
          numFaces: 2,
        });
      } catch (err) {
        if (i === MODEL_URLS.length - 1) throw err;
      }
    }
    throw new Error("Nie udało się wczytać modelu twarzy.");
  })();
  landmarkerPromise.catch(() => (landmarkerPromise = null));
  return landmarkerPromise;
}

type Stage = "idle" | "detecting" | "ready" | "analyzing" | "done";

export function FaceAnalyzer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [adult, setAdult] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<FaceGeometry | null>(null);
  const [imageData, setImageData] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResponse | null>(null);

  // Wczytaj model w tle od razu po wejściu na stronę.
  useEffect(() => {
    getLandmarker().catch(() => undefined);
  }, []);

  async function handleFile(file: File) {
    setError(null);
    setResult(null);
    setGeometry(null);
    setStage("detecting");
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      const canvas = canvasRef.current!;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0, w, h);
      // Zdjęcie wysyłane do analizy - bez nakładki z punktami.
      setImageData(canvas.toDataURL("image/jpeg", 0.88));

      const landmarker = await getLandmarker();
      const detection = landmarker.detect(canvas);
      if (detection.faceLandmarks.length === 0) {
        throw new Error("Nie wykryto twarzy. Użyj zdjęcia z przodu, z dobrym światłem i odsłoniętą twarzą.");
      }
      if (detection.faceLandmarks.length > 1) {
        throw new Error("Na zdjęciu jest więcej niż jedna twarz - wgraj zdjęcie tylko jednej osoby.");
      }
      const landmarks = detection.faceLandmarks[0];
      const geo = computeFaceGeometry(landmarks, w, h);
      setGeometry(geo);

      ctx.fillStyle = "rgba(56, 189, 248, 0.9)";
      for (const i of OVERLAY_POINTS) {
        ctx.beginPath();
        ctx.arc(landmarks[i].x * w, landmarks[i].y * h, Math.max(2, w / 400), 0, Math.PI * 2);
        ctx.fill();
      }
      setStage("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nie udało się przetworzyć zdjęcia.");
      setStage("idle");
    }
  }

  async function analyze() {
    if (!geometry || !imageData) return;
    setStage("analyzing");
    setError(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: imageData, metrics: geometry.metrics, warnings: geometry.warnings, consent: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Błąd analizy");
      setResult(json);
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Błąd analizy");
      setStage("ready");
    }
  }

  const allowed = adult && consent;

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6 space-y-4">
        <label className="flex gap-3 text-sm text-neutral-300">
          <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} className="mt-1" />
          Mam ukończone 18 lat.
        </label>
        <label className="flex gap-3 text-sm text-neutral-300">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />
          Zgadzam się na przetworzenie mojego zdjęcia w celu analizy wyglądu. Zdjęcie nie jest zapisywane - jest
          analizowane jednorazowo i usuwane po wygenerowaniu raportu.
        </label>
        <label
          className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition ${
            allowed ? "cursor-pointer border-sky-500/50 hover:bg-sky-500/5" : "cursor-not-allowed border-neutral-700 opacity-50"
          }`}
        >
          <span className="font-medium">Wybierz zdjęcie twarzy</span>
          <span className="mt-1 text-sm text-neutral-400">
            Z przodu, na wprost, neutralna mina, dobre równomierne światło, bez okularów
          </span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={!allowed || stage === "detecting" || stage === "analyzing"}
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
        </label>
        {error && <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
      </section>

      <section className={`grid gap-6 md:grid-cols-2 ${stage === "idle" && !geometry ? "hidden" : ""}`}>
        <div>
          <canvas ref={canvasRef} className="w-full rounded-xl border border-neutral-800" />
          {stage === "detecting" && <p className="mt-2 text-sm text-neutral-400">Wykrywanie twarzy…</p>}
        </div>
        {geometry && (
          <div className="space-y-4">
            {geometry.warnings.map((w) => (
              <p key={w} className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-300">
                {w}
              </p>
            ))}
            <table className="w-full text-sm">
              <tbody>
                {(Object.entries(geometry.metrics) as [MetricKey, number][]).map(([k, v]) => (
                  <tr key={k} className="border-b border-neutral-800" title={METRIC_INFO[k].description}>
                    <td className="py-1.5 text-neutral-400">{METRIC_INFO[k].label}</td>
                    <td className="py-1.5 text-right font-mono">
                      {v}
                      {METRIC_INFO[k].unit}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              onClick={analyze}
              disabled={stage !== "ready"}
              className="w-full rounded-xl bg-sky-500 px-4 py-3 font-semibold text-neutral-950 hover:bg-sky-400 disabled:opacity-50"
            >
              {stage === "analyzing" ? "Analizuję według bazy wiedzy… (do ~1 min)" : stage === "done" ? "Analiza gotowa" : "Analizuj twarz"}
            </button>
          </div>
        )}
      </section>

      {result && <Report data={result} />}
    </div>
  );
}
