import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { parseDiscoveredHistoryMetrics, parseHistoryMetrics, matchHistoryMetrics,
  requestDiscoveredHistoryMetrics, createDiscoveredMetricsController } from '../src/lib/historyMetrics.ts'
const dates = Array.from({ length: 22 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`)
// Self-authored synthetic observations; no captured provider data.
function history() {
  return { symbol: 'NEW.A', currency: 'USD', source: 'alpha_vantage', data_kind: 'end_of_day',
    adjustment_basis: 'unadjusted', interval: 'daily', requested_range: { start: '2026-10-01', end: '2026-10-30' },
    available_range: { start: '2026-09-01', end: '2026-10-30' }, returned_range: { start: dates[0], end: dates.at(-1) },
    status: 'ok', coverage: 'within_snapshot_bounds', fetched_at: '2026-11-01T12:00:00.123456+00:00',
    cache_hit: false, provider_timezone: 'US/Eastern', limitations: ['Raw synthetic test observations.'],
    bars: dates.map((date) => ({ date, open: 100, high: 100, low: 100, close: 100, volume: null })) }
}
function fixture(source = history()) {
  const { bars, limitations, ...context } = source
  const metric = (required, unit, value, whole = false) => bars.length < required
    ? { status: 'unavailable', value: null, unit, window: null, observation_count: bars.length,
      required_observations: required, reason: `Requires ${required} observations; received ${bars.length}.` }
    : { status: 'available', value, unit, window: { start: bars[whole ? 0 : bars.length - required].date, end: bars.at(-1).date },
      observation_count: whole ? bars.length : required, required_observations: required, reason: null }
  return { ...context, cache_hit: true, origin: 'backend', calculation_basis: 'raw_closing_prices',
    observation_count: bars.length, calendar_completeness: 'not_verified', corporate_actions_checked: false,
    raw_price_change: metric(2, 'percent', '0.000000', true), raw_sma_20: metric(20, 'USD', '100.000000'),
    raw_sma_50: metric(50, 'USD', '100.000000'), raw_return_sample_stddev_20: metric(21, 'percent', '0.000000'),
    return_count: bars.length >= 21 ? 20 : 0, source_limitations: limitations,
    calculation_limitations: ['Raw descriptions; corporate actions unchecked.'] }
}

const base = 'http://127.0.0.1:8000', reference = 'a'.repeat(32)
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const signal = () => new AbortController().signal
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { resolve, promise } }

test('discovered metrics preserve decimal strings, windows and limits without widening original symbols', () => {
  const value = fixture()
  assert.deepEqual(parseDiscoveredHistoryMetrics(value, 'NEW.A'), value)
  assert.throws(() => parseHistoryMetrics(value))
  for (const change of [{ symbol: 'OTHER' }, { source: 'demo' }, { data_kind: 'fictional' },
    { adjustment_basis: 'adjusted' }, { currency: 'EUR' }, { bars: [] }])
    assert.throws(() => parseDiscoveredHistoryMetrics({ ...value, ...change }, 'NEW.A'))
  const empty = { ...history(), status: 'empty', bars: [], returned_range: null }
  assert.equal(parseDiscoveredHistoryMetrics(fixture(empty), 'NEW.A').raw_price_change.value, null)
})

test('explicit request binds exact reference, dates and symbol; safe expiry and bounded response reading', async () => {
  let calls = 0
  globalThis.fetch = async (href, options) => {
    calls++
    const url = new URL(href)
    assert.equal(url.pathname, '/api/stocks/discovered/history/metrics')
    assert.deepEqual(Object.fromEntries(url.searchParams), { start_date: history().requested_range.start,
      end_date: history().requested_range.end, selection_ref: reference, symbol: 'NEW.A' })
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store')
    assert.equal(options.redirect, 'error'); assert.equal(options.headers, undefined)
    return new Response(JSON.stringify(fixture()))
  }
  assert.deepEqual(await requestDiscoveredHistoryMetrics(base, reference, history(), signal()), fixture())
  await assert.rejects(requestDiscoveredHistoryMetrics(base, 'forged', history(), signal()), /Search again/)
  assert.equal(calls, 1)
  globalThis.fetch = async () => new Response('SECRET response', { status: 409 })
  await assert.rejects(requestDiscoveredHistoryMetrics(base, reference, history(), signal()),
    e => /search form again/.test(e.message) && !e.message.includes('SECRET'))
  globalThis.fetch = async () => ({ ok: true, json: () => new Promise(() => {}) })
  await assert.rejects(requestDiscoveredHistoryMetrics(base, reference, history(), signal(), 5), /timed out/)
})

test('snapshot mismatch never displays metrics, including changed timestamp and each range', () => {
  assert.ok(matchHistoryMetrics(fixture(), history())) // cache flag may differ
  for (const mutate of [
    h => { h.symbol = 'OTHER' }, h => { h.currency = 'EUR' }, h => { h.source = 'demo' },
    h => { h.fetched_at = '2026-11-02T12:00:00Z' },
    h => { h.requested_range.start = '2026-10-02' }, h => { h.available_range.start = '2026-09-02' },
    h => { h.returned_range.start = '2026-10-02' }, h => { h.bars.pop() },
  ]) { const changed = history(); mutate(changed); assert.throws(() => matchHistoryMetrics(fixture(), changed), /Reload history/) }
})

test('controller sends nothing on creation; duplicate gate, cancel and late response protection', async () => {
  let calls = 0, capturedSignal
  const pending = deferred(), states = []
  const controller = createDiscoveredMetricsController(reference, history(), s => states.push(s),
    (base, ref, snapshot, signal) => { calls++; capturedSignal = signal; assert.equal(ref, reference); return pending.promise })
  assert.equal(calls, 0); assert.deepEqual(states, [])
  const work = controller.load(base); await controller.load(base); assert.equal(calls, 1)
  controller.cancel(); assert.equal(capturedSignal.aborted, true)
  pending.resolve(fixture()); await work
  assert.deepEqual(states, [{ kind: 'loading' }])
  const mismatch = createDiscoveredMetricsController(reference, history(), s => states.push(s),
    async () => ({ ...fixture(), fetched_at: '2026-11-02T12:00:00Z' }))
  await mismatch.load(base); assert.equal(states.at(-1).kind, 'error'); assert.match(states.at(-1).message, /Reload history/)
})

const require = createRequire(import.meta.url)
function component(path, mocks) {
  const exports = {}
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS,
  } }).outputText.replaceAll('import.meta.env', '__env')
  runInNewContext(code, { exports, __env: {}, require: name => name in mocks ? mocks[name] : name.endsWith('.css') ? {} : require(name) })
  return exports.default
}
test('handler-level metrics component is explicit, cleans up and reuses accessible renderer', () => {
  let loads = 0, cancels = 0, cleanup
  const Page = component('../src/components/DiscoveredHistoryMetrics.tsx', {
    react: { ...require('react'), useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: effect => { cleanup = effect() } },
    '../lib/historyMetrics': { createDiscoveredMetricsController: () => ({ load: () => { loads++ }, cancel: () => { cancels++ } }) },
    './RealHistoryMetrics': { RawPriceStatistics: () => null },
  })
  const tree = Page({ reference, history: history(), base })
  assert.equal(loads, 0); assert.equal(tree.props.state.kind, 'idle')
  tree.props.load(); assert.equal(loads, 1)
  cleanup(); assert.equal(cancels, 1)
})

test('history result owns metrics child: dates/reload remove it; chart remains alongside metrics', () => {
  let state = { kind: 'result', result: history() }
  const Metrics = () => null, Chart = () => null
  let generation = 0
  const Page = component('../src/components/DiscoveredHistory.tsx', {
    react: { ...require('react'), useState: initial => typeof initial === 'number' ? [generation, update => { generation = update(generation) }]
        : [typeof initial === 'function' ? initial() : state, () => {}],
      useRef: () => ({ current: null }), useEffect: effect => effect() },
    './HistoryChart': { __esModule: true, default: Chart },
    './DiscoveredHistoryMetrics': { __esModule: true, default: Metrics },
    '../lib/history': { initialProviderDates: () => history().requested_range },
    '../lib/discoveredHistory': { createDiscoveredController: () => ({
      cancel: () => { state = { kind: 'idle' } }, load: () => { state = { kind: 'loading' } }, dispose() {},
    }) },
  })
  const nodes = tree => {
    const all = []
    const walk = node => { if (!node || typeof node !== 'object') return; all.push(node); for (const n of [node.props?.children].flat(Infinity)) walk(n) }
    walk(tree); return all
  }
  const render = () => Page({ reference, selected: { name: 'Synthetic', symbol: 'NEW.A' } })
  let tree = render()
  assert.ok(nodes(tree).some(n => n.type === Chart))
  const child = nodes(tree).find(n => n.type === Metrics)
  assert.equal(child.props.reference, reference); assert.equal(child.props.history.symbol, 'NEW.A')
  assert.match(renderToStaticMarkup(tree), /22 observations loaded/)
  nodes(tree).find(n => n.type === 'input').props.onChange({ target: { value: '2026-10-02' } })
  assert.ok(!nodes(render()).some(n => n.type === Metrics))
  state = { kind: 'result', result: history() }; tree = render()
  nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.ok(!nodes(render()).some(n => n.type === Metrics))
  // Even a batched cached reload remounts the metrics controller.
  state = { kind: 'result', result: history() }
  assert.notEqual(nodes(render()).find(n => n.type === Metrics).key, child.key)
})
