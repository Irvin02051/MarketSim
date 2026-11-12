import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as lib from '../src/lib/realResearch.ts'

const question = 'Compare Apple and Microsoft raw closing-price change from 2026-10-01 to 2026-10-30.'
const base = 'http://127.0.0.1:8000'
// Entirely self-authored synthetic fixtures; no captured provider data.
const range = { start: '2026-10-01', end: '2026-10-30' }
function metrics(symbol = 'AAPL', empty = false) {
  const unavailable = (n, unit) => ({ status: 'unavailable', value: null, unit, window: null,
    observation_count: empty ? 0 : 2, required_observations: n, reason: `Requires ${n} observations.` })
  return { symbol, source: 'alpha_vantage', data_kind: 'end_of_day', adjustment_basis: 'unadjusted',
    currency: 'USD', interval: 'daily', requested_range: { ...range }, returned_range: empty ? null : { ...range },
    available_range: { ...range }, status: empty ? 'empty' : 'ok', coverage: 'within_snapshot_bounds',
    fetched_at: '2026-11-01T12:00:00+00:00', cache_hit: false, provider_timezone: 'US/Eastern',
    origin: 'backend', calculation_basis: 'raw_closing_prices', calendar_completeness: 'not_verified',
    corporate_actions_checked: false, observation_count: empty ? 0 : 2,
    raw_price_change: empty ? unavailable(2, 'percent') : { status: 'available', value: '1.123456', unit: 'percent',
      window: { ...range }, observation_count: 2, required_observations: 2, reason: null },
    raw_sma_20: unavailable(20, 'USD'), raw_sma_50: unavailable(50, 'USD'),
    raw_return_sample_stddev_20: unavailable(21, 'percent'), return_count: 0,
    source_limitations: ['Synthetic source limitation.'], calculation_limitations: ['Corporate actions unchecked.'] }
}
function fixture(two = true) {
  return { plan: { status: 'planned', reason: 'ready', symbols: two ? ['AAPL', 'MSFT'] : ['AAPL'],
    start_date: range.start, end_date: range.end, intents: [{ kind: two ? 'compare' : 'report', metric: 'raw_price_change' }] },
    status: 'answered', code: 'answered', message: 'Backend findings available.',
    evidence: (two ? ['AAPL', 'MSFT'] : ['AAPL']).map((symbol, i) => ({ id: `rh${i + 1}`, metrics: metrics(symbol) })),
    errors: [], findings: [{ evidence_ids: two ? ['rh1', 'rh2'] : ['rh1'], metric: 'raw_price_change',
      relation: two ? 'equal' : 'reported', statement: '<script>synthetic escaped finding</script>', statement_origin: 'backend' }],
    model_calls: 1, history_retrievals: two ? 2 : 1, limitations: ['Raw price change is not total return.'], omitted: [] }
}
function outcome(code, status = 'unavailable') {
  return { plan: null, status, code, message: 'Safe outcome.', evidence: [], errors: [], findings: [],
    model_calls: 0, history_retrievals: 0, limitations: ['Raw descriptions only.'], omitted: [] }
}
const originalFetch = globalThis.fetch
const signal = () => new AbortController().signal
const tick = () => new Promise((resolve) => setImmediate(resolve))
afterEach(() => { globalThis.fetch = originalFetch })

test('literal opt-in and trimmed instruction screening match the backend boundary', () => {
  assert.equal(lib.realResearchEnabled('true'), true)
  for (const v of [true, undefined, 'TRUE', ' true ', 'false']) assert.equal(lib.realResearchEnabled(v), false)
  assert.equal(lib.validateRealQuestion(`  ${question}  `), question)
  for (const q of ['', ' ', 'x'.repeat(1001), '{"close":123}', 'date,close\n2026-01-01,123', '2026-01-01;123']) {
    assert.throws(() => lib.validateRealQuestion(q))
  }
  assert.equal([...lib.validateRealQuestion('😀'.repeat(1000))].length, 1000)
})

test('single and two-symbol findings retain exact Decimal strings and metadata', () => {
  for (const two of [false, true]) {
    const d = fixture(two); d.evidence[0].metrics.raw_price_change.value = '123456789012345678901.123456'
    const parsed = lib.parseRealResult(d, question)
    assert.equal(parsed.evidence[0].metrics.raw_price_change.value, '123456789012345678901.123456')
    assert.equal(parsed.evidence[0].metrics.fetched_at, d.evidence[0].metrics.fetched_at)
    assert.equal(parsed.evidence[0].metrics.raw_sma_50.value, null)
  }
})

