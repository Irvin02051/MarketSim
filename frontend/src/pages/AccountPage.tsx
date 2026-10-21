import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/authContext'
import '../styles/DashboardPage.css'

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
    <p>Watchlists, saved research, and portfolios are not yet connected to this account.</p>
    <p>The demo dashboard remains public and shows fictional data, not your account balances.</p>
    <p><Link to="/dashboard">Back to demo dashboard</Link></p>
  </main></div>
}
