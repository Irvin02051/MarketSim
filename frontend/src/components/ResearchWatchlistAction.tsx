import { useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/authContext'
import { getBrowserAuthClient } from '../lib/auth'
import { createResearchSave, eligibleSymbols } from '../lib/researchWatchlist'
import type { SaveState, ResearchScope } from '../lib/researchWatchlist'
import type { ResearchResult } from '../lib/research'
import { messages, requestWatchlist } from '../lib/watchlist'

type Props = { result: ResearchResult; generation: number; scope: ResearchScope }

function AccountAction({ result, generation, scope, account }: Props & { account: string }) {
  const eligible = eligibleSymbols(result)
  const [state, setState] = useState<SaveState>({ symbol: eligible[0], phase: 'idle', code: null })
  const control = useRef<ReturnType<typeof createResearchSave> | null>(null)
  const reviewButton = useRef<HTMLButtonElement>(null)
  const feedback = useRef<HTMLParagraphElement>(null)
  const confirmationHeading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    const auth = getBrowserAuthClient()?.auth ?? null
    let identityValid = true
    const action = createResearchSave({ result, generation, account },
      () => identityValid && scope.isCurrent(generation),
      (symbol, signal) => requestWatchlist(import.meta.env.VITE_API_BASE_URL, auth, account, { method: 'POST', symbol }, signal), setState)
    control.current = action
    const invalidate = () => { identityValid = false; action.dispose() }
    const unregister = scope.register(generation, invalidate)
    const subscription = auth?.onAuthStateChange((_event, session) => {
      if (!session || session.user.id !== account) invalidate()
    }).data.subscription
    return () => {
      subscription?.unsubscribe(); invalidate(); control.current = null
      unregister()
    }
  }, [result, generation, account, scope])
  useLayoutEffect(() => {
    if (state.phase === 'review') confirmationHeading.current?.focus()
    if (['saved', 'duplicate', 'error', 'uncertain'].includes(state.phase)) feedback.current?.focus()
  }, [state.phase])
  const busy = state.phase === 'saving'
  const blocked = state.phase === 'uncertain' || state.phase === 'invalidated'
  const historical = result.historical_evidence.filter(e => e.provenance.symbol === state.symbol)
  const fictional = historical.length > 0 || result.quotes?.evidence.some(e => e.quote.symbol === state.symbol
    && (e.fictional || e.quote.source === 'demo' || e.quote.data_kind === 'fictional'))
  return <>
    <label htmlFor="research-save-symbol">Analyzed stock</label>
    <select id="research-save-symbol" value={state.symbol} disabled={busy || state.phase === 'invalidated'}
      onChange={event => control.current?.select(event.target.value as SaveState['symbol'])}>
      {eligible.map(symbol => <option key={symbol}>{symbol}</option>)}
    </select>
    {fictional && <p className="research-fictional">This stock appears in fictional demo evidence, not actual market performance.</p>}
    {result.status !== 'answered' && <p>The explanation was not completed. Saving a symbol does not imply completed analysis.</p>}
    {historical.map(e => <div key={e.id}>
      {e.provenance.status === 'empty' && <p>No historical observations were returned for {state.symbol}.</p>}
      {e.provenance.coverage === 'partial_overlap' && <p>Historical coverage is partial.</p>}
      {[e.price_change, e.sma_20, e.sma_50, e.adjacent_return_volatility_20].some(m => m.status === 'unavailable')
        && <p>Some historical metrics are unavailable. Review the evidence limitations above.</p>}
    </div>)}
    <div className="research-actions"><button type="button" ref={reviewButton} disabled={busy || blocked}
      onClick={() => control.current?.review()}>Review save</button></div>
    {(state.phase === 'review' || busy) && <section className="research-save-confirmation" aria-labelledby="research-save-confirmation-title">
      <h3 id="research-save-confirmation-title" ref={confirmationHeading} tabIndex={-1}>Add {state.symbol} to my watchlist?</h3>
      <p>This saves a symbol only, not a trade or investment recommendation.</p>
      <div className="research-actions">
        <button type="button" disabled={busy} onClick={() => { void control.current?.confirm() }}>Confirm add</button>
        <button type="button" disabled={busy} onClick={() => { if (control.current?.cancel()) reviewButton.current?.focus() }}>Cancel</button>
      </div>
    </section>}
    <p ref={feedback} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true">
      {busy ? `Saving ${state.symbol}…` : state.phase === 'saved' ? `${state.symbol} saved to your watchlist.`
        : state.phase === 'duplicate' ? `${state.symbol} is already saved.`
          : state.phase === 'error' || state.phase === 'uncertain' ? 'Save not confirmed. Review the message below.'
          : state.phase === 'invalidated' ? 'This confirmation is no longer valid. No action will resume automatically.' : ''}
    </p>
    {state.phase === 'error' && <p role="alert">{state.code ? messages[state.code] : 'Unable to save.'} Review again before confirming another attempt.</p>}
    {state.phase === 'error' && state.code === 'authentication' && <p><Link to="/login">Log in again</Link>. No save will resume automatically.</p>}
    {state.phase === 'uncertain' && <p role="alert">This save may have completed. Do not retry here. Open My watchlist and refresh saved symbols to check before trying again.</p>}
    <p>After Confirm add, leaving this result or cancelling a browser request cannot undo a save that already reached the server. Check My watchlist if its outcome is unclear.</p>
    <p><Link to="/watchlist">My watchlist</Link></p>
  </>
}

export default function ResearchWatchlistAction(props: Props) {
  const auth = useAuth()
  const eligible = eligibleSymbols(props.result)
  return <section className="research-save" aria-label="Save an analyzed stock">
    <h2>Save an analyzed stock</h2>
    <p>Choose a stock present in this result’s evidence. Saving is your choice, not a model recommendation.</p>
    {!eligible.length ? <p>No supported stocks are present in validated evidence.</p>
      : auth.status === 'loading' ? <p role="status">Checking your session…</p>
        : auth.status === 'unavailable' ? <p role="status">Saving is unavailable. You can still read and request research.</p>
          : auth.status === 'signed_out' ? <p><Link to="/login">Log in</Link> to save a stock. No pending save will resume after login.</p>
            : <AccountAction key={auth.user.id} {...props} account={auth.user.id} />}
  </section>
}
