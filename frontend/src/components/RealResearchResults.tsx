import { metricLabels, resultHeading } from '../lib/realResearch'
import type { MetricKey, RealResult } from '../lib/realResearch'
import type { DateRange } from '../lib/history'

const dates = (range: DateRange | null) => range ? `${range.start} through ${range.end}` : 'No observations returned'
export default function RealResearchResults({ result }: { result: RealResult }) {
  const plan = result.plan
  return <section aria-label="Real research result">
    <h2>{resultHeading(result)}</h2><p>{result.message}</p><p>Status: {result.status} · Outcome: {result.code}</p>
    {result.code === 'research_busy' && <p>Another research request occupies the shared endpoint slot. This is not a provider quota diagnosis.</p>}
    <p>Model calls: {result.model_calls} · History retrievals: {result.history_retrievals}.
      Retrieval counts are not exact upstream request counts; cached snapshots may be reused.</p>
    {plan && <section aria-label="Validated research plan"><h3>Validated plan: {plan.status}</h3>
      {plan.status === 'planned' ? <><p>Symbols: {plan.symbols.join(', ')} · {plan.start_date} through {plan.end_date}</p>
        <ul>{plan.intents.map((i) => <li key={`${i.kind}:${i.metric}`}>{i.kind === 'report' ? 'Report' : 'Compare'}: {metricLabels[i.metric]}</li>)}</ul></>
        : <p>Reason: {plan.reason}. No history requested.</p>}
    </section>}
    <h3>Backend-rendered findings</h3>
    {result.findings.length ? <ul>{result.findings.map((f, i) => <li key={i}>
      <p>{f.statement}</p><p>Evidence: {f.evidence_ids.map((id) => <a key={id} href={`#real-evidence-${id}`}>{id} </a>)}</p>
    </li>)}</ul> : <p>No requested finding could be produced. Available evidence remains below.</p>}
    {!!result.errors.length && <section aria-label="Per-symbol provider errors"><h3>Unavailable symbols</h3><ul>
      {result.errors.map((e) => <li key={e.symbol}>{e.symbol}: {e.message} (status {e.status})
        {e.available_range && <p>Available snapshot: {dates(e.available_range)}</p>}
        {e.status === 429 && <p>This is a per-symbol provider/budget error, not an occupied research slot.
          The precise restriction and reset time are unknown. Do not repeatedly retry.</p>}
      </li>)}</ul></section>}
    {!!result.omitted.length && <section><h3>Omitted findings</h3><ul>{result.omitted.map((s, i) => <li key={i}>{s}</li>)}</ul></section>}
    <h3>Evidence</h3>
    {!result.evidence.length && <p>No historical evidence collected.</p>}
    <div className="real-evidence-grid">{result.evidence.map(({ id, metrics: m }) => <article className="real-evidence" key={id} id={`real-evidence-${id}`} tabIndex={-1}>
      <h4>{m.symbol} · {id}</h4><p>Alpha Vantage ({m.source}) · End-of-day ({m.data_kind}) · Unadjusted</p>
      <dl><dt>Requested range</dt><dd>{dates(m.requested_range)}</dd>
        <dt>Available snapshot</dt><dd>{dates(m.available_range)}</dd><dt>Returned range</dt><dd>{dates(m.returned_range)}</dd>
        <dt>Observations</dt><dd>{m.observation_count}</dd><dt>Original source fetch time</dt><dd>{m.fetched_at} (not market freshness)</dd>
        <dt>Cache</dt><dd>{m.cache_hit ? 'Reused cached snapshot' : 'Newly fetched snapshot'}</dd>
      </dl>
      <p>Corporate actions unchecked · Calendar completeness not verified · Daily observations · Currency: {m.currency}</p>
      {(Object.keys(metricLabels) as MetricKey[]).map((key) => { const metric = m[key]; return <section key={key}>
        <h5>{metricLabels[key]}</h5>
        {metric.status === 'available' ? <p className="real-metric-value">{metric.value} {metric.unit}</p> : <p>Unavailable: {metric.reason}</p>}
        <p>Actual window: {metric.window ? dates(metric.window) : 'Unavailable'}<br />
          Observations: {metric.observation_count} · Required: {metric.required_observations}</p>
        {key === 'raw_return_sample_stddev_20' && <p>Adjacent returns: {m.return_count}</p>}
      </section> })}
      <details><summary>Source limitations</summary><ul>{m.source_limitations.map((s, i) => <li key={i}>{s}</li>)}</ul></details>
      <details><summary>Calculation limitations</summary><ul>{m.calculation_limitations.map((s, i) => <li key={i}>{s}</li>)}</ul></details>
    </article>)}</div>
    <details><summary>Workflow limitations</summary><ul>{result.limitations.map((s, i) => <li key={i}>{s}</li>)}</ul></details>
  </section>
}
