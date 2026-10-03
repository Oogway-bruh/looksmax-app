import { describe, expect, it } from "vitest";
import { combineMetrics, computeFaceGeometry, mergeMirrored, METRIC_KEYS, type Landmark } from "@/lib/metrics";
import frontal from "./fixtures/frontal.json";
import frontalMirrored from "./fixtures/frontal-mirrored.json";
import turned from "./fixtures/turned.json";
import turnedMirrored from "./fixtures/turned-mirrored.json";

// Fixture'y to prawdziwe wyniki MediaPipe dla zdjęć testowych (i ich lustrzanych odbić).
type Fixture = { landmarks: Landmark[]; width: number; height: number; matrix: number[] };
const geo = (f: Fixture, withMatrix = true) => computeFaceGeometry(f.landmarks, f.width, f.height, withMatrix ? f.matrix : null);

describe("computeFaceGeometry", () => {
  it("liczy wszystkie pomiary w realistycznych zakresach", () => {
    const { metrics } = geo(frontal);
    for (const k of METRIC_KEYS) expect(metrics[k], k).toBeTypeOf("number");
    expect(metrics.eye_spacing_ratio).toBeGreaterThan(0.38);
    expect(metrics.eye_spacing_ratio).toBeLessThan(0.52);
    expect(metrics.fwhr).toBeGreaterThan(1.5);
    expect(metrics.fwhr).toBeLessThan(2.3);
    expect(metrics.jaw_width_ratio).toBeGreaterThan(0.6);
    expect(metrics.jaw_width_ratio).toBeLessThan(1);
    expect(metrics.asymmetry_index).toBeLessThan(5);
  });

  it("lustrzane odbicie daje te same proporcje (w granicach szumu modelu)", () => {
    const a = geo(frontal).metrics;
    const b = geo(frontalMirrored).metrics;
    // Model punktów ma ~1-1,5° szumu na pojedyncze oko - dlatego aplikacja uśrednia zdjęcie z odbiciem.
    expect(Math.abs(b.canthal_tilt_left! - a.canthal_tilt_right!)).toBeLessThan(2);
    expect(Math.abs(b.canthal_tilt! - a.canthal_tilt!)).toBeLessThan(1);
    for (const k of ["fwhr", "eye_spacing_ratio", "jaw_width_ratio", "midface_ratio", "nose_width_ratio"] as const) {
      expect(Math.abs(a[k]! - b[k]!) / a[k]!, k).toBeLessThan(0.03);
    }
  });

  it("odczytuje pozę głowy i jej znak odwraca się w lustrze", () => {
    const p = geo(turned).pose;
    const q = geo(turnedMirrored).pose;
    expect(Math.abs(p.yaw)).toBeGreaterThan(12);
    expect(Math.sign(p.yaw)).toBe(-Math.sign(q.yaw));
    expect(Math.abs(geo(frontal).pose.yaw)).toBeLessThan(5);
  });

  it("korekta 3D zmniejsza zafałszowanie przy obróconej głowie", () => {
    const corrected = geo(turned).metrics.asymmetry_index!;
    const uncorrected = geo(turned, false).metrics.asymmetry_index!;
    expect(corrected).toBeLessThan(uncorrected * 0.6);
  });

  it("przy zdjęciu na wprost korekta 3D prawie nic nie zmienia", () => {
    const a = geo(frontal).metrics;
    const b = geo(frontal, false).metrics;
    for (const k of ["fwhr", "eye_spacing_ratio", "jaw_width_ratio"] as const) {
      expect(Math.abs(a[k]! - b[k]!) / a[k]!, k).toBeLessThan(0.03);
    }
  });
});

describe("mergeMirrored", () => {
  it("zamienia strony pomiarów z odbicia i uśrednia", () => {
    const merged = mergeMirrored({ canthal_tilt_left: 2, canthal_tilt_right: 4, fwhr: 1.8 }, { canthal_tilt_left: 4, canthal_tilt_right: 2, fwhr: 1.9 });
    expect(merged.canthal_tilt_left).toBe(2);
    expect(merged.canthal_tilt_right).toBe(4);
    expect(merged.fwhr).toBeCloseTo(1.85, 2);
  });

  it("na prawdziwych danych zbliża wyniki zdjęcia i jego odbicia", () => {
    const a = geo(frontal).metrics;
    const b = geo(frontalMirrored).metrics;
    const m1 = mergeMirrored(a, b);
    const m2 = mergeMirrored(b, a);
    expect(m1.canthal_tilt_left).toBeCloseTo(m2.canthal_tilt_right!, 5);
  });
});

describe("combineMetrics", () => {
  it("bierze medianę, więc jedna błędna klatka nie psuje wyniku", () => {
    const { metrics, stats } = combineMetrics([{ fwhr: 1.8 }, { fwhr: 1.82 }, { fwhr: 1.79 }, { fwhr: 3.5 }, { fwhr: 1.81 }]);
    expect(metrics.fwhr).toBeCloseTo(1.81, 2);
    expect(stats.fwhr?.samples).toBe(5);
    expect(stats.fwhr!.spread).toBeLessThan(0.05);
  });
});
