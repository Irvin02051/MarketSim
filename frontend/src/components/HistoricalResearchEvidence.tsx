import type { HistoricalEvidence, HistoricalFinding, ResearchDates } from '../lib/research'

const metrics = [
  ['price_change', 'Price change'], ['sma_20', 'SMA20'], ['sma_50', 'SMA50'],
  ['adjacent_return_volatility_20', 'Adjacent-observation return volatility'],
] as const
const range = (dates: ResearchDates) => `${dates.start} through ${dates.end}`
const coverage = { within_fixture: 'Within fixture bounds', partial_overlap: 'Partial coverage', outside_fixture: 'Outside fixture coverage' }

export default function HistoricalResearchEvidence({ evidence, findings }: {
  evidence: HistoricalEvidence[]; findings: HistoricalFinding[]
}) {
  return <section className="research-history" aria-label="Historical research">
    <h2>Historical findings</h2>
    <p className="research-fictional">FICTIONAL DEMO DATA — these metrics describe fictional history, not actual performance or forecasts.</p>
    <p>Historical fixtures are separate from standalone quote fixtures. Price change excludes dividends.
      Volatility uses 20 returns from 21 observations and is not annualized. Lower variability does not mean safer overall.</p>
    {findings.length ? <ul className="research-findings">
      {findings.map((finding, i) => <li key={i}>
        <p>{finding.statement}</p>
        <p className="research-meta">Evidence: {finding.evidence_ids.map((id, index) => <span key={id}>
          {index > 0 && ', '}<a href={`#research-${id}`}>{id}</a>
        </span>)} · Backend-rendered finding</p>
      </li>)}
    </ul> : <p>No validated historical finding was returned. Available evidence is retained below.</p>}
    <h2>Historical evidence</h2>
    {!evidence.length && <p>No historical evidence was collected.</p>}
    <div className="research-historical-cards">{evidence.map((item) => {
      const p = item.provenance
      return <article key={item.id} id={`research-${item.id}`} tabIndex={-1} className="research-quote research-historical-card">
        <h3>{p.symbol} · {item.id}</h3>
        <p className="research-fictional">{p.label}</p>
        <dl>
          <div><dt>Requested range</dt><dd>{range(p.requested_range)}</dd></div>
          <div><dt>Returned range</dt><dd>{p.returned_range ? range(p.returned_range) : 'No observations returned'}</dd></div>
          <div><dt>Fixture coverage</dt><dd>{range(p.fixture_range)}</dd></div>
          <div><dt>Coverage</dt><dd>{coverage[p.coverage]}</dd></div>
          <div><dt>Source / currency</dt><dd>{p.source} / {p.currency} · Fictional</dd></div>
          <div><dt>Adjustment basis</dt><dd>{p.adjustment_basis}</dd></div>
          <div><dt>Observations</dt><dd>Daily synthetic weekdays, not an exchange calendar</dd></div>
          <div><dt>Fetched at (not market freshness)</dt><dd>{p.fetched_at}</dd></div>
        </dl>
        <p className="research-meta">Backend-calculated metrics. Values are shown exactly as supplied.</p>
        {metrics.map(([key, label]) => {
          const metric = item[key]
          return <section key={key} className="research-metric" aria-label={`${p.symbol} ${item.id} ${label}`}>
            <h4>{label}</h4>
            {metric.status === 'available' ? <>
              <p className="research-metric-value">{metric.value} {metric.unit}</p>
              <p>Actual window: {range(metric.window)}</p>
            </> : <>
              <p><strong>Unavailable:</strong> {metric.reason}</p>
              <p>No complete metric window · Unit: {metric.unit}</p>
            </>}
            <p>{metric.observation_count} {metric.observation_count === 1 ? 'observation' : 'observations'}
              {metric.status === 'unavailable' && ` available; ${metric.required_observations} required`}.</p>
          </section>
        })}
        <h4>Limitations</h4>
        <ul>{item.limitations.map((limitation, i) => <li key={i}>{limitation}</li>)}</ul>
      </article>
    })}</div>
  </section>
}
