import { describe, expect, it } from "vitest";
import { assessQuality, computeImageStats } from "@/lib/quality";

const neutral = { pose: { yaw: 1, pitch: 2, roll: 0 }, faceWidthPx: 400, faceWidthFraction: 0.3 };

describe("computeImageStats", () => {
  it("wykrywa ostry i rozmyty obraz", () => {
    const w = 64, h = 64;
    const checker = Array.from({ length: w * h }, (_, i) => (((i % w) + Math.floor(i / w)) % 2 ? 200 : 50));
    const flat = Array.from({ length: w * h }, () => 120);
    expect(computeImageStats(checker, w, h).sharpness).toBeGreaterThan(1000);
    expect(computeImageStats(flat, w, h).sharpness).toBeLessThan(1);
  });

  it("mierzy nierówne oświetlenie lewej i prawej strony", () => {
    const w = 10, h = 10;
    const half = Array.from({ length: w * h }, (_, i) => (i % w < 5 ? 40 : 200));
    expect(computeImageStats(half, w, h).sideImbalance).toBeGreaterThan(0.7);
    expect(computeImageStats(half, w, h).brightness).toBeCloseTo(120, 0);
  });
});

describe("assessQuality", () => {
  it("neutralne, dobre zdjęcie przechodzi", () => {
    const q = assessQuality({ ...neutral, blendshapes: {}, image: { brightness: 130, clipped: 0, sideImbalance: 0.05, sharpness: 120 } });
    expect(q.status).toBe("ok");
  });

  it("uśmiech dyskwalifikuje zdjęcie (zmienia proporcje)", () => {
    const q = assessQuality({ ...neutral, blendshapes: { mouthSmileLeft: 0.9, mouthSmileRight: 0.9 } });
    expect(q.status).toBe("bad");
    expect(q.checks.find((c) => c.id === "expression")?.status).toBe("bad");
  });

  it("mocno obrócona głowa dyskwalifikuje, lekko - ostrzega", () => {
    expect(assessQuality({ ...neutral, pose: { yaw: 20, pitch: 0, roll: 0 } }).status).toBe("bad");
    expect(assessQuality({ ...neutral, pose: { yaw: 9, pitch: 0, roll: 0 } }).status).toBe("warn");
  });

  it("ostrzega przed zdjęciem z bliska (zniekształcenie obiektywu)", () => {
    const q = assessQuality({ ...neutral, faceWidthFraction: 0.85 });
    expect(q.checks.some((c) => c.id === "distance" && c.status === "warn")).toBe(true);
  });
});
