"use client";

import { useState } from "react";
import { METRIC_INFO, METRIC_KEYS } from "@/lib/metrics";
import { clearHistory, removeFromHistory, type HistoryItem } from "@/lib/history";
import { AREA_LABELS } from "@/lib/schema";
import { Report, scoreColor } from "./Report";

const date = (iso: string) => new Date(iso).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" });

export function History({ items, onChange }: { items: HistoryItem[]; onChange: (items: HistoryItem[]) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);

  if (items.length === 0) {
    return <p className="text-neutral-400">Brak zapisanych analiz. Historia jest przechowywana tylko w tej przeglądarce.</p>;
  }

  const opened = items.find((i) => i.id === open);
  if (opened) {
    return (
      <div className="space-y-4">
        <button onClick={() => setOpen(null)} className="text-sm text-sky-400 print:hidden">
          ← Wróć do historii
        </button>
        <p className="text-sm text-neutral-400">Analiza z {date(opened.createdAt)}</p>
        <Report data={opened.report} metrics={opened.metrics} stats={opened.stats} />
      </div>
    );
  }

  const selected = compare.map((id) => items.find((i) => i.id === id)).filter(Boolean) as HistoryItem[];
  // Porównanie: starsza → nowsza
  const [older, newer] = [...selected].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="space-y-6">
      <p className="text-sm text-neutral-400">
        Zaznacz dwie analizy, żeby porównać postępy. Historia jest przechowywana tylko w tej przeglądarce (z miniaturą zdjęcia).
      </p>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-4 rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
            <input
              type="checkbox"
              checked={compare.includes(item.id)}
              onChange={(e) => setCompare((c) => (e.target.checked ? [...c, item.id].slice(-2) : c.filter((x) => x !== item.id)))}
              aria-label="Porównaj"
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.thumbnail} alt="" className="h-14 w-14 rounded-lg object-cover" />
            <div className="flex-1">
              <p className="text-sm">{date(item.createdAt)}</p>
              <p className="text-xs text-neutral-500">{item.report.priorities.slice(0, 2).map((p) => p.title).join(" · ")}</p>
            </div>
            <span className={`font-mono text-lg ${scoreColor(item.report.overallScore)}`}>{item.report.overallScore ?? "–"}</span>
            <button onClick={() => setOpen(item.id)} className="text-sm text-sky-400">
              Otwórz
            </button>
            <button onClick={() => onChange(removeFromHistory(item.id))} className="text-sm text-neutral-500 hover:text-red-400">
              Usuń
            </button>
          </li>
        ))}
      </ul>

      {older && newer && (
        <section className="space-y-4 rounded-2xl border border-sky-500/30 bg-neutral-900/60 p-5">
          <h2 className="font-semibold">
            Porównanie: {date(older.createdAt)} → {date(newer.createdAt)}
          </h2>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-neutral-500">
              <tr>
                <th className="py-1 font-normal"></th>
                <th className="py-1 text-right font-normal">przed</th>
                <th className="py-1 text-right font-normal">po</th>
                <th className="py-1 text-right font-normal">zmiana</th>
              </tr>
            </thead>
            <tbody>
              <Row label="Ocena ogólna" a={older.report.overallScore} b={newer.report.overallScore} higherIsBetter />
              {newer.report.areas.map((area) => (
                <Row
                  key={area.area}
                  label={AREA_LABELS[area.area]}
                  a={older.report.areas.find((x) => x.area === area.area)?.score ?? null}
                  b={area.score}
                  higherIsBetter
                />
              ))}
              <tr>
                <td colSpan={4} className="pt-4 text-xs uppercase tracking-wide text-neutral-500">
                  Pomiary
                </td>
              </tr>
              {METRIC_KEYS.filter((k) => older.metrics[k] != null && newer.metrics[k] != null).map((k) => (
                <Row key={k} label={METRIC_INFO[k].label} a={older.metrics[k]!} b={newer.metrics[k]!} digits={METRIC_INFO[k].digits} />
              ))}
            </tbody>
          </table>
          <p className="text-xs text-neutral-500">
            Różnice w pomiarach mniejsze niż ich rozrzut (±) mogą wynikać z warunków zdjęcia, a nie z realnej zmiany.
          </p>
        </section>
      )}

      <button
        onClick={() => {
          if (confirm("Usunąć całą historię z tej przeglądarki?")) {
            clearHistory();
            onChange([]);
          }
        }}
        className="text-sm text-neutral-500 hover:text-red-400"
      >
        Wyczyść historię
      </button>
    </div>
  );
}

function Row({ label, a, b, digits = 1, higherIsBetter }: { label: string; a: number | null; b: number | null; digits?: number; higherIsBetter?: boolean }) {
  const diff = a != null && b != null ? b - a : null;
  const color = diff == null || !higherIsBetter || Math.abs(diff) < 0.05 ? "text-neutral-400" : diff > 0 ? "text-emerald-400" : "text-red-400";
  return (
    <tr className="border-b border-neutral-800">
      <td className="py-1.5 text-neutral-300">{label}</td>
      <td className="py-1.5 text-right font-mono">{a?.toFixed(digits) ?? "–"}</td>
      <td className="py-1.5 text-right font-mono">{b?.toFixed(digits) ?? "–"}</td>
      <td className={`py-1.5 text-right font-mono ${color}`}>{diff == null ? "" : `${diff > 0 ? "+" : ""}${diff.toFixed(digits)}`}</td>
    </tr>
  );
}