test('AAPL remains visible with MSFT failure, no comparison, and explicit omissions', () => {
  const d = fixture(); d.status = d.code = 'unavailable'; d.evidence.pop(); d.findings = []
  d.errors = [{ symbol: 'MSFT', status: 502, message: 'Provider could not supply valid history.', available_range: null }]
  d.omitted = ['Comparison unavailable.']
  const p = lib.parseRealResult(d, question)
  assert.equal(p.evidence[0].metrics.symbol, 'AAPL'); assert.equal(p.findings.length, 0)
  d.plan.intents = [{ kind: 'report', metric: 'raw_price_change' }]
  d.findings = fixture(false).findings; d.code = d.status = 'partial'
  assert.equal(lib.parseRealResult(d, question).status, 'partial')
})

test('clarification, unsupported, short/empty history, timeout, disabled and busy contracts', () => {
  assert.equal(lib.parseRealResult(outcome('explicit_dates_required', 'clarification'), 'Compare stocks').status, 'clarification')
  for (const [status, code] of [['unsupported', 'unsupported_request'], ['clarification', 'clarify_instruction']]) {
    const d = outcome(code, status); d.model_calls = 1
    d.plan = { status, reason: code, symbols: [], intents: [], start_date: null, end_date: null }
    assert.equal(lib.parseRealResult(d, question).status, status)
  }
  for (const empty of [false, true]) {
    const d = fixture(false); d.evidence[0].metrics = metrics('AAPL', empty)
    d.plan.intents = [{ kind: 'report', metric: 'raw_sma_50' }]; d.findings = []; d.code = d.status = 'unavailable'
    d.omitted = ['Insufficient observations.']
    assert.equal(lib.parseRealResult(d, question).findings.length, 0)
  }
  const timeout = outcome('research_timeout'); timeout.model_calls = 1
  assert.match(lib.resultHeading(lib.parseRealResult(timeout, question)), /deadline/)
  for (const code of ['disabled', 'unconfigured']) assert.equal(lib.parseRealResult(outcome(code), question, 503).code, code)
  assert.equal(lib.parseRealResult(outcome('research_busy'), question, 429).code, 'research_busy')
})

test('malformed and inconsistent plans, evidence, references, statuses and counters rejected', () => {
  const mutations = [
    (d) => { d.code = 'made_up' }, (d) => { d.plan.symbols = ['AAPL', 'AAPL'] }, (d) => { d.plan.symbols[0] = 'TSLA' },
    (d) => { d.plan.start_date = '2026-02-30' }, (d) => { d.plan.start_date = '2026-10-02' },
    (d) => { d.plan.extra = true }, (d) => { d.plan.intents[0].metric = 'raw_sma_20' },
    (d) => { d.plan.intents.push(d.plan.intents[0]) }, (d) => { d.plan.status = 'unsupported' },
    (d) => { d.model_calls = 2 }, (d) => { d.history_retrievals = 1 }, (d) => { d.evidence[0].id = 'q1' },
    (d) => { d.evidence[0].metrics.source = 'demo' }, (d) => { d.evidence[0].metrics.adjustment_basis = 'adjusted' },
    (d) => { d.evidence[0].metrics.raw_price_change.value = 1.123456 }, (d) => { d.evidence[0].metrics.bars = [] },
    (d) => { d.findings[0].evidence_ids = ['rh3'] }, (d) => { d.findings[0].evidence_ids.reverse() },
    (d) => { d.findings[0].statement_origin = 'model' }, (d) => { d.findings[0].relation = 'buy' },
    (d) => { d.findings[0].metric = 'raw_sma_50' }, (d) => { d.status = 'unavailable' },
    (d) => { d.errors = [{ symbol: 'AAPL', status: 502, message: 'Bad', available_range: null }] },
    (d) => { d.evidence[1].metrics.returned_range.start = '2026-10-02'; d.evidence[1].metrics.raw_price_change.window.start = '2026-10-02' },
    (d) => { d.limitations = [] }, (d) => { d.raw = 'extra' },
  ]
  for (const mutate of mutations) { const d = fixture(); mutate(d); assert.throws(() => lib.parseRealResult(d, question), /invalid response/) }
  assert.throws(() => lib.parseRealResult(fixture(), question, 429))
})

