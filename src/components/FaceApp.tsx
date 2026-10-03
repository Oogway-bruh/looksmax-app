"use client";

import { useEffect, useRef, useState } from "react";
import { thumbnail } from "@/lib/face-detector";
import { addToHistory, loadHistory, type HistoryItem } from "@/lib/history";
import type { AnalyzeRequest, ScanResult } from "@/lib/scan-types";
import type { AnalysisResponse } from "@/lib/schema";
import { History } from "./History";
import { MetricsTable, Report } from "./Report";
import { CameraScanner } from "./scan/CameraScanner";
import { FaceOverlay } from "./scan/FaceOverlay";
import { PhotoScanner } from "./scan/PhotoScanner";
import { QualityList, StatusBadge } from "./scan/QualityList";

type Step = "scan" | "review" | "analyzing" | "report";

const PROGRESS = [
  { after: 0, text: "Wysyłanie zdjęć i pomiarów…" },
  { after: 3, text: "Porównywanie pomiarów z progami z bazy wiedzy…" },
  { after: 8, text: "Ocena kolejnych cech według bazy wiedzy…" },
  { after: 35, text: "Dobieranie zaleceń z bazy…" },
  { after: 70, text: "Składanie raportu… (przy dużej bazie może to potrwać do 2-3 minut)" },
];

const panel = "rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5";

