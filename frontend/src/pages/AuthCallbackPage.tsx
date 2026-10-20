import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import AuthLayout from '../components/AuthLayout'
import { authMessages, browserCallback, createConfirmationHandler, getBrowserAuthClient } from '../lib/auth'
import type { AuthOutcome } from '../lib/auth'

export default function AuthCallbackPage() {
  const complete = useRef(createConfirmationHandler())
  const [result, setResult] = useState<AuthOutcome | null>(null)
  useEffect(() => {
    document.title = 'Email confirmation | MarketSim'
    document.getElementById('auth-title')?.focus()
    let active = true
    const { origin, pathname, search, hash } = window.location
    void complete.current(getBrowserAuthClient()?.auth ?? null, { origin, pathname, search, hash },
      browserCallback(), () => window.history.replaceState(window.history.state, '', '/auth/callback'))
      .then((outcome) => { if (active) setResult(outcome) })
    return () => { active = false }
  }, [])
  return <AuthLayout variant="login">
    <h1 id="auth-title" tabIndex={-1}>Email confirmation</h1>
    <p role="status">{result === 'failed' ? 'Unable to confirm this email link. It may have expired or already been used. Try logging in or requesting signup again.' : result ? authMessages[result] : 'Completing confirmation…'}</p>
    <p><Link to={result === 'signed_in' ? '/dashboard' : '/login'}>{result === 'signed_in' ? 'Continue to demo dashboard' : 'Back to login'}</Link></p>
  </AuthLayout>
}
