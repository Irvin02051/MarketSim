import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import HistoricalResearchEvidence from '../components/HistoricalResearchEvidence'
import { ResearchError, requestResearch, researchOutcome, validateQuestion } from '../lib/research'
import type { ResearchResult } from '../lib/research'
import '../styles/DashboardPage.css'
import '../styles/ResearchPage.css'

const example = 'Compare Apple and Microsoft reported percentage changes.'
const historicalExample = 'Compare Apple and Microsoft price change from 2025-01-01 to 2025-03-31 using fictional historical data.'
type State = { kind: 'initial' | 'loading' } | { kind: 'error'; message: string } | { kind: 'result'; result: ResearchResult }
const labels = { answered: 'Research findings', unavailable: 'Explanation unavailable',
  unsupported: 'Request not supported', clarification: 'Clarification needed' }

function Results({ result }: { result: ResearchResult }) {
  const { explanation, quotes } = result
  const outcome = researchOutcome(result)
  const outcomeCount = result.tool_outcomes.length + result.historical_tool_outcomes.length
  const showHistory = result.historical_evidence.length > 0 || result.historical_tool_outcomes.length > 0
  return <section className="research-results" aria-label="Research result">
    <h2>{labels[outcome.status]}</h2>
    <p className="research-question">Question: {result.question}</p>
    <p>{outcome.message}</p>
    <p className="research-meta">Outcome: {outcome.code}</p>
    {quotes && <>
      <p className="research-provenance">{quotes.label}</p>
      {quotes.evidence.some((e) => e.fictional || e.quote.source === 'demo' || e.quote.data_kind === 'fictional')
        && <p className="research-fictional">FICTIONAL DEMO DATA — not actual market performance.</p>}
    </>}
    {explanation.findings.length > 0 && <><h2>Quote findings</h2><ul className="research-findings">
      {explanation.findings.map((finding, i) => <li key={i}>{finding.statement}</li>)}
    </ul></>}
    <p className="research-meta">The model selects findings; the backend validates and renders numerical statements.</p>
    {quotes && <>
      <h2>Quote evidence</h2>
      {!quotes.evidence.length && <p>No quote evidence is available.</p>}
      <div className="research-quotes">{quotes.evidence.map(({ id, quote, fictional }) => <article key={id} className="research-quote">
        <h3>{quote.symbol}</h3>
        <p className="research-source">{fictional || quote.source === 'demo' || quote.data_kind === 'fictional'
          ? 'Fictional demo quote' : 'Provider-backed quote — freshness unverified'}</p>
        <dl>
          <div><dt>Reported price</dt><dd>{quote.price} {quote.currency}</dd></div>
          <div><dt>Reported change</dt><dd>{quote.change_percent}%</dd></div>
          <div><dt>Trading date</dt><dd>{quote.latest_trading_day}</dd></div>
          <div><dt>Source</dt><dd>{quote.source}</dd></div>
          <div><dt>Fetched at (not trading time)</dt><dd>{quote.fetched_at}</dd></div>
        </dl>
      </article>)}</div>
      {!!quotes.errors.length && <><h3>Quote errors</h3><ul>{quotes.errors.map((error, i) =>
        <li key={i}>{error.symbol}: {error.message}</li>)}</ul></>}
      {!!quotes.limitations.length && <><h3>Limitations</h3><ul>{quotes.limitations.map((limitation, i) =>
        <li key={i}>{limitation}</li>)}</ul></>}
    </>}
    {!quotes && <p>No quote evidence was collected.</p>}
    {showHistory && <HistoricalResearchEvidence evidence={result.historical_evidence} findings={result.historical_findings} />}
    <details className="research-activity"><summary>Tool activity ({outcomeCount} {outcomeCount === 1 ? 'outcome' : 'outcomes'})</summary>
      <p>{result.model_calls} model {result.model_calls === 1 ? 'call' : 'calls'};{' '}
        {result.tool_requests} tool {result.tool_requests === 1 ? 'request' : 'requests'} observed.</p>
      {!outcomeCount && <p>No tool outcomes recorded.</p>}
      {!!outcomeCount && <p>Grouped by tool type; the API does not provide a combined chronological order.</p>}
      {!!result.tool_outcomes.length && <><h3>Quote and unknown tool outcomes</h3><ul>{result.tool_outcomes.map((outcome, i) => <li key={i}>
        {outcome.tool} · {outcome.symbols.join(', ') || 'No validated symbols'} · {outcome.code}
      </li>)}</ul></>}
      {!!result.historical_tool_outcomes.length && <><h3>Historical tool outcomes</h3><ul>
        {result.historical_tool_outcomes.map((outcome, i) => <li key={i}>
          {outcome.tool} · {outcome.symbols.join(', ') || 'No validated symbols'} · {outcome.code}
          <br />{outcome.start_date && outcome.end_date ? `${outcome.start_date} through ${outcome.end_date}` : 'No validated date range'}
        </li>)}
      </ul></>}
    </details>
  </section>
}

