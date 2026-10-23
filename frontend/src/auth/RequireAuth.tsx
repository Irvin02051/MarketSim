import type { ReactNode } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './authContext'
import '../styles/DashboardPage.css'

/** UI boundary only. Private APIs must independently verify and authorize requests. */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const location = useLocation()
  if (auth.status === 'signed_in') return children
  if (auth.status === 'signed_out') {
    return <Navigate to="/login" replace state={(location.pathname === '/account' || location.pathname === '/watchlist') ? { returnTo: location.pathname } : null} />
  }
  return <div className="dashboard-page"><main className="dashboard-main">
    <h1>Account access</h1>
    {auth.status === 'loading'
      ? <p role="status" aria-live="polite">Checking your session…</p>
      : <><p role="status">Account access is unavailable. Please try logging in again or continue to the demo.</p>
        <nav aria-label="Account access options"><p><Link to="/login">Log in</Link></p>
          <p><Link to="/dashboard">View demo dashboard</Link></p></nav></>}
  </main></div>
}
