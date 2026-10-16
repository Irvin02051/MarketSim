import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { parseResearch, requestResearch, researchOutcome, validateQuestion } from '../src/lib/research.ts'

const question = 'Compare Apple and Microsoft reported percentage changes.'
const fixture = () => ({
  question, status: 'answered', model_calls: 2, tool_requests: 1,
  historical_evidence: [], historical_findings: [], historical_tool_outcomes: [],
  tool_outcomes: [{ tool: 'get_quotes', symbols: ['AAPL'], code: 'ok' }],
  explanation: { status: 'answered', code: 'answered', message: 'Validated from evidence.',
    findings: [{ statement: 'AAPL reported daily range is 4 USD.', statement_origin: 'backend', evidence_ids: ['q1'] }] },
  quotes: { data_mode: 'fictional', label: 'FICTIONAL DEMO DATA', limitations: ['Fetch time is not market freshness.'],
    errors: [], evidence: [{ id: 'q1', fictional: true, quote: {
      symbol: 'AAPL', currency: 'USD', price: 200, change_percent: 2.5,
      latest_trading_day: '2026-01-02', fetched_at: '2026-01-03T00:00:00Z', source: 'demo', data_kind: 'fictional',
    } }] },
})
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const signal = () => new AbortController().signal
function respond(body, status = 200) {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status })
}

test('submits only a trimmed question to the configured base; preserves evidence', async () => {
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(url, 'http://localhost:8000/prefix/api/research/agent')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.equal(options.credentials, 'omit')
    assert.deepEqual(JSON.parse(options.body), { question })
    return new Response(JSON.stringify(fixture()))
  }
  const result = await requestResearch('http://localhost:8000/prefix/', ` ${question} `, signal())
  assert.equal(calls, 1)
  assert.equal(result.quotes.evidence[0].quote.price, 200)
  assert.equal(result.quotes.evidence[0].fictional, true)
  assert.equal(result.explanation.findings[0].statement_origin, 'backend')
})

test('unavailable HTTP 200 retains evidence, errors and limitations', async () => {
  const data = fixture()
  data.explanation = { status: 'unavailable', code: 'model_quota', message: 'Quota exhausted.', findings: [] }
  data.status = 'unavailable'
  data.quotes.errors = [{ symbol: 'MSFT', status: 502, message: 'Quote retrieval failed.' }]
  respond(data)
  const result = await requestResearch('http://localhost:8000', question, signal())
  assert.equal(result.explanation.status, 'unavailable')
  assert.equal(result.quotes.evidence.length, 1)
  assert.deepEqual(result.quotes.errors, data.quotes.errors)
  assert.deepEqual(result.quotes.limitations, data.quotes.limitations)
})

test('empty clarification and unsupported results are valid', async () => {
  for (const status of ['clarification', 'unsupported']) {
    const data = fixture()
    data.quotes = null
    data.explanation = { status, code: 'clarify_question', message: 'Ask about supported quotes.', findings: [] }
    data.status = status
    data.tool_outcomes = []
    respond(data)
    assert.equal((await requestResearch('http://localhost:8000', question, signal())).quotes, null)
  }
})

test('429 and 503 retain safe structured outcomes; 422 does not echo server text', async () => {
  for (const [status, code] of [[429, 'research_busy'], [503, 'research_unavailable']]) {
    const data = fixture()
    data.quotes = null
    data.explanation = { status: 'unavailable', code, message: 'Research unavailable.', findings: [] }
    data.status = 'unavailable'
    respond(data, status)
    assert.equal((await requestResearch('http://localhost:8000', question, signal())).explanation.code, code)
  }
  respond({ detail: 'SECRET' }, 422)
  await assert.rejects(requestResearch('http://localhost:8000', question, signal()), /question was rejected/)
})

test('network and invalid JSON failures are safe and never retried', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('SECRET') }
  await assert.rejects(requestResearch('http://localhost:8000', question, signal()), /Could not reach/)
  assert.equal(calls, 1)
  globalThis.fetch = async () => new Response('SECRET')
  await assert.rejects(requestResearch('http://localhost:8000', question, signal()), /invalid response/)
})

