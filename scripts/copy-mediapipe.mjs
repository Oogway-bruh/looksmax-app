// Przygotowuje pliki MediaPipe w public/: WASM z paczki (wersja zawsze zgodna) i model detekcji twarzy.
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const src = "node_modules/@mediapipe/tasks-vision/wasm";
const out = "public/mediapipe";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

mkdirSync(out, { recursive: true });
if (existsSync(src)) cpSync(src, `${out}/wasm`, { recursive: true });

if (!existsSync(`${out}/face_landmarker.task`)) {
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(`${out}/face_landmarker.task`, Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    console.warn(`Nie pobrano modelu twarzy (${err.message}) - aplikacja pobierze go z Google w przeglądarce.`);
  }
}