export default function ResearchPage() {
  const [question, setQuestion] = useState('')
  const [state, setState] = useState<State>({ kind: 'initial' })
  const current = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    document.title = 'Stock Research Assistant | MarketSim'
    heading.current?.focus()
    return () => {
      current.current?.abort()
      current.current = null
      clearTimeout(timer.current)
    }
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (current.current) return
    let trimmed: string
    try { trimmed = validateQuestion(question) } catch (error) {
      setState({ kind: 'error', message: (error as ResearchError).message })
      return
    }
    const controller = new AbortController()
    current.current = controller
    setState({ kind: 'loading' })
    timer.current = setTimeout(() => {
      if (current.current !== controller) return
      current.current = null
      controller.abort()
      setState({ kind: 'error', message: 'The request timed out after 35 seconds. Backend work may still be running. Try again later.' })
    }, 35_000)
    try {
      const result = await requestResearch(import.meta.env.VITE_API_BASE_URL, trimmed, controller.signal)
      if (current.current === controller) setState({ kind: 'result', result })
    } catch (error) {
      if (current.current === controller) setState({ kind: 'error', message: error instanceof ResearchError
        ? error.message : 'Research could not be completed. Please try again later.' })
    } finally {
      if (current.current === controller) {
        current.current = null
        clearTimeout(timer.current)
      }
    }
  }
  const busy = state.kind === 'loading'
  const announcement = busy ? 'Research request in progress…' : state.kind === 'error' ? state.message
    : state.kind === 'result' ? labels[state.result.status] : ''
  return <div className="dashboard-page research-page">
    <a className="dashboard-skip-link" href="#research-main">Skip to research</a>
    <header className="dashboard-header"><div className="dashboard-header-inner">
      <Link className="dashboard-brand" to="/dashboard">MarketSim<span className="dashboard-brand-dot">.</span></Link>
      <nav aria-label="Research navigation"><Link className="dashboard-back-link" to="/dashboard">Back to dashboard</Link></nav>
    </div></header>
    <main className="dashboard-main" id="research-main">
      <div className="dashboard-intro"><p className="dashboard-kicker">EXPLORE WITH EVIDENCE</p>
        <h1 ref={heading} tabIndex={-1}>Stock Research Assistant</h1>
        <p>Explore quotes and historical metrics for Apple (AAPL), Microsoft (MSFT), and Nvidia (NVDA).
          Fictional history covers 2024–2025. Include explicit start and end dates in historical questions.
          Predictions are not supported.</p>
      </div>
      <form className="research-form dashboard-panel" onSubmit={submit} aria-busy={busy}>
        <label htmlFor="research-question">Your question</label>
        <textarea id="research-question" value={question} onChange={(event) => setQuestion(event.target.value)}
          rows={4} disabled={busy} aria-describedby="research-help" />
        <p id="research-help">Use 1–1,000 characters after trimming spaces. Submit only non-sensitive questions.</p>
        <div className="research-actions">
          <button type="submit" disabled={busy}>{busy ? 'Researching…' : 'Research stocks'}</button>
          <button type="button" disabled={busy} onClick={() => setQuestion(example)}>Use example question</button>
          <button type="button" disabled={busy} onClick={() => setQuestion(historicalExample)}>Use historical example</button>
        </div>
        <p className="research-example">Example: {example}</p>
        <p className="research-example">Historical example: {historicalExample}</p>
      </form>
      <p role="status" aria-live="polite" aria-atomic="true" className={state.kind === 'error' ? 'research-error' : 'research-status'}>{announcement}</p>
      {state.kind === 'initial' && <p>Ask a question to collect evidence. No research requests are made until you submit.</p>}
      {state.kind === 'result' && <Results result={state.result} />}
    </main>
    <footer className="dashboard-footer"><span>MarketSim · Built for learning.</span><p>Educational research only, not financial advice.</p></footer>
  </div>
}