test('malformed consumed fields and wrong question fail closed', async () => {
  for (const mutate of [
    (d) => { d.quotes.evidence[0].quote.price = '200' },
    (d) => { d.quotes.evidence[0].quote.fetched_at = 'yesterday' },
    (d) => { d.explanation.status = 'unexpected' },
    (d) => { d.explanation.findings[0].statement_origin = 'model' },
    (d) => { d.explanation.findings[0].evidence_ids = ['invented'] },
    (d) => { d.quotes = null },
    (d) => { d.tool_outcomes[0].symbols = 'AAPL' },
  ]) {
    const data = fixture(); mutate(data)
    assert.throws(() => parseResearch(data), /invalid response/)
  }
  const wrong = fixture(); wrong.question = 'A different question'
  respond(wrong)
  await assert.rejects(requestResearch('http://localhost:8000', question, signal()), /invalid response/)
})

test('validation prevents requests and counts Unicode characters like the backend', async () => {
  globalThis.fetch = () => { throw new Error('Should not fetch') }
  assert.equal(validateQuestion(' x '), 'x')
  assert.equal(validateQuestion('😀'.repeat(1000)).length, 2000)
  for (const value of ['', '  ', 'x'.repeat(1001)]) {
    await assert.rejects(requestResearch('http://localhost:8000', value, signal()), /between 1 and 1,000/)
  }
  await assert.rejects(requestResearch('https://user:SECRET@example.com', question, signal()), /address/)
})

test('caller cancellation passes through to fetch without retry', async () => {
  const controller = new AbortController()
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.signal, controller.signal)
    controller.abort()
    throw new DOMException('Aborted', 'AbortError')
  }
  await assert.rejects(requestResearch('http://localhost:8000', question, controller.signal), { name: 'AbortError' })
})

const historicalQuestion = 'Compare Apple and Microsoft price change from 2025-01-01 to 2025-03-31 using fictional historical data.'
function historicalEvidence(symbol = 'AAPL', id = 'hm1') {
  const metric = (value, unit, start, count, required) => ({ status: 'available', value, unit,
    window: { start, end: '2025-03-31' }, observation_count: count, required_observations: required, reason: null })
  return { id, origin: 'backend', provenance: {
    symbol, currency: 'USD', source: 'demo', data_kind: 'fictional', label: 'FICTIONAL DEMO DATA — not market observations.',
    adjustment_basis: 'unknown', interval: 'daily', observation_calendar: 'synthetic_weekdays',
    requested_range: { start: '2025-01-01', end: '2025-03-31' },
    returned_range: { start: '2025-01-01', end: '2025-03-31' },
    fixture_range: { start: '2024-01-01', end: '2025-12-31' },
    coverage: 'within_fixture', status: 'ok', fetched_at: '2026-10-16T12:00:00+00:00',
  }, price_change: metric(symbol === 'AAPL' ? '0.892952' : '0.469090', 'percent', '2025-01-01', 64, 2),
  sma_20: metric('188.123456', 'USD', '2025-03-04', 20, 20),
  sma_50: metric('187.654321', 'USD', '2025-01-21', 50, 50),
  adjacent_return_volatility_20: metric('0.100001', 'percent', '2025-03-03', 21, 21),
  volatility_return_count: 20,
  limitations: ['Synthetic weekday observations, not actual trading dates.',
    'Separate fixtures: these values do not reconcile with standalone demo quotes.'],
  }
}
function historicalFixture() {
  return { ...fixture(), question: historicalQuestion, quotes: null, tool_outcomes: [],
    explanation: { status: 'clarification', code: 'historical_answer_available',
      message: 'Legacy compatibility notice: current quote UI does not display history.', findings: [] },
    historical_evidence: [historicalEvidence(), historicalEvidence('MSFT', 'hm2')],
    historical_findings: [{ metric: 'price_change', evidence_ids: ['hm1', 'hm2'], relation: 'higher',
      statement: 'FICTIONAL DEMO DATA — AAPL (0.892952 percent) is higher than MSFT (0.469090 percent) for 2025-01-01 through 2025-03-31.',
      statement_origin: 'backend' }],
    historical_tool_outcomes: [{ tool: 'get_historical_metrics', symbols: ['AAPL', 'MSFT'],
      start_date: '2025-01-01', end_date: '2025-03-31', code: 'ok' }],
  }
}
function withoutAnalysis(data, status = 'unavailable') {
  data.status = status
  data.explanation = { status, code: status === 'unavailable' ? 'model_quota' : 'clarify_question',
    message: status === 'unavailable' ? 'Quota exhausted.' : 'Provide explicit dates.', findings: [] }
  data.historical_findings = []
  return data
}

