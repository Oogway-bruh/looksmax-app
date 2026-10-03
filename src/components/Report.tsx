import { METRIC_INFO, type MetricKey } from "@/lib/metrics";
import { AREA_LABELS, VERDICT_LABELS, type AnalysisResponse } from "@/lib/schema";

const PRIORITY_LABELS = { high: "wysoki", medium: "średni", low: "niski" } as const;
const VERDICT_COLORS = {
  ideal: "text-emerald-300",
  good: "text-sky-300",
  average: "text-amber-300",
  weak: "text-red-300",
} as const;

export function Report({ data }: { data: AnalysisResponse }) {
  const { analysis, ruleResults, overallScore } = data;
  const titles = new Map(data.entries.map((e) => [e.id, e.title]));

  const Sources = ({ ids }: { ids: string[] }) => (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {ids.map((id) => (
        <span key={id} title={titles.get(id)} className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
          {id}
        </span>
      ))}
    </span>
  );

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-4 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6 sm:flex-row sm:items-center">
        <div className="text-center sm:w-32">
          <div className="text-5xl font-bold text-sky-400">{overallScore ?? "–"}</div>
          <div className="text-xs text-neutral-400">ocena ogólna / 10</div>
        </div>
        <p className="flex-1 text-neutral-200">{analysis.summary}</p>
      </div>

      {!analysis.photoQuality.ok && (
        <div className="rounded-xl bg-amber-500/10 p-4 text-sm text-amber-300">
          <p className="font-medium">Jakość zdjęcia może zaniżać trafność oceny:</p>
          <ul className="mt-1 list-disc pl-5">
            {analysis.photoQuality.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      )}

      {analysis.topPriorities.length > 0 && (
        <div className="rounded-2xl border border-sky-500/30 bg-sky-500/5 p-6">
          <h2 className="mb-3 text-lg font-semibold">Najważniejsze do zmiany</h2>
          <ol className="list-decimal space-y-2 pl-5">
            {analysis.topPriorities.map((p) => (
              <li key={p.text}>
                {p.text}
                <Sources ids={p.entryIds} />
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {analysis.areas.map((a) => (
          <div key={a.area} className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="font-semibold">{AREA_LABELS[a.area]}</h3>
              {a.score != null && <span className="font-mono text-sky-400">{a.score}/10</span>}
            </div>
            <p className="text-sm text-neutral-300">
              {a.observation}
              <Sources ids={a.entryIds} />
            </p>
            {a.strengths.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm text-emerald-300">
                {a.strengths.map((s) => (
                  <li key={s}>+ {s}</li>
                ))}
              </ul>
            )}
            {a.improvements.length > 0 && (
              <ul className="mt-3 space-y-2 text-sm">
                {a.improvements.map((i) => (
                  <li key={i.text} className="text-neutral-200">
                    <span className="mr-1 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">
                      {PRIORITY_LABELS[i.priority]}
                    </span>
                    {i.text}
                    <Sources ids={i.entryIds} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {ruleResults.length > 0 && (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
          <h2 className="mb-3 font-semibold">Pomiary ocenione regułami z bazy</h2>
          <table className="w-full text-sm">
            <tbody>
              {ruleResults.map((r) => (
                <tr key={r.entryId} className="border-b border-neutral-800 align-top">
                  <td className="py-2 pr-2">
                    {r.title}
                    <Sources ids={[r.entryId]} />
                    {r.note && <div className="text-xs text-neutral-400">{r.note}</div>}
                  </td>
                  <td className="py-2 pr-2 font-mono text-neutral-400">
                    {r.value}
                    {METRIC_INFO[r.metric as MetricKey]?.unit}
                  </td>
                  <td className={`py-2 text-right ${VERDICT_COLORS[r.verdict]}`}>
                    {VERDICT_LABELS[r.verdict]} ({r.score}/10)
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {analysis.notCoveredByKnowledge.length > 0 && (
        <p className="text-sm text-neutral-500">
          Poza zakresem bazy wiedzy (nie oceniono): {analysis.notCoveredByKnowledge.join(", ")}.
        </p>
      )}
      <p className="text-xs text-neutral-500">
        Pomiary ze zdjęcia są przybliżone i zależą od kąta, światła i obiektywu. Decyzje o zabiegach medycznych
        konsultuj ze specjalistą.
      </p>
    </section>
  );
}
