import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import HistoryChart from '../components/HistoryChart'
import { DEMO_HISTORY_END, HISTORY_RANGES, HISTORY_SYMBOLS, HistoryError, historyDates, historySymbol, requestHistory, utcDate } from '../lib/history'
import type { HistoryRange, HistoryResult, HistorySymbol } from '../lib/history'
import '../styles/DashboardPage.css'
import '../styles/StockHistoryPage.css'

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'result'; result: HistoryResult }
const anchorLabel = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric',
}).format(utcDate(DEMO_HISTORY_END))

// Keyed by selection so a new symbol/range can never render the old chart.
function HistoryRequest({ symbol, range }: { symbol: HistorySymbol; range: HistoryRange }) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<State>({ kind: 'loading' })
  const requested = historyDates(range)
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    requestHistory(import.meta.env.VITE_API_BASE_URL, symbol, historyDates(range), controller.signal)
      .then((result) => { if (active) setState({ kind: 'result', result }) })
      .catch((error) => {
        if (active) setState({ kind: 'error', message: error instanceof HistoryError
          ? error.message : 'History could not be loaded. Please try again.' })
      })
    return () => { active = false; controller.abort() }
  }, [symbol, range, attempt])
  const result = state.kind === 'result' ? state.result : null
  return <section className="dashboard-panel history-results" aria-label={`${symbol} historical prices`}>
    <h2>Daily closing prices</h2>
    <p>Requested: {requested.start} – {requested.end} (inclusive)</p>
    <p role="status" aria-live="polite" aria-atomic="true">
      {state.kind === 'loading' ? `Loading ${symbol} history…` : state.kind === 'error' ? state.message
        : `${result?.bars.length} fictional observations loaded for ${symbol}. ${result?.status === 'empty' ? 'No data in this range.' : ''}`}
    </p>
    {state.kind === 'error' && <button onClick={() => { setState({ kind: 'loading' }); setAttempt((value) => value + 1) }}>Retry history</button>}
    {result && <>
      <p>Returned: {result.returned_range ? `${result.returned_range.start} – ${result.returned_range.end}` : 'No observations'}</p>
      {result.coverage !== 'within_fixture' && <p className="history-banner">Coverage warning: {result.coverage === 'partial_overlap'
        ? 'Only part of the requested range overlaps the fixtures.' : 'The requested range is outside fixture coverage.'}</p>}
      <HistoryChart result={result} />
      <p>{result.label}</p>
      <p className="history-note">Source: {result.source} · Adjustment basis: {result.adjustment_basis} · Synthetic weekday observations</p>
      <p className="history-note">Generated at: {result.fetched_at} (not market freshness)</p>
      <ul className="history-note">{result.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul>
    </>}
  </section>
}

export default function StockHistoryPage() {
  const { symbol: raw } = useParams()
  const symbol = historySymbol(raw)
  const navigate = useNavigate()
  const [range, setRange] = useState<HistoryRange>('1M')
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { document.title = `${symbol ?? 'Unsupported stock'} history | MarketSim`; heading.current?.focus() }, [symbol])
  return <div className="dashboard-page history-page">
    <a className="dashboard-skip-link" href="#history-main">Skip to stock history</a>
    <header className="dashboard-header"><div className="dashboard-header-inner">
      <Link className="dashboard-brand" to="/dashboard">MarketSim<span className="dashboard-brand-dot">.</span></Link>
      <nav className="dashboard-navigation" aria-label="Stock navigation"><Link to="/dashboard">Dashboard</Link><Link to="/research">Stock research</Link></nav>
    </div></header>
    <main className="dashboard-main" id="history-main">
      <div className="dashboard-intro"><p className="dashboard-kicker">EXPLORE THE DEMO</p>
        <h1 ref={heading} tabIndex={-1}>{symbol ? `${symbol} price history` : 'Unsupported stock'}</h1>
        <p className="history-banner">Fictional historical demo · ranges end {anchorLabel}.</p>
        <p>Separate historical fixtures, not the dashboard’s sample prices or current market quotes.</p>
      </div>
      <div className="history-controls">
        <label htmlFor="history-symbol">Stock symbol</label>
        <select id="history-symbol" value={symbol ?? ''} onChange={(event) => navigate(`/stocks/${event.target.value}`)}>
          {!symbol && <option value="" disabled>Choose a supported stock</option>}
          {HISTORY_SYMBOLS.map((item) => <option key={item}>{item}</option>)}
        </select>
        <div role="group" aria-label="Historical date range">{HISTORY_RANGES.map((item) =>
          <button key={item} aria-pressed={range === item} onClick={() => setRange(item)}>{item}</button>)}</div>
      </div>
      {symbol ? <HistoryRequest key={`${symbol}:${range}`} symbol={symbol} range={range} />
        : <p role="status">This stock is not supported. Choose AAPL, MSFT, or NVDA. No history request was sent.</p>}
    </main>
  </div>
}
