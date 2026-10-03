"use client";

import type { MetricKey, MetricStat, Metrics } from "./metrics";
import type { AnalysisResponse } from "./schema";

// Historia analiz trzymana tylko w przeglądarce użytkownika (z miniaturą, bez pełnego zdjęcia).
export type HistoryItem = {
  id: string;
  createdAt: string;
  thumbnail: string;
  metrics: Metrics;
  stats: Partial<Record<MetricKey, MetricStat>>;
  report: AnalysisResponse;
};

const KEY = "analysis-history-v1";
const MAX_ITEMS = 30;

export function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as HistoryItem[]) : [];
  } catch {
    return [];
  }
}

function save(items: HistoryItem[]) {
  // Przy braku miejsca usuwamy najstarsze wpisy, aż się zmieści.
  let list = items.slice(0, MAX_ITEMS);
  while (list.length > 0) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
      return true;
    } catch {
      list = list.slice(0, -1);
    }
  }
  return false;
}

export function addToHistory(item: Omit<HistoryItem, "id">): HistoryItem[] {
  const entry = { ...item, id: `${Date.now()}` };
  const items = [entry, ...loadHistory()];
  save(items);
  return loadHistory();
}

export function removeFromHistory(id: string): HistoryItem[] {
  save(loadHistory().filter((i) => i.id !== id));
  return loadHistory();
}

export function clearHistory() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // brak dostępu do pamięci - nic do zrobienia
  }
}
