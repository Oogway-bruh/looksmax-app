"use client";

import { encodeForAnalysis, facePreview, type FrameScan } from "@/lib/face-detector";
import { combineMetrics } from "@/lib/metrics";
import type { ScanResult } from "@/lib/scan-types";

const RANK = { ok: 0, warn: 1, bad: 2 } as const;

/** Wybiera najlepsze ujęcie i łączy pomiary wszystkich użytych ujęć. */
export function buildScanResult(items: { canvas: HTMLCanvasElement; scan: FrameScan }[], profileImage?: string): ScanResult {
  if (items.length === 0) throw new Error("Brak użytecznych ujęć.");
  const best = [...items].sort(
    (a, b) => RANK[a.scan.quality.status] - RANK[b.scan.quality.status] || b.scan.image.sharpness - a.scan.image.sharpness,
  )[0];
  const { metrics, stats } = combineMetrics(items.map((i) => i.scan.metrics));
  return {
    metrics,
    stats,
    samples: items.length,
    quality: best.scan.quality,
    frontImage: encodeForAnalysis(best.canvas, best.scan.landmarks),
    profileImage,
    preview: facePreview(best.canvas, best.scan.landmarks, 900),
  };
}
