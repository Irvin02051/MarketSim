import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as metrics from '../src/lib/historyMetrics.ts'
import * as historyLib from '../src/lib/history.ts'

const { parseHistoryMetrics, matchHistoryMetrics, requestHistoryMetrics, createHistoryMetricsController } = metrics
const base = 'http://127.0.0.1:8000'
const dates = Array.from({ length: 22 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`)
// Self-authored synthetic observations; no captured provider data.
function history() {
  return { symbol: 'AAPL', currency: 'USD', source: 'alpha_vantage', data_kind: 'end_of_day',
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
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const signal = () => new AbortController().signal
const tick = () => new Promise((resolve) => setImmediate(resolve))
const respond = (value, status = 200) => { globalThis.fetch = async () => new Response(JSON.stringify(value), { status }) }

test('valid metadata, exact decimal strings, unavailable reasons and empty history are preserved', () => {
  const value = fixture()
  value.raw_price_change.value = '-0.123456'
  value.raw_sma_20.value = '12345678901234567890.123456'
  const parsed = parseHistoryMetrics(value)
  assert.equal(parsed.raw_sma_20.value, value.raw_sma_20.value)
  assert.equal(parsed.raw_price_change.value, '-0.123456')
  assert.equal(parsed.raw_sma_50.value, null)
  assert.equal(parsed.raw_sma_50.reason, 'Requires 50 observations; received 22.')
  assert.deepEqual(matchHistoryMetrics(parsed, history()), parsed)
  const empty = { ...history(), bars: [], returned_range: null, status: 'empty' }
  assert.equal(parseHistoryMetrics(fixture(empty)).raw_price_change.status, 'unavailable')
  const extreme = fixture(); extreme.raw_price_change.value = '9'.repeat(634) + '.000000'
  assert.equal(parseHistoryMetrics(extreme).raw_price_change.value, extreme.raw_price_change.value)
})

test('malformed provenance, ranges, timestamps, availability, counts, units and decimal values are rejected', () => {
  const mutations = [
    (v) => { v.source = 'demo' }, (v) => { v.data_kind = 'fictional' }, (v) => { v.adjustment_basis = 'adjusted' },
    (v) => { v.calculation_basis = 'total_return' }, (v) => { v.origin = 'model' }, (v) => { v.symbol = 'aapl' },
    (v) => { v.symbol = 'TSLA' }, (v) => { v.currency = 'EUR' }, (v) => { v.interval = 'weekly' },
    (v) => { v.coverage = 'partial' }, (v) => { v.status = 'empty' }, (v) => { v.corporate_actions_checked = true },
    (v) => { v.calendar_completeness = 'complete' }, (v) => { v.returned_range = null },
    (v) => { v.requested_range.end = '2027-01-01' }, (v) => { v.available_range.start = '2026-10-02' },
    (v) => { v.returned_range.end = '2026-10-02' }, (v) => { v.fetched_at = '2026-02-30T12:00:00Z' },
    (v) => { v.fetched_at = '2026-10-30T24:00:00Z' }, (v) => { v.fetched_at = '2026-10-30' },
    (v) => { v.provider_timezone = 'Not/AZone' }, (v) => { v.cache_hit = 'true' },
    (v) => { v.observation_count = true }, (v) => { v.return_count = 19 },
    (v) => { v.source_limitations = [] }, (v) => { v.calculation_limitations = [''] },
    (v) => { v.bars = [] }, (v) => { v.raw_sma_20.unit = 'percent' },
    (v) => { v.raw_sma_20.window.start = '2026-09-01' }, (v) => { v.raw_sma_20.window.end = '2026-10-21' },
    (v) => { v.raw_sma_20.required_observations = 19 }, (v) => { v.raw_sma_20.observation_count = 19 },
    (v) => { v.raw_sma_20.reason = 'Unexpected' }, (v) => { v.raw_sma_20.status = 'unavailable' },
    (v) => { v.raw_sma_50.value = '0.000000' }, (v) => { v.raw_sma_50.reason = null },
    (v) => { v.raw_sma_50.window = v.returned_range },
    ...[100, true, 'NaN', 'Infinity', '1e2', '1.0', '-0.000000', '01.000000', '9'.repeat(635) + '.000000']
      .map((bad) => (v) => { v.raw_price_change.value = bad }),
    (v) => { v.raw_return_sample_stddev_20.value = '-1.000000' },
  ]
  for (const mutate of mutations) { const v = fixture(); mutate(v); assert.throws(() => parseHistoryMetrics(v), /invalid response/) }
})

test('context mismatch rejects changed snapshot, ranges, symbol, count or metric windows; cache hit alone is allowed', () => {
  assert.ok(matchHistoryMetrics(parseHistoryMetrics(fixture()), history()))
  for (const change of [
    (h) => { h.fetched_at = '2026-11-02T12:00:00Z' }, (h) => { h.symbol = 'MSFT' },
    (h) => { h.source = 'demo' }, (h) => { h.requested_range.end = '2026-10-29' },
    (h) => { h.available_range.start = '2026-08-31' }, (h) => { h.returned_range.start = '2026-10-02' },
    (h) => { h.bars.pop() }, (h) => { h.bars[2].date = '2026-10-04' },
  ]) { const h = history(); change(h); assert.throws(() => matchHistoryMetrics(parseHistoryMetrics(fixture()), h), /Reload history/) }
})

test('explicit request uses loaded dates, endpoint and no authentication; never displays arbitrary errors', async () => {
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(url, base + '/prefix/api/stocks/AAPL/history/provider/metrics?start_date=2026-10-01&end_date=2026-10-30')
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error')
    assert.equal(options.headers, undefined)
    return new Response(JSON.stringify(fixture()))
  }
  assert.equal((await requestHistoryMetrics(base + '/prefix/', history(), signal())).cache_hit, true)
  assert.equal(calls, 1)
  for (const [status, message] of [[422, /range/], [429, /quota/], [502, /provider could not/], [503, /disabled/], [504, /timed out/], [500, /unavailable/]]) {
    respond({ detail: 'SECRET' }, status)
    await assert.rejects(requestHistoryMetrics(base, history(), signal()), (error) => message.test(error.message) && !error.message.includes('SECRET'))
  }
  globalThis.fetch = async () => { throw new Error('SECRET') }
  await assert.rejects(requestHistoryMetrics(base, history(), signal()), /Could not reach/)
  respond({ secret: 'SECRET' })
  await assert.rejects(requestHistoryMetrics(base, history(), signal()), /invalid response/)
  respond({ ...fixture(), fetched_at: '2026-11-02T12:00:00Z' })
  await assert.rejects(requestHistoryMetrics(base, history(), signal()), /Reload history/)
})

test('bad configuration and pre-cancellation never fetch; timeout bounds fetch and body reading', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(fixture())) }
  for (const url of ['', 'not a url', 'file:///tmp/data', 'https://user:secret@example.invalid', base + '?key=secret']) {
    await assert.rejects(requestHistoryMetrics(url, history(), signal()), /address/)
  }
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(requestHistoryMetrics(base, history(), cancelled.signal), { name: 'AbortError' })
  assert.equal(calls, 0)
  for (const bodyStalls of [false, true]) {
    let requestSignal
    globalThis.fetch = async (_url, options) => {
      requestSignal = options.signal
      if (bodyStalls) return { ok: true, json: () => new Promise(() => {}) }
      return new Promise(() => {})
    }
    await assert.rejects(requestHistoryMetrics(base, history(), signal(), 5), /timed out/)
    assert.equal(requestSignal.aborted, true)
  }
})

test('controller only loads explicitly, gates duplicates and accepts cache difference', async () => {
  const states = []; let calls = 0, finish
  const controller = createHistoryMetricsController(history(), (s) => states.push(s), async () => {
    calls++; return new Promise((resolve) => { finish = resolve })
  })
  assert.equal(calls, 0)
  const pending = controller.load(base); await controller.load(base)
  assert.equal(calls, 1); assert.equal(states.at(-1).kind, 'loading')
  finish(parseHistoryMetrics(fixture())); await pending
  assert.equal(states.at(-1).kind, 'result')
})

test('generation cancellation ignores both late successes and failures; replacement chart has its own state', async () => {
  for (const fail of [false, true]) {
    const states = []; const calls = []
    const retrieve = (_base, _history, signal) => new Promise((resolve, reject) => calls.push({ signal, resolve, reject }))
    const controller = createHistoryMetricsController(history(), (s) => states.push(s), retrieve)
    const first = controller.load(base)
    controller.cancel()
    assert.equal(calls[0].signal.aborted, true)
    const second = controller.load(base)
    if (fail) calls[0].reject(new Error('SECRET')); else calls[0].resolve(parseHistoryMetrics(fixture()))
    await first
    assert.equal(states.at(-1).kind, 'loading')
    calls[1].resolve(parseHistoryMetrics(fixture())); await second
    assert.equal(states.at(-1).kind, 'result')
    const nextStates = []
    createHistoryMetricsController(history(), (s) => nextStates.push(s), retrieve)
    assert.deepEqual(nextStates, [])
    assert.equal(calls.length, 2)
  }
})

test('controller mismatch publishes only safe error, no results', async () => {
  const states = []
  const controller = createHistoryMetricsController(history(), (s) => states.push(s), async () =>
    parseHistoryMetrics({ ...fixture(), fetched_at: '2026-11-02T12:00:00Z' }))
  await controller.load(base)
  assert.deepEqual(states.map((s) => s.kind), ['loading', 'error'])
  assert.match(states.at(-1).message, /Reload history/)
})

const require = createRequire(import.meta.url)
function loadComponent(path, overrides = {}, extra = '') {
  const output = { exports: {} }
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText.replaceAll('import.meta.env.VITE_API_BASE_URL', JSON.stringify(base))
    .replaceAll('import.meta.env.VITE_REAL_HISTORY_ENABLED', '"true"')
  runInNewContext(code + extra, { exports: output.exports, require: (name) => {
    if (name in overrides) return overrides[name]
    if (name === '../lib/historyMetrics') return metrics
    if (name === '../lib/history') return historyLib
    if (name.endsWith('.css')) return {}
    return require(name)
  } })
  return output.exports
}
const component = () => loadComponent('../src/components/RealHistoryMetrics.tsx')

test('static metrics section has accessible labels, exact values, reasons, windows and separate limitations', () => {
  const { RawPriceStatistics } = component()
  const result = fixture(); result.raw_sma_20.value = '12345678901234567890.123456'
  const html = renderToStaticMarkup(createElement(RawPriceStatistics, { state: { kind: 'result', result: parseHistoryMetrics(result) }, load() {} }))
  for (const pattern of [/aria-labelledby=/, /Raw-price statistics/, /role="status"/, /aria-live="polite"/,
    /12345678901234567890\.123456 USD/, /Requires 50 observations; received 22\./, /Observation window/,
    /Adjacent returns: 20/, /not total return or shareholder performance/, /not a reliable investment-risk measure/,
    /<summary>Source limitations/, /<summary>Calculation limitations/, /Reused cached snapshot/]) assert.match(html, pattern)
  const loading = renderToStaticMarkup(createElement(RawPriceStatistics, { state: { kind: 'loading' }, load() {} }))
  assert.match(loading, /disabled=""/)
  const error = renderToStaticMarkup(createElement(RawPriceStatistics, { state: { kind: 'error', message: 'Safe failure' }, load() {} }))
  assert.match(error, /Retry raw-price metrics/); assert.match(error, /Safe failure/)
})

// Mocked hooks and real handlers; these are not mounted DOM/browser tests.
function hooks() {
  const slots = []; let cursor = 0; const effects = []
  return { react: { ...require('react'), useState(initial) {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
  }, useEffect(effect) { effects.push(effect) } }, effects, reset() { cursor = 0 } }
}
const nodes = (tree) => !tree || typeof tree !== 'object' ? []
  : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]

test('component handler makes no request on render/effect, loads only on click and aborts on cleanup', async () => {
  const h = hooks()
  const { default: Component } = loadComponent('../src/components/RealHistoryMetrics.tsx', { react: h.react })
  const pending = []; globalThis.fetch = (_url, options) => new Promise((resolve) => pending.push({ resolve, options }))
  const render = () => { h.reset(); return Component({ history: history(), base }) }
  let tree = render()
  const cleanup = h.effects[0]()
  assert.equal(pending.length, 0)
  tree.props.load(); tree.props.load()
  assert.equal(pending.length, 1)
  tree = render(); assert.equal(tree.props.state.kind, 'loading')
  cleanup(); assert.equal(pending[0].options.signal.aborted, true)
  pending[0].resolve(new Response(JSON.stringify(fixture())))
  await tick()
  tree = render(); assert.notEqual(tree.props.state.kind, 'result')
})

test('page handler keeps chart with failed metrics and removes panel on edits/reload, with new generation', async () => {
  const h = hooks(), { RawPriceStatistics } = component()
  const Panel = () => createElement(RawPriceStatistics, { state: { kind: 'error', message: 'Safe metrics failure' }, load() {} })
  const Chart = () => createElement('div', null, 'Chart remains visible')
  const { ProviderHistory } = loadComponent('../src/pages/StockHistoryPage.tsx', {
    react: h.react, '../components/RealHistoryMetrics': Panel, '../components/HistoryChart': Chart,
    'react-router-dom': {},
  }, '\nexports.ProviderHistory = ProviderHistory;')
  const render = () => { h.reset(); return ProviderHistory({ symbol: 'AAPL' }) }
  let tree = render()
  for (const [index, value] of [[0, '2026-10-01'], [1, '2026-10-30']]) {
    nodes(tree).filter((n) => n.type === 'input')[index].props.onChange({ target: { value } }); tree = render()
  }
  let calls = 0; globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(history())) }
  const submit = () => nodes(tree).find((n) => n.type === 'form').props.onSubmit({ preventDefault() {} })
  submit(); await tick(); tree = render()
  assert.equal(calls, 1) // History completion does not request metrics.
  const panel = nodes(tree).find((n) => n.type === Panel)
  const markup = renderToStaticMarkup(tree)
  assert.match(markup, /Chart remains visible/); assert.match(markup, /Safe metrics failure/)
  submit(); tree = render()
  assert.equal(nodes(tree).some((n) => n.type === Panel), false)
  await tick(); tree = render()
  assert.notEqual(nodes(tree).find((n) => n.type === Panel).key, panel.key)
  nodes(tree).find((n) => n.type === 'input').props.onChange({ target: { value: '2026-10-02' } })
  tree = render(); assert.equal(nodes(tree).some((n) => n.type === Panel), false)
})