test('historical-only answered request uses overall status instead of legacy clarification', async () => {
  const data = historicalFixture()
  respond(data)
  const result = await requestResearch('http://localhost:8000', historicalQuestion, signal())
  assert.equal(result.quotes, null)
  assert.equal(result.status, 'answered')
  assert.equal(result.explanation.status, 'clarification')
  assert.deepEqual(result.historical_evidence, data.historical_evidence)
  assert.deepEqual(result.historical_findings, data.historical_findings)
  assert.deepEqual(researchOutcome(result), { status: 'answered', code: 'answered',
    message: 'Historical findings validated against fictional evidence.' })
})

test('quote-only and mixed results preserve separate evidence and activity', () => {
  const quote = parseResearch(fixture())
  assert.equal(quote.status, 'answered')
  assert.equal(quote.historical_evidence.length, 0)
  const data = historicalFixture()
  data.quotes = fixture().quotes
  data.explanation = fixture().explanation
  data.tool_outcomes = fixture().tool_outcomes
  data.tool_requests = 2
  const result = parseResearch(data)
  assert.equal(result.quotes.evidence[0].id, 'q1')
  assert.equal(result.historical_evidence[0].id, 'hm1')
  assert.deepEqual(result.tool_outcomes, data.tool_outcomes)
  assert.deepEqual(result.historical_tool_outcomes, data.historical_tool_outcomes)
  assert.equal(researchOutcome(result).message, data.explanation.message)
})

test('unavailable analysis and genuine clarification retain historical evidence', () => {
  for (const status of ['unavailable', 'clarification']) {
    const data = withoutAnalysis(historicalFixture(), status)
    const result = parseResearch(data)
    assert.equal(result.status, status)
    assert.equal(researchOutcome(result).message, data.explanation.message)
    assert.deepEqual(result.historical_evidence, data.historical_evidence)
    assert.deepEqual(result.historical_findings, [])
  }
})

function emptyHistoryFixture() {
  const data = withoutAnalysis(historicalFixture(), 'clarification')
  data.historical_evidence = [historicalEvidence()]
  const e = data.historical_evidence[0]
  e.provenance.requested_range = { start: '2025-01-04', end: '2025-01-05' }
  e.provenance.returned_range = null
  e.provenance.status = 'empty'
  for (const key of ['price_change', 'sma_20', 'sma_50', 'adjacent_return_volatility_20']) {
    e[key] = { ...e[key], status: 'unavailable', value: null, window: null, observation_count: 0,
      reason: `Requires ${e[key].required_observations} observations; received 0.` }
  }
  e.volatility_return_count = 0
  data.historical_tool_outcomes[0] = { tool: 'get_historical_metrics', symbols: ['AAPL'],
    start_date: '2025-01-04', end_date: '2025-01-05', code: 'unavailable' }
  return data
}
test('empty and partial history preserve unavailable reasons, dates and limitations', () => {
  const empty = parseResearch(emptyHistoryFixture())
  assert.equal(empty.historical_evidence[0].sma_20.value, null)
  assert.equal(empty.historical_evidence[0].sma_20.window, null)
  assert.match(empty.historical_evidence[0].sma_20.reason, /received 0/)
  const data = historicalFixture()
  for (const e of data.historical_evidence) {
    e.provenance.coverage = 'partial_overlap'
    e.provenance.requested_range.start = '2023-12-30'
    e.provenance.returned_range.start = '2024-01-01'
    e.price_change.window.start = '2024-01-01'
    e.price_change.observation_count = 326
    e.limitations.push('Requested range is not fully covered by fixtures.')
  }
  data.historical_tool_outcomes[0].start_date = '2023-12-30'
  data.historical_tool_outcomes[0].code = 'partial'
  const result = parseResearch(data)
  assert.equal(result.historical_evidence[0].provenance.coverage, 'partial_overlap')
  assert.equal(result.historical_evidence[0].price_change.window.start, '2024-01-01')
  assert.match(result.historical_evidence[0].limitations.at(-1), /not fully covered/)
})