export function FaceApp() {
  const [tab, setTab] = useState<"new" | "history">("new");
  const [mode, setMode] = useState<"camera" | "photos">("photos");
  const [adult, setAdult] = useState(false);
  const [consent, setConsent] = useState(false);
  const [step, setStep] = useState<Step>("scan");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [report, setReport] = useState<AnalysisResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setHistory(loadHistory());
    // Na telefonach domyślnie kamera - prowadzi krok po kroku do dobrego ujęcia.
    if (window.matchMedia("(pointer: coarse)").matches) setMode("camera");
  }, []);

  useEffect(() => {
    if (step !== "analyzing") return;
    const start = Date.now();
    const t = setInterval(() => setElapsed((Date.now() - start) / 1000), 500);
    return () => clearInterval(t);
  }, [step]);

  const allowed = adult && consent;

  function onScanned(result: ScanResult) {
    setScan(result);
    setError(null);
    setStep("review");
  }

  async function analyze() {
    if (!scan) return;
    setStep("analyzing");
    setElapsed(0);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const body: AnalyzeRequest = {
      frontImage: scan.frontImage,
      profileImage: scan.profileImage,
      metrics: scan.metrics,
      spreads: Object.fromEntries(Object.entries(scan.stats).map(([k, s]) => [k, s!.spread])),
      samples: scan.samples,
      qualityNotes: scan.quality.checks.filter((c) => c.status !== "ok").map((c) => c.message),
      consent: true,
    };
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = await res.json().catch(() => ({ error: `Błąd serwera (${res.status})` }));
      if (!res.ok) throw new Error(json.error ?? "Błąd analizy");
      const data = json as AnalysisResponse;
      setReport(data);
      setStep("report");
      setHistory(
        addToHistory({
          createdAt: data.createdAt,
          thumbnail: await thumbnail(scan.frontImage),
          metrics: scan.metrics,
          stats: scan.stats,
          report: data,
        }),
      );
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setStep("review");
        return;
      }
      setError(err instanceof Error ? err.message : "Błąd analizy");
      setStep("review");
    }
  }

  function restart() {
    setScan(null);
    setReport(null);
    setError(null);
    setStep("scan");
  }

  const progressText = [...PROGRESS].reverse().find((p) => elapsed >= p.after)?.text;

  return (
    <div className="space-y-6">
      <nav className="flex gap-2 print:hidden">
        {(
          [
            ["new", "Nowa analiza"],
            ["history", `Historia${history.length ? ` (${history.length})` : ""}`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-lg px-4 py-2 text-sm ${tab === id ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-neutral-200"}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "history" && <History items={history} onChange={setHistory} />}

      {tab === "new" && step === "scan" && (
        <>
          <section className={`${panel} space-y-3`}>
            <label className="flex gap-3 text-sm text-neutral-300">
              <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} className="mt-1" />
              Mam ukończone 18 lat.
            </label>
            <label className="flex gap-3 text-sm text-neutral-300">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />
              Zgadzam się na przetworzenie zdjęć mojej twarzy w celu analizy wyglądu. Zdjęcia nie są zapisywane na serwerze - są
              analizowane jednorazowo. Historia (z miniaturą) zostaje tylko w tej przeglądarce.
            </label>
          </section>

          <section className={`space-y-4 ${allowed ? "" : "pointer-events-none opacity-40"}`}>
            <div className="flex gap-2">
              {(
                [
                  ["camera", "Kamera (zalecane)"],
                  ["photos", "Zdjęcia z galerii"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setMode(id)}
                  className={`flex-1 rounded-xl border px-4 py-3 text-sm font-medium transition ${
                    mode === id ? "border-sky-500 bg-sky-500/10 text-sky-300" : "border-neutral-800 text-neutral-400 hover:border-neutral-700"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <Tips />
            {mode === "camera" ? <CameraScanner onComplete={onScanned} disabled={!allowed} /> : <PhotoScanner onComplete={onScanned} disabled={!allowed} />}
          </section>
        </>
      )}

      {tab === "new" && (step === "review" || step === "analyzing") && scan && (
        <section className="grid gap-6 md:grid-cols-2">
          <div className="space-y-3">
            <FaceOverlay image={scan.preview.image} landmarks={scan.preview.landmarks} />
            {scan.profileImage && (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={scan.profileImage} alt="Profil" className="w-1/2 rounded-xl" />
              </>
            )}
          </div>
          <div className="space-y-4">
            <div className={panel}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-semibold">Jakość ujęcia</h2>
                <StatusBadge status={scan.quality.status} />
              </div>
              <QualityList report={scan.quality} />
              <p className="mt-3 text-xs text-neutral-500">
                Pomiar z {scan.samples} {scan.samples === 1 ? "ujęcia" : "ujęć"}, każde skanowane dwukrotnie (z odbiciem lustrzanym) i
                skorygowane o obrót głowy.
              </p>
            </div>
            <details className={panel}>
              <summary className="cursor-pointer font-semibold">Pomiary ({Object.keys(scan.metrics).length})</summary>
              <MetricsTable metrics={scan.metrics} stats={scan.stats} />
            </details>
            {error && <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
            {step === "analyzing" ? (
              <div className={`${panel} space-y-3`}>
                <div className="h-1.5 overflow-hidden rounded bg-neutral-800">
                  <div className="h-full animate-pulse bg-sky-500" style={{ width: `${Math.min(95, 8 + elapsed * 1.1)}%` }} />
                </div>
                <p className="text-sm text-neutral-300">{progressText}</p>
                <button onClick={() => abortRef.current?.abort()} className="text-sm text-neutral-500 hover:text-neutral-300">
                  Anuluj
                </button>
              </div>
            ) : (
              <div className="flex gap-3">
                <button onClick={analyze} className="flex-1 rounded-xl bg-sky-500 px-4 py-3 font-semibold text-neutral-950 hover:bg-sky-400">
                  Analizuj według bazy wiedzy
                </button>
                <button onClick={restart} className="rounded-xl border border-neutral-700 px-4 py-3 text-sm">
                  Skanuj ponownie
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {tab === "new" && step === "report" && report && scan && (
        <>
          <div className="flex flex-wrap gap-3 print:hidden">
            <button onClick={restart} className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-neutral-950">
              Nowa analiza
            </button>
            <button
              onClick={() => {
                // W PDF-ie mają być widoczne wszystkie szczegóły.
                document.querySelectorAll("details").forEach((d) => (d.open = true));
                window.print();
              }} className="rounded-lg border border-neutral-700 px-4 py-2 text-sm">
              Zapisz jako PDF / drukuj
            </button>
          </div>
          <Report data={report} metrics={scan.metrics} stats={scan.stats} />
        </>
      )}
    </div>
  );
}

function Tips() {
  return (
    <details className="rounded-xl border border-neutral-800 p-4 text-sm text-neutral-400">
      <summary className="cursor-pointer text-neutral-300">Jak zrobić zdjęcie do najdokładniejszego pomiaru</summary>
      <ul className="mt-3 list-disc space-y-1 pl-5">
        <li>Aparat na wysokości oczu, głowa prosto, wzrok w obiektyw.</li>
        <li>Odległość min. ~1 m (z bliska obiektyw powiększa nos i zwęża twarz) - lepiej użyć zoomu 2x niż podchodzić.</li>
        <li>Neutralna mina: usta zamknięte, bez uśmiechu, rozluźnione brwi.</li>
        <li>Równe, rozproszone światło z przodu (np. stań przodem do okna), bez ostrych cieni.</li>
        <li>Odsłonięte czoło, uszy i linia żuchwy; bez okularów i nakrycia głowy.</li>
        <li>Dla oceny żuchwy, brody i nosa dodaj zdjęcie profilu (z boku, 90°).</li>
      </ul>
    </details>
  );
}
