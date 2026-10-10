import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import '../styles/DashboardPage.css'

// Fictional display constants only; no live pricing or trading calculations.
const summaryCards = [
  { label: 'Virtual cash', value: '$10,000', note: 'Your demo starting balance' },
  { label: 'Holdings value', value: '$0', note: 'No investments held' },
  { label: 'Total portfolio value', value: '$10,000', note: 'Virtual cash + holdings', featured: true },
]

const sampleWatchlist = [
  { symbol: 'AAPL', company: 'Apple Inc.', price: '$200.00', change: 'Up 1.25%', direction: 'up' },
  { symbol: 'MSFT', company: 'Microsoft Corporation', price: '$420.00', change: 'Down 0.50%', direction: 'down' },
  { symbol: 'NVDA', company: 'NVIDIA Corporation', price: '$125.00', change: 'Up 2.00%', direction: 'up' },
]

export default function DashboardPage() {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    document.title = 'Dashboard | MarketSim'
    headingRef.current?.focus()
  }, [])

  return (
    <div className="dashboard-page">
      <a className="dashboard-skip-link" href="#dashboard-main">Skip to dashboard content</a>
      <header className="dashboard-header">
        <div className="dashboard-header-inner">
          <Link className="dashboard-brand" to="/dashboard" aria-label="MarketSim dashboard">
            <span className="dashboard-brand-mark" aria-hidden="true">▥</span>
            <span>MarketSim<span className="dashboard-brand-dot">.</span></span>
          </Link>
          <nav className="dashboard-navigation" aria-label="Dashboard navigation">
            <span className="dashboard-demo-badge">Demo mode</span>
            <Link className="dashboard-back-link" to="/login">Back to login <span aria-hidden="true">↗</span></Link>
          </nav>
        </div>
      </header>

      <main className="dashboard-main" id="dashboard-main" tabIndex={-1}>
        <div className="dashboard-intro">
          <p className="dashboard-kicker">YOUR PRACTICE SPACE</p>
          <h1 ref={headingRef} tabIndex={-1}>Portfolio overview</h1>
          <p>Welcome to MarketSim. Explore a sample portfolio and get familiar with your future investing workspace.</p>
        </div>

        <section className="dashboard-summary" aria-label="Demo portfolio summary">
          {summaryCards.map((card) => (
            <article className={`dashboard-summary-card${card.featured ? ' dashboard-summary-card-featured' : ''}`} key={card.label}>
              <h2>{card.label}</h2>
              <p className="dashboard-summary-value">{card.value}</p>
              <p className="dashboard-summary-note">{card.note}</p>
            </article>
          ))}
        </section>

        <div className="dashboard-panels">
          <section className="dashboard-panel" aria-labelledby="watchlist-title">
            <div className="dashboard-panel-heading">
              <p className="dashboard-kicker">A GLIMPSE AT THE MARKET</p>
              <h2 id="watchlist-title">Sample watchlist</h2>
              <p id="watchlist-description">Sample data — not live market prices.</p>
            </div>
            <ul className="dashboard-watchlist" aria-describedby="watchlist-description">
              {sampleWatchlist.map((stock) => (
                <li className="dashboard-stock" key={stock.symbol}>
                  <div className="dashboard-stock-identity">
                    <span className="dashboard-stock-monogram" aria-hidden="true">{stock.symbol[0]}</span>
                    <div>
                      <h3>{stock.symbol}</h3>
                      <p>{stock.company}</p>
                    </div>
                  </div>
                  <dl className="dashboard-stock-numbers">
                    <div><dt>Sample price</dt><dd>{stock.price}</dd></div>
                    <div><dt>Daily change</dt><dd className={`dashboard-change dashboard-change-${stock.direction}`}>{stock.change}</dd></div>
                  </dl>
                </li>
              ))}
            </ul>
            <p className="dashboard-panel-note">Fictional prices in USD, shown only to illustrate the dashboard.</p>
          </section>

          <section className="dashboard-panel dashboard-holdings" aria-labelledby="holdings-title">
            <div className="dashboard-panel-heading">
              <p className="dashboard-kicker">ROOM TO GROW</p>
              <h2 id="holdings-title">Your portfolio</h2>
              <p>A fresh start for your practice journey.</p>
            </div>
            <div className="dashboard-empty-state">
              <span className="dashboard-empty-icon" aria-hidden="true">▥</span>
              <h3>No holdings yet</h3>
              <p>Your demo portfolio starts with $10,000 in virtual cash and no stocks.</p>
              <span className="dashboard-availability">Layout preview</span>
              <p>Paper trading is not available in this demo yet. No orders can be placed.</p>
            </div>
          </section>
        </div>
      </main>

      <footer className="dashboard-footer">
        <span>MarketSim · Built for learning.</span>
        <p>This is an educational simulation, not financial advice.</p>
      </footer>
    </div>
  )
}
