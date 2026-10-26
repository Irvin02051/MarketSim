import { useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import WatchlistQuote from '../components/WatchlistQuote'
import { useAuth } from '../auth/authContext'
import { getBrowserAuthClient } from '../lib/auth'
import { createWatchlist, initialState, messages, requestWatchlist, symbols } from '../lib/watchlist'
import type { Symbol, WatchlistState } from '../lib/watchlist'
import '../styles/DashboardPage.css'
import '../styles/WatchlistPage.css'

export function WatchlistView({ state, selected, select, execute }: {
  state: WatchlistState; selected: Symbol; select: (symbol: Symbol) => void;
  execute: (op: { method: 'GET' } | { method: 'POST' | 'DELETE'; symbol: Symbol }) => void
}) {
  const locked = !!state.busy || !state.loaded || state.needsRefresh
  return <section className="personal-watchlist" aria-label="Saved symbols">
    <form onSubmit={event => { event.preventDefault(); execute({ method: 'POST', symbol: selected }) }}>
      <label htmlFor="watchlist-symbol">Symbol</label>
      <select id="watchlist-symbol" value={selected} disabled={locked} onChange={event => select(event.target.value as Symbol)}>
        {symbols.map(symbol => <option key={symbol} value={symbol}>{symbol}</option>)}
      </select>
      <button type="submit" disabled={locked}>{state.busy === 'POST' ? 'Adding…' : 'Add'}</button>
      <button type="button" disabled={!!state.busy} onClick={() => execute({ method: 'GET' })}>
        {state.busy === 'GET' ? 'Loading…' : state.code ? 'Refresh saved symbols / retry' : 'Refresh saved symbols'}
      </button>
    </form>
    <p>Refresh saved symbols reloads membership only. Use each quote’s refresh button to update its quote.</p>
    <div role="status" aria-live="polite" aria-atomic="true">
      {state.busy === 'GET' ? 'Loading your watchlist…' : state.busy === 'DELETE' ? 'Removing symbol…'
        : state.busy === 'POST' ? 'Saving symbol…' : state.notice}
    </div>
    {state.code && <p role={state.code === 'duplicate' ? 'status' : 'alert'}>{messages[state.code]}</p>}
    {state.code === 'authentication' && <p><Link to="/login" state={{ returnTo: '/watchlist' }}>Log in again</Link></p>}
    {state.loaded && state.items.length === 0 && <p>No symbols saved yet. Choose a symbol and add it to your watchlist.</p>}
    {state.loaded && state.items.length > 0 && <ul aria-label="My saved symbols">
      {state.items.map(row => <li key={row.symbol}>
        <div><Link to={`/stocks/${row.symbol}`}>{row.symbol}</Link>
          <p>Saved <time dateTime={row.created_at}>{new Date(row.created_at).toISOString().slice(0, 10)} (UTC)</time></p></div>
        <button type="button" disabled={locked} aria-label={`Remove ${row.symbol} from my watchlist`}
          onClick={() => execute({ method: 'DELETE', symbol: row.symbol })}>Remove</button>
        <WatchlistQuote symbol={row.symbol} />
      </li>)}
    </ul>}
  </section>
}

function UserWatchlist({ userId }: { userId: string }) {
  const [state, setState] = useState<WatchlistState>(initialState)
  const [selected, setSelected] = useState<Symbol>('AAPL')
  const control = useRef<ReturnType<typeof createWatchlist> | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    document.title = 'My watchlist | MarketSim'
    heading.current?.focus()
    const auth = getBrowserAuthClient()?.auth ?? null
    const current = createWatchlist((op, signal) => requestWatchlist(import.meta.env.VITE_API_BASE_URL, auth, userId, op, signal), setState)
    control.current = current
    // Clear data synchronously on SDK identity loss, including between request completion and React's next render.
    const subscription = auth?.onAuthStateChange((_event, session) => {
      if (!session || session.user.id !== userId) current.dispose()
    }).data.subscription
    void current.execute({ method: 'GET' })
    return () => { subscription?.unsubscribe(); current.dispose(); control.current = null }
  }, [userId])
  return <div className="dashboard-page"><main className="dashboard-main">
    <div className="dashboard-intro"><h1 ref={heading} tabIndex={-1}>My watchlist</h1>
      <p>Save symbols to your account. Saved symbols are not holdings, trades, or recommendations.</p></div>
    <nav className="watchlist-navigation" aria-label="Watchlist navigation"><Link to="/account">Account</Link><Link to="/dashboard">Demo dashboard</Link></nav>
    <p>Stock links show fictional historical charts. The dashboard’s sample watchlist is separate from your saved symbols.</p>
    <WatchlistView state={state} selected={selected} select={setSelected} execute={op => { void control.current?.execute(op) }} />
  </main></div>
}
export default function WatchlistPage() {
  const auth = useAuth()
  return auth.status === 'signed_in' ? <UserWatchlist key={auth.user.id} userId={auth.user.id} /> : null
}
