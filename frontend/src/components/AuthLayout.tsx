import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
export default function AuthLayout({ children, variant }: { children: ReactNode; variant: string }) {
  return <div className={`auth-layout ${variant}-page`}>
    <aside className="brand-panel" aria-label="About MarketSim">
      <Link className="brand" to="/login" aria-label="MarketSim home"><span className="brand-mark" aria-hidden="true">▥</span>MarketSim<span className="brand-dot">.</span></Link>
      <div className="brand-content">
        <span className="eyebrow">● &nbsp; THE MARKET IS YOUR CLASSROOM</span>
        <h2>Build confidence.<br />Find your <span>edge.</span></h2>
        <p>A space to explore the markets, practice your strategy, and become a more informed investor.</p>
        <div className="portfolio-preview" aria-label="Illustrative simulated portfolio. Not live market data.">
          <div className="preview-top"><span>Portfolio overview</span><span className="sample-badge">SIMULATED</span></div>
          <div className="portfolio-value">$104,280<span>.50</span></div>
          <div className="portfolio-gain">↗ +$4,280.50 (4.28%) <span>this month</span></div>
          <svg className="portfolio-chart" viewBox="0 0 400 130" fill="none" aria-hidden="true">
            <defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#43d7a2" stopOpacity=".22" /><stop offset="1" stopColor="#43d7a2" stopOpacity="0" /></linearGradient></defs>
            <path d="M0 30H400M0 70H400M0 110H400" stroke="white" strokeOpacity=".07" strokeDasharray="4 5" />
            <path d="M0 112L18 105L34 111L50 89L68 95L85 78L100 85L119 66L137 76L155 54L175 67L193 60L212 72L232 40L250 48L270 31L290 38L308 22L327 31L347 18L365 24L383 9L400 13V130H0Z" fill="url(#chart-fill)" />
            <path d="M0 112L18 105L34 111L50 89L68 95L85 78L100 85L119 66L137 76L155 54L175 67L193 60L212 72L232 40L250 48L270 31L290 38L308 22L327 31L347 18L365 24L383 9L400 13" stroke="#50dcaa" strokeWidth="2.5" strokeLinejoin="round" />
          </svg>
          <div className="chart-axis"><span>WEEK 01</span><span>WEEK 02</span><span>WEEK 03</span><span>WEEK 04</span></div>
        </div>
        <div className="brand-features"><span><b>01</b>Explore markets</span><span><b>02</b>Practice strategies</span><span><b>03</b>Learn by doing</span></div>
      </div>
      <p className="brand-footer">A market simulator. A smarter place to start.</p>
    </aside>
    <main className="form-panel"><div className="environment-label">● &nbsp; FRONTEND PREVIEW</div><div className="form-container">{children}</div><footer className="form-footer">MarketSim &nbsp; • &nbsp; Built for learning. Designed for growth.</footer></main>
  </div>
}
