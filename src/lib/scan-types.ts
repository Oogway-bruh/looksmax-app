import type { Landmark, MetricKey, MetricStat, Metrics } from "./metrics";
import type { QualityReport } from "./quality";

/** Wynik skanowania przekazywany do analizy. */
export type ScanResult = {
  metrics: Metrics;
  stats: Partial<Record<MetricKey, MetricStat>>;
  /** Ile zdjęć/klatek złożyło się na pomiar */
  samples: number;
  /** Jakość najlepszego ujęcia */
  quality: QualityReport;
  /** Zdjęcie przodu wysyłane do analizy (JPEG data URL, kadr wokół twarzy) */
  frontImage: string;
  /** Opcjonalne zdjęcie profilu */
  profileImage?: string;
  /** Podgląd z naniesionymi punktami */
  preview: { image: string; landmarks: Landmark[] };
};

export type AnalyzeRequest = {
  frontImage: string;
  profileImage?: string;
  metrics: Metrics;
  spreads: Partial<Record<MetricKey, number>>;
  samples: number;
  qualityNotes: string[];
  consent: true;
};
