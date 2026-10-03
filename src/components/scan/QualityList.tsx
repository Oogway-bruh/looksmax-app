import type { CheckStatus, QualityReport } from "@/lib/quality";

const ICON: Record<CheckStatus, string> = { ok: "✓", warn: "!", bad: "✕" };
const COLOR: Record<CheckStatus, string> = {
  ok: "text-emerald-400",
  warn: "text-amber-400",
  bad: "text-red-400",
};

export function StatusBadge({ status }: { status: CheckStatus }) {
  const label = { ok: "dobre", warn: "z uwagami", bad: "nieużyteczne" }[status];
  const bg = { ok: "bg-emerald-500/15", warn: "bg-amber-500/15", bad: "bg-red-500/15" }[status];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${bg} ${COLOR[status]}`}>{label}</span>;
}

export function QualityList({ report, compact = false }: { report: QualityReport; compact?: boolean }) {
  const checks = compact ? report.checks.filter((c) => c.status !== "ok") : report.checks;
  if (compact && checks.length === 0) return <p className="text-xs text-emerald-400">Wszystkie warunki spełnione</p>;
  return (
    <ul className="space-y-1 text-sm">
      {checks.map((c) => (
        <li key={c.id} className="flex gap-2">
          <span className={`w-4 shrink-0 text-center font-bold ${COLOR[c.status]}`}>{ICON[c.status]}</span>
          <span className={c.status === "ok" ? "text-neutral-400" : "text-neutral-200"}>
            {compact || c.status !== "ok" ? c.message : c.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
