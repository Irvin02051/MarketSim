import { useEffect, useId, useState } from 'react'
import type { ProviderHistoryResult } from '../lib/history'
import { createHistoryMetricsController } from '../lib/historyMetrics'
import type { HistoryMetricsState } from '../lib/historyMetrics'

export function RawPriceStatistics({ state, load }: { state: HistoryMetricsState; load: () => void }) {
  const heading = useId()
  const result = state.kind === 'result' ? state.result : null
  const items = result ? [
    ['Raw closing-price change (%)', result.raw_price_change],
    ['Raw SMA20 (USD)', result.raw_sma_20],
    ['Raw SMA50 (USD)', result.raw_sma_50],
    ['Raw-return sample standard deviation (%; not annualized)', result.raw_return_sample_stddev_20],
  ] as const : []
  return <section className="history-metrics" aria-labelledby={heading}>
    <h3 id={heading}>Raw-price statistics</h3>
    <p>Load backend-calculated statistics for this chart. This uses the backend history cache when available,
      but may require a provider request if the cache has expired.</p>
    <button type="button" onClick={load} disabled={state.kind === 'loading'}>
      {state.kind === 'loading' ? 'Loading raw-price metrics…' : state.kind === 'error' ? 'Retry raw-price metrics' : 'Load raw-price metrics'}
    </button>
    <p role="status" aria-live="polite" aria-atomic="true">
      {state.kind === 'idle' ? 'No metrics request sent.' : state.kind === 'loading' ? 'Loading raw-price metrics…'
        : state.kind === 'error' ? state.message : 'Raw-price statistics loaded for this chart snapshot.'}
    </p>
    <p>Prices are unadjusted; corporate actions are unchecked. Raw price change is not total return or shareholder performance.
      Raw-return variability is not a reliable investment-risk measure. These are historical descriptions, not predictions or trading signals.</p>
    {result && <>
      <dl className="history-metrics-grid">{items.map(([label, metric]) => <div key={label}>
        <dt>{label}</dt><dd>
          {metric.status === 'available' ? <strong className="history-metric-value">{metric.value} {metric.unit === 'percent' ? '%' : metric.unit}</strong>
            : <span>Unavailable: {metric.reason}</span>}
          <span>Observation window: {metric.window ? `${metric.window.start} – ${metric.window.end}` : 'Unavailable'}</span>
          <span>Observations: {metric.observation_count} · Required: {metric.required_observations}</span>
          {metric === result.raw_return_sample_stddev_20 && <span>Adjacent returns: {result.return_count}</span>}
        </dd>
      </div>)}</dl>
      <p className="history-note">Calculated by backend · Alpha Vantage · End-of-day · Unadjusted</p>
      <p className="history-note">Source fetched at: {result.fetched_at} (retrieval time, not market freshness)</p>
      <p className="history-note">Metrics cache: {result.cache_hit ? 'Reused cached snapshot' : 'Newly fetched snapshot'} · Calendar completeness: not verified</p>
      <details><summary>Source limitations (retrieval statements)</summary>
        <p>These describe the source service and existing fictional research pipeline; the separate raw calculator does not change that boundary.</p>
        <ul>{result.source_limitations.map((item, i) => <li key={i}>{item}</li>)}</ul>
      </details>
      <details><summary>Calculation limitations</summary>
        <ul>{result.calculation_limitations.map((item, i) => <li key={i}>{item}</li>)}</ul>
      </details>
    </>}
  </section>
}

// Parent keys this component by chart-load generation and removes it on selection changes.
export default function RealHistoryMetrics({ history, base }: { history: ProviderHistoryResult; base: unknown }) {
  const [state, setState] = useState<HistoryMetricsState>({ kind: 'idle' })
  const [controller] = useState(() => createHistoryMetricsController(history, setState))
  useEffect(() => () => controller.cancel(), [controller])
  return <RawPriceStatistics state={state} load={() => { void controller.load(base) }} />
}
