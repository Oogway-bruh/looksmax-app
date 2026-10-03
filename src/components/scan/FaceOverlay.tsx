"use client";

import { useEffect, useRef } from "react";
import { OVERLAY_LINES, OVERLAY_POINTS, type Landmark } from "@/lib/metrics";

/** Zdjęcie z naniesionymi punktami i liniami pomiarowymi. */
export function FaceOverlay({ image, landmarks, className = "" }: { image: string; landmarks: Landmark[]; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const canvas = ref.current;
      if (!canvas) return;
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      drawLandmarks(ctx, landmarks, img.width, img.height);
    };
    img.src = image;
  }, [image, landmarks]);

  return <canvas ref={ref} className={`w-full rounded-xl ${className}`} />;
}

export function drawLandmarks(ctx: CanvasRenderingContext2D, landmarks: Landmark[], w: number, h: number, color = "56, 189, 248") {
  const unit = Math.max(1.5, w / 500);
  ctx.lineWidth = unit;
  ctx.strokeStyle = `rgba(${color}, 0.55)`;
  for (const [a, b] of OVERLAY_LINES) {
    ctx.beginPath();
    ctx.moveTo(landmarks[a].x * w, landmarks[a].y * h);
    ctx.lineTo(landmarks[b].x * w, landmarks[b].y * h);
    ctx.stroke();
  }
  ctx.fillStyle = `rgba(${color}, 0.95)`;
  for (const i of OVERLAY_POINTS) {
    ctx.beginPath();
    ctx.arc(landmarks[i].x * w, landmarks[i].y * h, unit * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}
