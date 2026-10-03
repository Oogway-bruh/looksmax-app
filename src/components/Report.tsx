import { METRIC_INFO, formatMetric, type MetricKey, type MetricStat, type Metrics } from "@/lib/metrics";
import { VERDICT_LABELS, type AnalysisResponse, type AssessedEntry } from "@/lib/schema";

const CONFIDENCE_LABELS = { low: "niska pewność", medium: "średnia pewność", high: "" } as const;

export function scoreColor(score: number | null) {
  if (score == null) return "text-neutral-400";
  if (score >= 8) return "text-emerald-400";
  if (score >= 6.5) return "text-sky-400";
  if (score >= 5) return "text-amber-400";
  return "text-red-400";
}

function barColor(score: number) {
  if (score >= 8) return "bg-emerald-400";
  if (score >= 6.5) return "bg-sky-400";
  if (score >= 5) return "bg-amber-400";
  return "bg-red-400";
}

function ScoreBar({ score }: { score: number }) {
  return (
    <div className="h-1.5 w-full rounded bg-neutral-800 print:bg-neutral-200">
      <div className={`h-1.5 rounded ${barColor(score)}`} style={{ width: `${score * 10}%` }} />
    </div>
  );
}

function ScoreRing({ score }: { score: number | null }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 120 120" className="h-32 w-32 shrink-0">
      <circle cx="60" cy="60" r={r} fill="none" strokeWidth="10" className="stroke-neutral-800 print:stroke-neutral-200" />
      {score != null && (
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${(score / 10) * c} ${c}`}
          transform="rotate(-90 60 60)"
          className={`stroke-current ${scoreColor(score)}`}
        />
      )}
      <text x="60" y="58" textAnchor="middle" className={`fill-current text-3xl font-bold ${scoreColor(score)}`} fontSize="30">
        {score ?? "–"}
      </text>
      <text x="60" y="80" textAnchor="middle" className="fill-neutral-500" fontSize="11">
        na 10
      </text>
    </svg>
  );
}

function Tag({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400 print:bg-neutral-100 ${className}`}>{children}</span>;
}

function EntryDetail({ e, showArea = false }: { e: AssessedEntry; showArea?: boolean }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{e.title}</span>
        {showArea && <Tag>{e.areaName ?? e.area}</Tag>}
        <Tag className="font-mono">{e.entryId}</Tag>
        {CONFIDENCE_LABELS[e.confidence] && <Tag className="text-amber-300/80">{CONFIDENCE_LABELS[e.confidence]}</Tag>}
        {e.score != null && (
          <span className={`ml-auto font-mono text-sm ${scoreColor(e.score)}`}>
            {e.score}/10{e.verdict ? ` · ${VERDICT_LABELS[e.verdict]}` : ""}
          </span>
        )}
      </div>
      {e.score != null && <ScoreBar score={e.score} />}
      <p className="text-sm text-neutral-300 print:text-neutral-700">{e.observation}</p>
      {e.rule && (
        <p className="text-xs text-neutral-400">
          Pomiar: {METRIC_INFO[e.rule.metric].label} = {formatMetric(e.rule.metric, e.rule.value)}
          {e.rule.borderline && " (na granicy przedziału)"}
          {e.rule.note && ` - ${e.rule.note}`}
        </p>
      )}
      {e.recommendations.length > 0 && (
        <ul className="space-y-1 text-sm">
          {e.recommendations.map((r) => (
            <li key={r} className="flex gap-2">
              <span className="text-sky-400">→</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}
      {e.personalNote && <p className="text-sm italic text-neutral-400">{e.personalNote}</p>}
    </div>
  );
}

const section = "rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5 print:border-neutral-300 print:bg-white print:break-inside-avoid";

export function Report({
  data,
  metrics,
  stats,
}: {
  data: AnalysisResponse;
  metrics?: Metrics;
  stats?: Partial<Record<MetricKey, MetricStat>>;
}) {
  const top = data.priorities.slice(0, 5);
  const rest = data.priorities.slice(5);
  const ruleByMetric = new Map(data.areas.flatMap((a) => a.entries).filter((e) => e.rule).map((e) => [e.rule!.metric, e]));

  return (
    <div className="space-y-6">
      <section className={`${section} flex flex-col items-center gap-6 sm:flex-row`}>
        <ScoreRing score={data.overallScore} />
        <div className="space-y-2">
          <p className="text-neutral-200 print:text-neutral-900">{data.summary}</p>
          <p className="text-xs text-neutral-500">
            Ocenione {data.coverage.assessed} z {data.coverage.totalEntries} wpisów bazy wiedzy
            {data.coverage.ruleBased > 0 && `, w tym ${data.coverage.ruleBased} z pomiarów wg progów z bazy`}
            {data.coverage.usedFullMaterials && "; analiza z pełnymi materiałami autora"}. Wynik to średnia ważona priorytetem cech i wagą
            kategorii.
          </p>
        </div>
      </section>

      {!data.photoQuality.ok && data.photoQuality.issues.length > 0 && (
        <div className="rounded-xl bg-amber-500/10 p-4 text-sm text-amber-300">
          <p className="font-medium">Jakość zdjęcia może obniżać trafność oceny:</p>
          <ul className="mt-1 list-disc pl-5">
            {data.photoQuality.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      )}

      {top.length > 0 && (
        <section className={`${section} border-sky-500/30`}>
          <h2 className="mb-4 text-lg font-semibold">Najważniejsze do zmiany</h2>
          <ol className="space-y-5">
            {top.map((e, i) => (
              <li key={e.entryId} className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-500 text-xs font-bold text-neutral-950">
                  {i + 1}
                </span>
                <div className="flex-1">
                  <EntryDetail e={e} showArea />
                </div>
              </li>
            ))}
          </ol>
          {rest.length > 0 && (
            <details className="mt-5">
              <summary className="cursor-pointer text-sm text-neutral-400">Pozostałe do poprawy ({rest.length})</summary>
              <div className="mt-4 space-y-5">
                {rest.map((e) => (
                  <EntryDetail key={e.entryId} e={e} showArea />
                ))}
              </div>
            </details>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold">Kategorie</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {data.areas.map((a) => (
            <details key={a.area} className={`${section} group`}>
              <summary className="cursor-pointer list-none">
                <div className="flex items-baseline justify-between">
                  <h3 className="font-semibold">{a.name ?? a.area}</h3>
                  <span className={`font-mono ${scoreColor(a.score)}`}>{a.score ?? "–"}/10</span>
                </div>
                {a.score != null && (
                  <div className="mt-2">
                    <ScoreBar score={a.score} />
                  </div>
                )}
                <p className="mt-2 text-xs text-neutral-500 group-open:hidden">
                  {a.entries.length} {a.entries.length === 1 ? "cecha" : "cech"} - kliknij, aby zobaczyć szczegóły
                </p>
              </summary>
              <div className="mt-4 space-y-5">
                {a.entries.map((e) => (
                  <EntryDetail key={e.entryId} e={e} />
                ))}
              </div>
            </details>
          ))}
        </div>
      </section>

      {data.strengths.length > 0 && (
        <section className={section}>
          <h2 className="mb-3 text-lg font-semibold">Mocne strony</h2>
          <ul className="space-y-2 text-sm">
            {data.strengths.map((e) => (
              <li key={e.entryId} className="flex gap-2">
                <span className="text-emerald-400">✓</span>
                <span>
                  <b>{e.title}</b> <span className="text-neutral-400">- {e.observation}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.advice.length > 0 && (
        <section className={section}>
          <h2 className="mb-3 text-lg font-semibold">Zalecenia ogólne z bazy</h2>
          <div className="space-y-5">
            {data.advice.map((e) => (
              <EntryDetail key={e.entryId} e={e} showArea />
            ))}
          </div>
        </section>
      )}

      {metrics && Object.keys(metrics).length > 0 && (
        <details className={section}>
          <summary className="cursor-pointer font-semibold">Pomiary twarzy</summary>
          <MetricsTable metrics={metrics} stats={stats} ruleByMetric={ruleByMetric} />
        </details>
      )}

      {(data.notVisible.length > 0 || data.notCovered.length > 0) && (
        <div className="space-y-1 text-sm text-neutral-500">
          {data.notVisible.length > 0 && <p>Nie oceniono (niewidoczne na zdjęciach): {data.notVisible.map((e) => e.title).join(", ")}.</p>}
          {data.notCovered.length > 0 && <p>Poza zakresem bazy wiedzy: {data.notCovered.join(", ")}.</p>}
        </div>
      )}

      <p className="text-xs text-neutral-500">
        Pomiary ze zdjęcia są przybliżone i zależą od kąta, światła i obiektywu. Decyzje o zabiegach medycznych konsultuj ze specjalistą.
      </p>
    </div>
  );
}

export function MetricsTable({
  metrics,
  stats,
  ruleByMetric,
}: {
  metrics: Metrics;
  stats?: Partial<Record<MetricKey, MetricStat>>;
  ruleByMetric?: Map<MetricKey, AssessedEntry>;
}) {
  return (
    <table className="mt-3 w-full text-sm">
      <tbody>
        {(Object.entries(metrics) as [MetricKey, number][]).map(([k, v]) => {
          const rule = ruleByMetric?.get(k);
          const spread = stats?.[k]?.spread;
          return (
            <tr key={k} className="border-b border-neutral-800 print:border-neutral-200" title={METRIC_INFO[k].description}>
              <td className="py-1.5 pr-2 text-neutral-400">{METRIC_INFO[k].label}</td>
              <td className="py-1.5 text-right font-mono whitespace-nowrap">
                {formatMetric(k, v)}
                {spread ? <span className="text-neutral-500"> ±{spread}</span> : null}
              </td>
              <td className={`hidden py-1.5 pl-3 text-right text-xs sm:table-cell ${rule ? scoreColor(rule.score) : ""}`}>
                {rule?.verdict ? VERDICT_LABELS[rule.verdict] : ""}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