test('explicit POST has exact body, no credentials, no-store and redirect rejection', async () => {
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(url, base + '/api/research/real'); assert.equal(options.method, 'POST')
    assert.deepEqual(JSON.parse(options.body), { question }); assert.deepEqual(options.headers, { 'Content-Type': 'application/json' })
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error')
    return new Response(JSON.stringify(fixture()))
  }
  assert.equal((await lib.requestRealResearch(base, ` ${question} `, signal())).status, 'answered'); assert.equal(calls, 1)
})

test('structured non-2xx outcomes validated and raw error bodies never displayed', async () => {
  for (const [status, code] of [[503, 'disabled'], [503, 'unconfigured'], [429, 'research_busy']]) {
    globalThis.fetch = async () => new Response(JSON.stringify(outcome(code)), { status })
    assert.equal((await lib.requestRealResearch(base, question, signal())).code, code)
  }
  for (const status of [422, 500, 502]) {
    globalThis.fetch = async () => new Response('SECRET', { status })
    await assert.rejects(lib.requestRealResearch(base, question, signal()), (e) => !e.message.includes('SECRET'))
  }
  globalThis.fetch = async () => new Response('{"secret":"SECRET"}')
  await assert.rejects(lib.requestRealResearch(base, question, signal()), /invalid response/)
  globalThis.fetch = async () => { throw new Error('SECRET') }
  await assert.rejects(lib.requestRealResearch(base, question, signal()), /Could not reach/)
})

test('bad URL, invalid question and pre-cancellation do not fetch; timeout bounds response reading', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(fixture())) }
  for (const url of ['', 'invalid', 'file:///tmp/x', 'https://u:secret@example.invalid', base + '?key=secret']) {
    await assert.rejects(lib.requestRealResearch(url, question, signal()), /address/)
  }
  await assert.rejects(lib.requestRealResearch(base, '{}', signal()))
  const c = new AbortController(); c.abort()
  await assert.rejects(lib.requestRealResearch(base, question, c.signal), { name: 'AbortError' }); assert.equal(calls, 0)
  for (const bodyStalls of [false, true]) {
    let requestSignal
    globalThis.fetch = async (_url, options) => { requestSignal = options.signal
      return bodyStalls ? { status: 200, json: () => new Promise(() => {}) } : new Promise(() => {}) }
    await assert.rejects(lib.requestRealResearch(base, question, signal(), 5), /timed out/)
    assert.equal(requestSignal.aborted, true)
  }
})

test('controller disables requests, gates duplicates synchronously and permits explicit resubmission', async () => {
  const states = []; let calls = 0, resolve
  const retrieve = async () => { calls++; return new Promise((r) => { resolve = r }) }
  const disabled = lib.createRealResearchController(false, (s) => states.push(s), retrieve)
  await disabled.submit(base, question); assert.equal(calls, 0)
  const c = lib.createRealResearchController(true, (s) => states.push(s), retrieve)
  assert.equal(calls, 0)
  const first = c.submit(base, question); await c.submit(base, question)
  assert.equal(calls, 1); resolve(fixture()); await first; assert.equal(states.at(-1).kind, 'result')
  const second = c.submit(base, question); assert.equal(calls, 2); resolve(fixture()); await second
})

test('cancel ignores late success and failure and cannot overwrite a newer submission', async () => {
  for (const fail of [false, true]) {
    const calls = [], states = []
    const c = lib.createRealResearchController(true, (s) => states.push(s), (_b, _q, signal) => new Promise((resolve, reject) => calls.push({ signal, resolve, reject })))
    const first = c.submit(base, question); c.cancel(); assert.equal(calls[0].signal.aborted, true)
    const second = c.submit(base, question)
    if (fail) calls[0].reject(new Error('SECRET')); else calls[0].resolve(fixture())
    await first; assert.equal(states.at(-1).kind, 'loading')
    calls[1].resolve(fixture()); await second; assert.equal(states.at(-1).kind, 'result')
  }
})

