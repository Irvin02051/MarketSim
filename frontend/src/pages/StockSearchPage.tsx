import { useEffect, useRef, useState } from 'react'
import DiscoveredHistory from '../components/DiscoveredHistory'
import { Link } from 'react-router-dom'
import { createSearchController, requestSearch, searchMessages } from '../lib/stockSearch'
import type { SearchState } from '../lib/stockSearch'
import '../styles/StockSearchPage.css'

export default function StockSearchPage() {
  const enabled = import.meta.env.VITE_STOCK_SEARCH_ENABLED === 'true'
  const [query, setQuery] = useState('')
  const [state, setState] = useState<SearchState>({ status: 'idle' })
  const controller = useRef<ReturnType<typeof createSearchController> | null>(null)
  useEffect(() => {
    const current = createSearchController((q, signal) => requestSearch(import.meta.env.VITE_API_BASE_URL, q, signal), setState)
    controller.current = current
    return () => { current.dispose(); controller.current = null }
  }, [])
  const loading = state.status === 'loading'
  return <main className="stock-search">
    <Link to="/dashboard">Demo dashboard</Link>
    <h1>Discover stocks</h1>
    <p>Search Alpha Vantage for provider-reported U.S. equities in USD. A match does not guarantee quotes, history, an active listing, or a particular exchange.</p>
    <p>Existing stock pages, quotes, metrics, research and personal watchlists still support only AAPL, MSFT and NVDA. Selection here does not save a stock or fetch prices.</p>
    {!enabled && <p role="status">Stock search is disabled in this configuration.</p>}
    <form onSubmit={event => { event.preventDefault(); if (enabled) void controller.current?.submit(query) }}>
      <label htmlFor="stock-query">Company name or ticker</label>
      <input id="stock-query" value={query} onChange={event => { controller.current?.cancel(); setQuery(event.target.value); setState({ status: 'idle' }) }} disabled={!enabled || loading} maxLength={160} />
      <button type="submit" disabled={!enabled || loading}>{loading ? 'Searching…' : state.status === 'error' ? 'Retry search' : 'Search'}</button>
      {loading && <button type="button" onClick={() => controller.current?.cancel()}>Cancel search</button>}
    </form>
    <div role="status" aria-live="polite" aria-atomic="true">
      {loading && <p>Searching…</p>}
      {state.status === 'error' && <p>{searchMessages[state.code]}</p>}
      {state.status === 'loaded' && <>
        <p>{state.result.matches.length ? `${state.result.matches.length} matches for ${state.result.query}.` : `No in-scope matches for ${state.result.query}.`}</p>
        {state.selected && <p>Selected {state.selected.name} ({state.selected.symbol}) for review. Selection itself makes no additional request.</p>}
      </>}
    </div>
      {enabled && import.meta.env.VITE_REAL_HISTORY_ENABLED === 'true' && state.status === 'loaded' && state.selected &&
      <DiscoveredHistory key={`${state.result.selection_ref}:${state.selected.symbol}`} reference={state.result.selection_ref} selected={state.selected} />}
    {state.status === 'loaded' && <>
      <p>Source: Alpha Vantage · Retrieved: {state.result.fetched_at} · {state.result.cache_hit ? 'Cached search' : 'New search'}. Retrieval time does not establish listing freshness.</p>
      <ul>{state.result.matches.map(row => <li key={row.symbol}>
        <h2>{row.name}</h2><p>{row.symbol} · {row.instrument_type} · {row.region} · {row.currency}</p>
        <p>Search relevance: {row.match_score} (not investment quality)</p>
        <button type="button" aria-pressed={state.selected?.symbol === row.symbol} onClick={() => controller.current?.select(row.symbol)}>Select {row.symbol}</button>
      </li>)}</ul>
    </>}
  </main>
}
