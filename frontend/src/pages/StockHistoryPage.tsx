import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import HistoryChart from '../components/HistoryChart'
import { DEMO_HISTORY_END, HISTORY_RANGES, HISTORY_SYMBOLS, HistoryError, historyDates, historySymbol, requestHistory, utcDate,
  createProviderHistoryController, initialProviderDates, providerHistoryEnabled } from '../lib/history'
import type { HistoryRange, HistoryResult, HistorySymbol, ProviderHistoryState } from '../lib/history'
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

function ProviderHistory({ symbol }: { symbol: HistorySymbol }) {
  const [dates, setDates] = useState(() => initialProviderDates())
  const [state, setState] = useState<ProviderHistoryState>({ kind: 'idle' })
  const [controller] = useState(() => createProviderHistoryController(true, setState))
  useEffect(() => () => controller.cancel(), [controller])
  function change(field: 'start' | 'end', value: string) {
    controller.cancel()
    setState({ kind: 'idle' })
    setDates((old) => ({ ...old, [field]: value }))
  }
  const result = state.kind === 'result' ? state.result : null
  return <section className="dashboard-panel history-results" aria-label={`${symbol} provider history`}>
    <h2>Alpha Vantage daily closing prices</h2>
    <p>End-of-day data, not real-time quotes. Raw/unadjusted prices; splits and dividends are not handled.</p>
    <p className="history-note" id="provider-date-help">Dates are inclusive, at most 90 calendar days.
      Defaults are the previous 30 UTC calendar dates ending yesterday. They do not guarantee snapshot availability or completed market sessions.
      Changing selections clears results; only Load sends a request.</p>
    <form className="history-provider-form" noValidate onSubmit={(event) => {
      event.preventDefault()
      void controller.load(import.meta.env.VITE_API_BASE_URL, symbol, dates)
    }}>
      <label>Start date<input type="date" value={dates.start} required aria-describedby="provider-date-help"
        onChange={(event) => change('start', event.target.value)} /></label>
      <label>End date<input type="date" value={dates.end} required aria-describedby="provider-date-help"
        onChange={(event) => change('end', event.target.value)} /></label>
      <button type="submit" disabled={state.kind === 'loading'}>{state.kind === 'loading' ? 'Loading provider history…' : 'Load provider history'}</button>
    </form>
    <p role="status" aria-live="polite" aria-atomic="true">
      {state.kind === 'idle' ? 'No provider request sent for this selection.'
        : state.kind === 'loading' ? `Loading ${symbol} provider history…`
        : state.kind === 'error' ? state.message : `${state.result.bars.length} provider observations loaded for ${symbol}.`}
    </p>
    {state.kind === 'error' && state.available && <p>Available snapshot bounds: {state.available.start} – {state.available.end}. Choose dates, then Load.</p>}
    {result && <>
      <p>Requested: {result.requested_range.start} – {result.requested_range.end} (inclusive)</p>
      <p>Available snapshot: {result.available_range.start} – {result.available_range.end} (not a guarantee of complete sessions)</p>
      <p>Returned: {result.returned_range ? `${result.returned_range.start} – ${result.returned_range.end}` : 'No observations'}</p>
      <HistoryChart result={result} />
      <p className="history-note">Source: Alpha Vantage · End-of-day · Adjustment basis: unadjusted</p>
      <p className="history-note">Fetched at: {result.fetched_at} (retrieval time, not market freshness)</p>
      <p className="history-note">Cache: {result.cache_hit ? 'Reused cached snapshot' : 'Newly fetched snapshot'} · Provider timezone: {result.provider_timezone ?? 'Unknown'}</p>
      <ul className="history-note">{result.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul>
    </>}
  </section>
}

export default function StockHistoryPage() {
  const { symbol: raw } = useParams()
  const symbol = historySymbol(raw)
  const navigate = useNavigate()
  const [range, setRange] = useState<HistoryRange>('1M')
  const [mode, setMode] = useState<'demo' | 'provider'>('demo')
  const providerAllowed = providerHistoryEnabled(import.meta.env.VITE_REAL_HISTORY_ENABLED)
  const real = providerAllowed && mode === 'provider'
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { document.title = `${symbol ?? 'Unsupported stock'} history | MarketSim`; heading.current?.focus() }, [symbol])
  return <div className="dashboard-page history-page">
    <a className="dashboard-skip-link" href="#history-main">Skip to stock history</a>
    <header className="dashboard-header"><div className="dashboard-header-inner">
      <Link className="dashboard-brand" to="/dashboard">MarketSim<span className="dashboard-brand-dot">.</span></Link>
      <nav className="dashboard-navigation" aria-label="Stock navigation"><Link to="/dashboard">Dashboard</Link><Link to="/research">Stock research</Link></nav>
    </div></header>
    <main className="dashboard-main" id="history-main">
      <div className="dashboard-intro"><p className="dashboard-kicker">{real ? 'PRIVATE LOCAL PROVIDER HISTORY' : 'EXPLORE THE DEMO'}</p>
        <h1 ref={heading} tabIndex={-1}>{symbol ? `${symbol} price history` : 'Unsupported stock'}</h1>
        {real ? <><p className="history-banner">Alpha Vantage · End-of-day · Raw/unadjusted history</p>
          <p>Private local testing only. Not recommendations or forecasts. Charts do not enable real-data metrics or Gemini research.</p></>
          : <><p className="history-banner">Fictional historical demo · ranges end {anchorLabel}.</p>
            <p>Separate historical fixtures, not the dashboard’s sample prices or current market quotes.</p></>}
      </div>
      {providerAllowed && <div className="history-controls" role="group" aria-label="History data mode">
        <button aria-pressed={!real} onClick={() => setMode('demo')}>Fictional demo history</button>
        <button aria-pressed={real} onClick={() => setMode('provider')}>Provider history (private local)</button>
      </div>}
      <div className="history-controls">
        <label htmlFor="history-symbol">Stock symbol</label>
        <select id="history-symbol" value={symbol ?? ''} onChange={(event) => navigate(`/stocks/${event.target.value}`)}>
          {!symbol && <option value="" disabled>Choose a supported stock</option>}
          {HISTORY_SYMBOLS.map((item) => <option key={item}>{item}</option>)}
        </select>
        {!real && <div role="group" aria-label="Historical date range">{HISTORY_RANGES.map((item) =>
          <button key={item} aria-pressed={range === item} onClick={() => setRange(item)}>{item}</button>)}</div>}
      </div>
      {symbol ? real ? <ProviderHistory key={`provider:${symbol}`} symbol={symbol} /> : <HistoryRequest key={`demo:${symbol}:${range}`} symbol={symbol} range={range} />
        : <p role="status">This stock is not supported. Choose AAPL, MSFT, or NVDA. No history request was sent.</p>}
    </main>
  </div>
}
