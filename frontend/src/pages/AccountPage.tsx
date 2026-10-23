import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/authContext'
import { getBrowserAuthClient } from '../lib/auth'
import { createIdentityCheck, identityMessages, requestIdentity } from '../lib/identity'
import type { CheckState } from '../lib/identity'
import '../styles/DashboardPage.css'

function IdentityCheck({ userId }: { userId: string }) {
  const [state, setState] = useState<CheckState>({ status: 'idle' })
  const [check] = useState(() => createIdentityCheck((signal) => requestIdentity(
    import.meta.env.VITE_API_BASE_URL, getBrowserAuthClient()?.auth ?? null, userId, signal,
  ), setState))
  useEffect(() => () => check.cancel(), [check])
  return <section aria-label="Backend identity verification">
    <button type="button" disabled={state.status === 'loading'} onClick={() => void check.start()}>
      {state.status === 'loading' ? 'Verifying backend identity…' : state.status === 'error' ? 'Retry identity verification' : 'Verify backend identity'}
    </button>
    <p role="status" aria-live="polite">
      {state.status === 'loading' ? 'Checking your session and backend identity…'
        : state.status === 'verified' ? 'Backend identity verified.'
          : state.status === 'error' ? identityMessages[state.code] : 'No backend identity check has been performed.'}
    </p>
    {state.status === 'error' && (state.code === 'authentication' || state.code === 'mismatch')
      && <p><Link to="/login">Log in again</Link></p>}
    <p>This is a completed check, not permanent authorization. Future private requests must authenticate independently.</p>
  </section>
}

export default function AccountPage() {
  const auth = useAuth()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    document.title = 'Account | MarketSim'
    heading.current?.focus()
  }, [])
  // Also withhold account details if this component is rendered outside its guard.
  if (auth.status !== 'signed_in') return null
  return <div className="dashboard-page"><main className="dashboard-main">
    <div className="dashboard-intro">
      <h1 ref={heading} tabIndex={-1}>Your account</h1>
      <p>Signed in as: {auth.user.email || 'Email unavailable'}</p>
    </div>
    <IdentityCheck key={auth.user.id} userId={auth.user.id} />
    <p>Saved research and portfolios are not yet connected to this account.</p>
    <p><Link to="/watchlist">My watchlist</Link> — save supported symbols to your account.</p>
    <p>The demo dashboard remains public and shows fictional data, not your account balances.</p>
    <p><Link to="/dashboard">Back to demo dashboard</Link></p>
  </main></div>
}
