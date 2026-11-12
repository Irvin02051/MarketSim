import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import RealResearchResults from '../components/RealResearchResults'
import { createRealResearchController, realResearchEnabled, resultHeading } from '../lib/realResearch'
import type { RealState } from '../lib/realResearch'
import '../styles/RealResearchPage.css'

const examples = [
  'Report Apple raw closing-price change from 2026-10-01 to 2026-10-30.',
  'Compare Apple and Microsoft raw closing-price change from 2026-10-01 to 2026-10-30.',
]
export default function RealResearchPage() {
  const enabled = realResearchEnabled(import.meta.env.VITE_REAL_RESEARCH_ENABLED)
  const [draft, setDraft] = useState(''), [state, setState] = useState<RealState>({ kind: 'idle' })
  const [controller] = useState(() => createRealResearchController(enabled, setState))
  useEffect(() => () => controller.cancel(), [controller])
  const loading = state.kind === 'loading'
  return <main className="real-research-page">
    <nav aria-label="Research navigation"><Link to="/research">Back to existing research</Link> · <Link to="/dashboard">Demo dashboard</Link></nav>
    <h1>Real-data research — private local</h1>
    <p>Gemini plans your question before retrieval. The backend retrieves history, calculates metrics and renders findings.
      Gemini does not inspect the provider results.</p>
    <p>Unadjusted end-of-day history, not real-time prices. Corporate actions and calendar completeness are unchecked.
      Raw price change is not total return; raw variability is not a reliable investment-risk measure or annualized volatility.
      These are descriptions, not predictions or recommendations.</p>
    <p>The frontend flag is not authentication or permission for public deployment or display.</p>
    {!enabled ? <p role="status">Real research is disabled. Enable VITE_REAL_RESEARCH_ENABLED=true only for private local testing.
      No request has been sent.</p> : <>
      <form onSubmit={(event) => { event.preventDefault(); void controller.submit(import.meta.env.VITE_API_BASE_URL, draft) }}>
        <label htmlFor="real-question">Research instruction</label>
        <p id="real-question-help">Use supported stocks AAPL, MSFT or NVDA and explicit YYYY-MM-DD dates (up to 90 calendar days).
          Instructions only: no personal information or pasted datasets. The compact snapshot moves over time.</p>
        <textarea id="real-question" aria-describedby="real-question-help" rows={5} value={draft}
          onChange={(event) => setDraft(event.target.value)} required />
        <div className="real-examples">{examples.map((q, i) => <button key={q} type="button" onClick={() => setDraft(q)}>
          {i === 0 ? 'Fill single-stock example' : 'Fill two-stock example'}</button>)}</div>
        <button type="submit" disabled={loading}>{loading ? 'Planning and retrieving…' : 'Submit real research'}</button>
      </form>
      <p>Each explicit submission may use one Gemini call and up to two provider attempts. Cache reuse can reduce provider attempts.
        No polling or automatic retries. Leaving this page cancels browser waiting, but upstream work may still complete.</p>
      <p role="status" aria-live="polite" aria-atomic="true">{state.kind === 'idle' ? 'No request sent.' : loading
        ? 'Planning and retrieving. Please wait.' : state.kind === 'error' ? state.message
          : state.kind === 'result' ? `${resultHeading(state.result)}. ${state.result.message}` : ''}</p>
      {state.kind !== 'idle' && state.question && <section aria-label="Submitted question"><h2>Submitted question</h2><p>{state.question}</p></section>}
      {state.kind === 'result' && <RealResearchResults result={state.result} />}
    </>}
  </main>
}