const require = createRequire(import.meta.url)
function load(path, overrides = {}, enabled = 'true') {
  const output = { exports: {} }
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText.replaceAll('import.meta.env.VITE_REAL_RESEARCH_ENABLED', JSON.stringify(enabled))
    .replaceAll('import.meta.env.VITE_API_BASE_URL', JSON.stringify(base))
  runInNewContext(code, { exports: output.exports, require: (name) => {
    if (name in overrides) return overrides[name]
    if (name === '../lib/realResearch') return lib
    if (name === '../components/RealResearchResults') return results
    if (name.endsWith('.css')) return {}
    return require(name)
  } })
  return output.exports
}
const results = load('../src/components/RealResearchResults.tsx')
const router = { Link: ({ to, children }) => createElement('a', { href: to }, children) }
const nodes = (tree) => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
// Actual handlers with mocked hooks; NOT mounted DOM/browser interaction tests.
function hooks() {
  const slots = [], effects = []; let cursor = 0
  return { react: { ...require('react'), useState(initial) { const i = cursor++
    if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
    return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
  useEffect(effect) { effects.push(effect) } }, effects, reset() { cursor = 0 } }
}

test('static rendering escapes findings and shows exact values, evidence links and unavailable reasons', () => {
  const d = fixture(); d.evidence[0].metrics.raw_price_change.value = '123456789012345678901.123456'
  const html = renderToStaticMarkup(createElement(results.default, { result: lib.parseRealResult(d, question) }))
  for (const re of [/&lt;script&gt;/, /123456789012345678901\.123456 percent/, /href="#real-evidence-rh1"/,
    /id="real-evidence-rh1"/, /Requires 50 observations/, /not exact upstream request counts/,
    /Calculation limitations/, /Source limitations/, /Unadjusted/, /Original source fetch time/]) assert.match(html, re)
  assert.doesNotMatch(html, /<script>/)
})

test('page render, mount, typing and examples do not request; explicit submit gates duplicates; cleanup aborts', async () => {
  const h = hooks(), Page = load('../src/pages/RealResearchPage.tsx', { react: h.react, 'react-router-dom': router }).default
  const pending = []; globalThis.fetch = (_url, options) => new Promise((resolve) => pending.push({ resolve, options }))
  const render = () => { h.reset(); return Page() }
  let tree = render(); const cleanup = h.effects[0]()
  nodes(tree).find((n) => n.type === 'textarea').props.onChange({ target: { value: question } })
  tree = render(); nodes(tree).find((n) => n.type === 'button' && n.props.type === 'button').props.onClick()
  tree = render(); assert.equal(pending.length, 0)
  const submit = () => nodes(tree).find((n) => n.type === 'form').props.onSubmit({ preventDefault() {} })
  submit(); submit(); assert.equal(pending.length, 1)
  tree = render(); assert.equal(nodes(tree).find((n) => n.type === 'button' && n.props.type === 'submit').props.disabled, true)
  assert.match(renderToStaticMarkup(tree), /role="status"/)
  cleanup(); assert.equal(pending[0].options.signal.aborted, true)
  pending[0].resolve(new Response(JSON.stringify(fixture()))); await tick()
  tree = render(); assert.equal(nodes(tree).some((n) => n.type === results.default), false)
})

test('disabled page renders safe navigation without submission controls or requests', () => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error() }
  const Page = load('../src/pages/RealResearchPage.tsx', { 'react-router-dom': router }, 'false').default
  const html = renderToStaticMarkup(createElement(Page))
  assert.match(html, /Real research is disabled/); assert.match(html, /href="\/research"/)
  assert.doesNotMatch(html, /<form/); assert.equal(calls, 0)
})


test('partial deadline retains evidence and per-symbol 429 is distinct from endpoint busy', () => {
  const d = fixture(); d.status = 'partial'; d.code = 'research_timeout'; d.evidence.pop()
  d.findings = []; d.history_retrievals = 2
  const html = renderToStaticMarkup(createElement(results.default, { result: lib.parseRealResult(d, question) }))
  assert.match(html, /Research deadline expired/); assert.match(html, /Status: partial/)
  assert.match(html, /real-evidence-rh1/)
  d.code = d.status = 'unavailable'
  d.errors = [{ symbol: 'MSFT', status: 429, message: 'Provider budget or quota exhausted.', available_range: null }]
  d.omitted = ['Comparison unavailable.']
  const failed = renderToStaticMarkup(createElement(results.default, { result: lib.parseRealResult(d, question) }))
  assert.match(failed, /per-symbol provider\/budget error/); assert.match(failed, /reset time are unknown/)
  const busy = renderToStaticMarkup(createElement(results.default, { result: lib.parseRealResult(outcome('research_busy'), question, 429) }))
  assert.match(busy, /Research endpoint busy/); assert.match(busy, /not a provider quota diagnosis/)
})