test('historical invalid arguments may have no validated symbols or dates', () => {
  const data = withoutAnalysis(historicalFixture(), 'clarification')
  data.historical_evidence = []
  data.historical_tool_outcomes = [{ tool: 'get_historical_metrics', symbols: [],
    start_date: null, end_date: null, code: 'invalid_tool_arguments' }]
  assert.equal(parseResearch(data).historical_tool_outcomes[0].start_date, null)
})

test('finite Decimal strings stay exact, including long values, zeros and exponent notation', () => {
  for (const value of ['0.000000', '-0.123456', '0.000001', '1E-30', `${'9'.repeat(634)}.123456`]) {
    const data = historicalFixture()
    data.historical_evidence[0].price_change.value = value
    assert.equal(parseResearch(data).historical_evidence[0].price_change.value, value)
  }
  for (const value of [0, null, '', ' ', 'NaN', 'Infinity', '-Infinity', '1,000.00', '1.2 USD', '0x12', '1e', '1\n']) {
    const data = historicalFixture()
    data.historical_evidence[0].price_change.value = value
    assert.throws(() => parseResearch(data), /invalid response/)
  }
})

test('malformed historical windows, provenance, metrics and references fail safely', async () => {
  for (const mutate of [
    (d) => { delete d.status },
    (d) => { d.status = 'clarification' },
    (d) => { d.explanation.status = 'unavailable' },
    (d) => { d.historical_findings = [] },
    (d) => { d.historical_evidence = null },
    (d) => { d.historical_evidence[1].id = 'hm1' },
    (d) => { d.historical_evidence[0].id = '<script>' },
    (d) => { d.historical_evidence[0].provenance.source = 'live' },
    (d) => { d.historical_evidence[0].provenance.adjustment_basis = 'adjusted' },
    (d) => { d.historical_evidence[0].provenance.fetched_at = '2025-02-30T00:00:00Z' },
    (d) => { d.historical_evidence[0].provenance.returned_range = null },
    (d) => { d.historical_evidence[0].price_change.window.start = '2025-02-30' },
    (d) => { d.historical_evidence[0].price_change.window.end = '2024-01-01' },
    (d) => { d.historical_evidence[0].price_change.window.end = '2025-04-01' },
    (d) => { d.historical_evidence[0].price_change.window = null },
    (d) => { d.historical_evidence[0].price_change.unit = 'USD' },
    (d) => { d.historical_evidence[0].price_change.observation_count = true },
    (d) => { d.historical_evidence[0].sma_20.observation_count = 19 },
    (d) => { d.historical_evidence[0].sma_20.required_observations = 21 },
    (d) => { d.historical_evidence[0].volatility_return_count = 21 },
    (d) => { d.historical_findings[0].evidence_ids = ['hm99'] },
    (d) => { d.historical_findings[0].evidence_ids = ['q1', 'hm2'] },
    (d) => { d.historical_findings[0].evidence_ids = ['hm1', 'hm1'] },
    (d) => { d.historical_findings[0].metric = 'momentum' },
    (d) => { d.historical_findings[0].statement_origin = 'model' },
    (d) => { d.historical_findings[0].relation = 'bullish' },
    (d) => { d.historical_tool_outcomes[0].end_date = 'yesterday' },
    (d) => { d.historical_tool_outcomes[0].tool = 'shell' },
    (d) => { d.historical_tool_outcomes[0].symbols = ['TSLA'] },
    (d) => { d.historical_tool_outcomes[0].start_date = null },
  ]) {
    const data = historicalFixture(); mutate(data)
    assert.throws(() => parseResearch(data), /invalid response/)
  }
  const empty = emptyHistoryFixture()
  empty.historical_evidence[0].sma_20.reason = ''
  assert.throws(() => parseResearch(empty), /invalid response/)
  empty.historical_evidence[0].sma_20.reason = 'Insufficient observations.'
  empty.status = 'answered'
  empty.historical_findings = [{ metric: 'sma_20', evidence_ids: ['hm1'], relation: 'reported',
    statement: 'Made up number', statement_origin: 'backend' }]
  respond(empty)
  await assert.rejects(requestResearch('http://localhost:8000', historicalQuestion, signal()), /invalid response/)
})

