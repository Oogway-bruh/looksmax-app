"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeForAnalysis, faceImageStats, firstFace, getLandmarker, scanCanvas, type FrameScan } from "@/lib/face-detector";
import { computeFaceGeometry } from "@/lib/metrics";
import { assessQuality, type ImageStats, type QualityReport } from "@/lib/quality";
import type { ScanResult } from "@/lib/scan-types";
import { buildScanResult } from "./build-result";
import { drawLandmarks } from "./FaceOverlay";
import { QualityList } from "./QualityList";

const FRAMES_NEEDED = 6;
const FRAME_INTERVAL_MS = 220;
const STABLE_MS = 900;
// Te warunki muszą być spełnione bez zastrzeżeń, żeby zrobić auto-zdjęcie.
const STRICT_CHECKS = ["yaw", "pitch", "expression", "gaze"];

type Phase = "off" | "starting" | "live" | "capturing" | "processing" | "profile-countdown";

export function CameraScanner({ onComplete, disabled }: { onComplete: (r: ScanResult) => void; disabled: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const framesRef = useRef<HTMLCanvasElement[]>([]);
  const goodSinceRef = useRef<number | null>(null);
  const lastCaptureRef = useRef(0);
  const imageStatsRef = useRef<ImageStats | undefined>(undefined);
  const frameCountRef = useRef(0);
  const phaseRef = useRef<Phase>("off");
  const profileRef = useRef<string | null>(null);
  // Ręczne wymuszenie zdjęć, gdy nie da się spełnić wszystkich warunków (np. słabe światło).
  const forceRef = useRef(false);

  const [phase, setPhaseState] = useState<Phase>("off");
  const [quality, setQuality] = useState<QualityReport | null>(null);
  const [faceVisible, setFaceVisible] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);

  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  function grabFrame(): HTMLCanvasElement {
    const video = videoRef.current!;
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext("2d")!.drawImage(video, 0, 0);
    return c;
  }

  async function start() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Ta przeglądarka nie daje dostępu do kamery (wymagane HTTPS). Użyj trybu „Zdjęcia”.");
      return;
    }
    setPhase("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      await getLandmarker("VIDEO");
      await getLandmarker("IMAGE");
      framesRef.current = [];
      goodSinceRef.current = null;
      setProgress(0);
      setPhase("live");
      rafRef.current = requestAnimationFrame(loop);
    } catch (err) {
      stop();
      setPhase("off");
      const name = (err as DOMException)?.name;
      setError(
        name === "NotAllowedError"
          ? "Brak zgody na kamerę. Zezwól na dostęp w ustawieniach przeglądarki albo użyj trybu „Zdjęcia”."
          : name === "NotFoundError"
            ? "Nie znaleziono kamery. Użyj trybu „Zdjęcia”."
            : "Nie udało się uruchomić kamery.",
      );
    }
  }

  async function loop() {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    const phaseNow = phaseRef.current;
    if (!video || !overlay || !streamRef.current || (phaseNow !== "live" && phaseNow !== "capturing" && phaseNow !== "profile-countdown")) return;
    const landmarker = await getLandmarker("VIDEO");
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w && h) {
      overlay.width = w;
      overlay.height = h;
      const ctx = overlay.getContext("2d")!;
      ctx.clearRect(0, 0, w, h);
      // Owal pomocniczy - gdzie ustawić twarz.
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = Math.max(2, w / 400);
      ctx.setLineDash([12, 10]);
      ctx.beginPath();
      ctx.ellipse(w / 2, h * 0.47, h * 0.22, h * 0.31, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      const { count, face } = firstFace(landmarker.detectForVideo(video, performance.now()));
      setFaceVisible(count === 1);
      if (face && count === 1) {
        const geo = computeFaceGeometry(face.landmarks, w, h, face.matrix);
        if (frameCountRef.current++ % 5 === 0) imageStatsRef.current = faceImageStats(video, w, h, face.landmarks);
        const q = assessQuality({
          pose: geo.pose,
          blendshapes: face.blendshapes,
          faceWidthPx: geo.faceWidthPx,
          faceWidthFraction: geo.faceWidthFraction,
          image: imageStatsRef.current,
        });
        setQuality(q);
        const strictOk = q.checks.every((c) => (STRICT_CHECKS.includes(c.id) ? c.status === "ok" : c.status !== "bad"));
        drawLandmarks(ctx, face.landmarks, w, h, strictOk ? "52, 211, 153" : "251, 191, 36");

        const now = performance.now();
        if (phaseRef.current !== "profile-countdown") {
          if (strictOk || forceRef.current) {
            goodSinceRef.current ??= now;
            if ((forceRef.current || now - goodSinceRef.current > STABLE_MS) && now - lastCaptureRef.current > FRAME_INTERVAL_MS) {
              if (phaseRef.current === "live") setPhase("capturing");
              lastCaptureRef.current = now;
              framesRef.current.push(grabFrame());
              setProgress(framesRef.current.length / FRAMES_NEEDED);
              if (framesRef.current.length >= FRAMES_NEEDED) {
                finishCapture();
                return;
              }
            }
          } else {
            goodSinceRef.current = null;
          }
        }
      } else {
        setQuality(null);
        goodSinceRef.current = null;
      }
    }
    rafRef.current = requestAnimationFrame(loop);
  }

  async function finishCapture() {
    forceRef.current = false;
    setPhase("processing");
    cancelAnimationFrame(rafRef.current);
    try {
      const scanned: { canvas: HTMLCanvasElement; scan: FrameScan }[] = [];
      for (const canvas of framesRef.current) {
        try {
          const scan = await scanCanvas(canvas);
          if (scan.quality.status !== "bad") scanned.push({ canvas, scan });
        } catch {
          // Klatka bez twarzy - pomijamy.
        }
      }
      if (scanned.length < 3) throw new Error("Za mało dobrych klatek. Spróbuj jeszcze raz, trzymając telefon nieruchomo.");
      stop();
      setPhase("off");
      onComplete(buildScanResult(scanned, profileRef.current ?? undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Błąd przetwarzania klatek.");
      framesRef.current = [];
      goodSinceRef.current = null;
      setProgress(0);
      setPhase("live");
      rafRef.current = requestAnimationFrame(loop);
    }
  }

  function captureProfile() {
    setPhase("profile-countdown");
    let n = 3;
    setCountdown(n);
    const timer = setInterval(() => {
      n -= 1;
      setCountdown(n);
      if (n === 0) {
        clearInterval(timer);
        profileRef.current = encodeForAnalysis(grabFrame());
        setProfile(profileRef.current);
        framesRef.current = [];
        goodSinceRef.current = null;
        setProgress(0);
        setPhase("live");
      }
    }, 1000);
  }

  const live = phase === "live" || phase === "capturing" || phase === "profile-countdown";

  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-xl border border-neutral-800 bg-black" style={{ aspectRatio: "16 / 9" }}>
        {/* Podgląd lustrzany, jak w lusterku - pomiar liczony jest z oryginalnej klatki. */}
        <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full -scale-x-100 object-contain" />
        <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full -scale-x-100 object-contain" />
        {!live && phase !== "processing" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="max-w-md text-sm text-neutral-300">
              Ustaw telefon na wysokości oczu, ok. 1 m od twarzy (najlepiej na statywie lub opartego), stań przodem do okna.
              Zdjęcia zrobią się automatycznie, gdy wszystkie warunki będą spełnione.
            </p>
            <button
              onClick={start}
              disabled={disabled || phase === "starting"}
              className="rounded-xl bg-sky-500 px-6 py-3 font-semibold text-neutral-950 hover:bg-sky-400 disabled:opacity-50"
            >
              {phase === "starting" ? "Uruchamianie kamery…" : "Włącz kamerę"}
            </button>
          </div>
        )}
        {phase === "processing" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-sm">Przetwarzanie klatek…</div>
        )}
        {phase === "profile-countdown" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40">
            <p className="text-sm">Obróć głowę w bok (profil)</p>
            <p className="text-6xl font-bold">{countdown}</p>
          </div>
        )}
        {live && (
          <div className="absolute inset-x-0 bottom-0 h-1.5 bg-neutral-800">
            <div className="h-full bg-emerald-400 transition-all" style={{ width: `${progress * 100}%` }} />
          </div>
        )}
      </div>

      {live && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
            {!faceVisible ? (
              <p className="text-sm text-amber-300">Ustaw twarz w owalu (tylko jedna osoba w kadrze).</p>
            ) : quality ? (
              <QualityList report={quality} />
            ) : null}
          </div>
          <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 text-sm">
            <p className="text-neutral-300">
              {phase === "capturing"
                ? `Zbieranie klatek: ${Math.round(progress * FRAMES_NEEDED)}/${FRAMES_NEEDED} - nie ruszaj się`
                : "Czekam, aż wszystkie warunki będą spełnione…"}
            </p>
            {phase === "live" && (
              <button
                onClick={() => {
                  forceRef.current = true;
                }}
                className="mr-2 rounded-lg border border-neutral-700 px-3 py-1.5"
                title="Zdjęcia z ostrzeżeniami - pomiar może być mniej dokładny"
              >
                Zrób zdjęcia teraz
              </button>
            )}
            <button onClick={captureProfile} disabled={phase === "profile-countdown"} className="rounded-lg border border-neutral-700 px-3 py-1.5 disabled:opacity-50">
              {profile ? "✓ Profil zapisany - zrób ponownie" : "Dodaj zdjęcie profilu (opcjonalnie)"}
            </button>
            <button
              onClick={() => {
                stop();
                setPhase("off");
              }}
              className="ml-2 rounded-lg px-3 py-1.5 text-neutral-400 hover:text-neutral-200"
            >
              Wyłącz kamerę
            </button>
          </div>
        </div>
      )}

      {error && <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
    </div>
  );
}
