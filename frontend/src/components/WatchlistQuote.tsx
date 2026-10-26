import { useLayoutEffect, useRef, useState } from 'react'
import { createQuoteRequest, quoteMessages, requestQuote, signedQuoteNumber } from '../lib/quotes'
import type { QuoteState } from '../lib/quotes'
import type { Symbol } from '../lib/watchlist'

export function QuoteView({ symbol, state, refresh }: { symbol: Symbol; state: QuoteState; refresh: () => void }) {
  return <section className="watchlist-quote" aria-label={`${symbol} reported quote`}>
    <div role="status" aria-live="polite" aria-atomic="true">
      {state.status === 'loading' ? `Loading ${symbol} quote…` : state.status === 'loaded' ? `${symbol} quote loaded.` : ''}
    </div>
    {state.status === 'error' && <p role="alert">{quoteMessages[state.code]}</p>}
    {state.status === 'loaded' && <>
      <p className="quote-provenance"><strong>{state.quote.source === 'demo' ? 'Fictional demo quote' : 'Provider quote — end-of-day data'}</strong></p>
      <dl>
        <div><dt>Reported price</dt><dd>{state.quote.price} {state.quote.currency}</dd></div>
        <div><dt>Reported daily change</dt><dd>{signedQuoteNumber(state.quote.change)} {state.quote.currency} ({signedQuoteNumber(state.quote.change_percent)}%)</dd></div>
        <div><dt>Trading date</dt><dd><time dateTime={state.quote.latest_trading_day}>{state.quote.latest_trading_day}</time></dd></div>
        <div><dt>Source</dt><dd>{state.quote.source === 'demo' ? 'MarketSim demo (demo)' : 'Alpha Vantage (alpha_vantage)'}</dd></div>
        <div><dt>Fetched by backend (not trading time)</dt><dd><time dateTime={state.quote.fetched_at}>{state.quote.fetched_at}</time></dd></div>
        <div><dt>Backend cache</dt><dd>{state.quote.cache_hit ? 'Returned from cache' : 'Not a cache hit'}</dd></div>
      </dl>
      <p>Fetch time does not establish market freshness. {state.quote.source === 'demo'
        ? 'Standalone fictional quotes and historical chart fixtures are separate and do not necessarily reconcile.'
        : 'Provider data is not guaranteed to be live or real-time.'}</p>
    </>}
    <button type="button" disabled={state.status === 'loading'} aria-label={`${state.status === 'error' ? 'Retry' : 'Refresh'} ${symbol} quote`} onClick={refresh}>
      {state.status === 'loading' ? 'Loading quote…' : state.status === 'error' ? 'Retry quote' : 'Refresh quote'}
    </button>
    <p>Quote refresh may return a backend-cached quote.</p>
  </section>
}
export default function WatchlistQuote({ symbol }: { symbol: Symbol }) {
  const [state, setState] = useState<QuoteState>({ status: 'loading' })
  const control = useRef<ReturnType<typeof createQuoteRequest> | null>(null)
  useLayoutEffect(() => {
    const current = createQuoteRequest(signal => requestQuote(import.meta.env.VITE_API_BASE_URL, symbol, signal), setState)
    control.current = current
    void current.refresh()
    return () => { current.dispose(); control.current = null }
  }, [symbol])
  return <QuoteView symbol={symbol} state={state} refresh={() => { void control.current?.refresh() }} />
}