test('HTTP unavailable responses cannot carry answered historical results', async () => {
  for (const status of [429, 503]) {
    respond(historicalFixture(), status)
    await assert.rejects(requestResearch('http://localhost:8000', historicalQuestion, signal()), /invalid response/)
  }
})

// Render the real TSX component using existing TypeScript and React packages.
// This checks HTML output, not browser layout, focus or interaction.
const compiled = { exports: {} }
const { outputText } = ts.transpileModule(readFileSync(new URL('../src/components/HistoricalResearchEvidence.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
})
runInNewContext(outputText, { exports: compiled.exports, require: createRequire(import.meta.url) })
const renderHistory = (result) => renderToStaticMarkup(createElement(compiled.exports.default, {
  evidence: result.historical_evidence, findings: result.historical_findings,
}))

test('rendered historical HTML includes findings, matching cards, exact decimals and explicit limitations', () => {
  const data = historicalFixture()
  const huge = `${'9'.repeat(634)}.123456`
  data.historical_evidence[0].sma_20.value = huge
  const html = renderHistory(parseResearch(data))
  for (const text of ['Historical findings', 'Historical evidence', 'FICTIONAL DEMO DATA',
    'Price change excludes dividends', '20 returns from 21 observations', 'not annualized',
    'Requested range', 'Returned range', 'Adjustment basis', 'unknown', 'SMA20', 'SMA50',
    '64 observations', '2025-03-04 through 2025-03-31', huge, '0.892952', '0.469090']) {
    assert.ok(html.includes(text), text)
  }
  assert.match(html, /href="#research-hm1"/)
  assert.match(html, /id="research-hm1"/)
  assert.match(html, /id="research-hm2"/)
  assert.doesNotMatch(html, /Legacy compatibility notice/)
})

test('rendered empty evidence shows unavailable reasons; failed analysis retains cards; text is escaped', () => {
  const empty = renderHistory(parseResearch(emptyHistoryFixture()))
  assert.match(empty, /No observations returned/)
  assert.match(empty, /Unavailable:/)
  assert.match(empty, /Requires 20 observations; received 0/)
  assert.doesNotMatch(empty, /class="research-metric-value"/)
  const failed = renderHistory(parseResearch(withoutAnalysis(historicalFixture())))
  assert.match(failed, /No validated historical finding was returned/)
  assert.match(failed, /id="research-hm1"/)
  const data = historicalFixture()
  data.historical_findings[0].statement = '<script>doNotExecute()</script>'
  data.historical_evidence[0].limitations.push('<img src=x onerror=doNotExecute()>')
  const escaped = renderHistory(parseResearch(data))
  assert.match(escaped, /&lt;script&gt;/)
  assert.match(escaped, /&lt;img/)
  assert.doesNotMatch(escaped, /<script>|<img/)
})
