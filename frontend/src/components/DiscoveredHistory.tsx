import { useEffect, useRef, useState } from 'react'
import HistoryChart from './HistoryChart'
import { initialProviderDates } from '../lib/history'
import { createDiscoveredController, requestDiscoveredHistory } from '../lib/discoveredHistory'
import type { DiscoveredState } from '../lib/discoveredHistory'
import type { SearchMatch } from '../lib/stockSearch'
import '../styles/StockHistoryPage.css'

export default function DiscoveredHistory({ reference, selected }: { reference: string; selected: SearchMatch }) {
  const [dates, setDates] = useState(() => initialProviderDates())
  const [state, setState] = useState<DiscoveredState>({ kind: 'idle' })
  const controller = useRef<ReturnType<typeof createDiscoveredController> | null>(null)
  useEffect(() => {
    const current = createDiscoveredController((range, signal) => requestDiscoveredHistory(import.meta.env.VITE_API_BASE_URL, reference, selected.symbol, range, signal), setState)
    controller.current = current
    return () => { current.dispose(); controller.current = null }
  }, [reference, selected.symbol])
  return <section aria-label="Discovered stock price history">
    <h2>Price history: {selected.name} ({selected.symbol})</h2>
    <p>Explicit provider request; raw USD prices, not adjusted for splits or dividends. Recent compact snapshot only.</p>
    <form onSubmit={event => { event.preventDefault(); void controller.current?.load(dates) }}>
      {(['start', 'end'] as const).map(field => <label key={field}>{field === 'start' ? 'Start date' : 'End date'}
        <input type="date" required value={dates[field]} onChange={event => {
          controller.current?.cancel(); setDates({ ...dates, [field]: event.target.value })
        }} /></label>)}
      <button disabled={state.kind === 'loading'} type="submit">{state.kind === 'loading' ? 'Loading history…' : 'Load price history'}</button>
    </form>
    <div role="status" aria-live="polite">
      {state.kind === 'loading' && <p>Loading price history…</p>}
      {state.kind === 'error' && <p>{state.message}{state.available && ` Available: ${state.available.start} through ${state.available.end}.`}</p>}
      {state.kind === 'result' && <p>{state.result.bars.length} observations loaded.</p>}
    </div>
    {state.kind === 'result' && <>
      <p>Source: {state.result.source} / {state.result.data_kind} / {state.result.adjustment_basis} · {state.result.currency}</p>
      <p>Requested: {state.result.requested_range.start}–{state.result.requested_range.end}. Available: {state.result.available_range.start}–{state.result.available_range.end}.
        Returned: {state.result.returned_range ? `${state.result.returned_range.start}–${state.result.returned_range.end}` : 'None'}.</p>
      <p>Fetched: {state.result.fetched_at} · {state.result.cache_hit ? 'Cached snapshot' : 'New snapshot'}. Retrieval time is not market freshness.</p>
      <HistoryChart result={state.result} />
      <ul>{state.result.limitations.map(text => <li key={text}>{text}</li>)}</ul>
      <p>This discovery flow offers no metrics, quotes, research or watchlist support for new symbols.</p>
    </>}
  </section>
}
