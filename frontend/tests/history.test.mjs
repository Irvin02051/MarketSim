import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { DEMO_HISTORY_END, historyDates, historySymbol, parseHistory, requestHistory, utcDate, formatHistoryDate } from '../src/lib/history.ts'

const range = { start: '2025-12-29', end: '2025-12-31' }
const fixture = () => ({ symbol: 'AAPL', currency: 'USD', source: 'demo', data_kind: 'fictional',
  adjustment_basis: 'unknown', interval: 'daily', observation_calendar: 'synthetic_weekdays',
  label: 'FICTIONAL DEMO DATA', requested_range: { ...range }, returned_range: { ...range },
  fixture_range: { start: '2024-01-01', end: DEMO_HISTORY_END }, coverage: 'within_fixture', status: 'ok',
  fetched_at: '2026-01-01T12:00:00Z', limitations: ['Separate fictional fixtures.'],
  bars: [{ date: '2025-12-29', close: 200 }, { date: '2025-12-30', close: 201 }, { date: '2025-12-31', close: 202 }],
})
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const signal = () => new AbortController().signal
const respond = (body, status = 200) => { globalThis.fetch = async () => new Response(JSON.stringify(body), { status }) }

test('demo anchor matches the backend contract and ranges are inclusive calendar periods', () => {
  const backend = readFileSync(new URL('../../backend/app/historical_data.py', import.meta.url), 'utf8')
  assert.match(backend, /FIXTURE_END = date\(2025, 12, 31\)/)
  assert.equal(DEMO_HISTORY_END, '2025-12-31')
  for (const [name, start] of [['1W', '2025-12-25'], ['1M', '2025-12-01'], ['3M', '2025-10-01'], ['1Y', '2025-01-01']]) {
    assert.deepEqual(historyDates(name), { start, end: DEMO_HISTORY_END })
  }
  assert.equal(historyDates('1M', '2024-03-31').start, '2024-03-01')
  assert.equal(historyDates('1M', '2025-03-31').start, '2025-03-01')
  assert.equal(historyDates('1M', '2025-05-31').start, '2025-05-01')
  assert.equal(historyDates('3M', '2024-05-31').start, '2024-03-01')
  assert.equal(historyDates('1Y', '2024-02-29').start, '2023-03-01')
  assert.equal(historyDates('1W', '2025-01-03').start, '2024-12-28')
})

test('date-only parsing and formatting stay in UTC and reject normalized invalid dates', () => {
  assert.equal(utcDate('2024-02-29'), Date.UTC(2024, 1, 29))
  assert.equal(formatHistoryDate(utcDate('2025-12-31')), 'Dec 31, 2025')
  for (const day of ['2025-02-29', '2025-04-31', '2025-1-01', '20250101', '0000-01-01']) assert.throws(() => utcDate(day))
  assert.equal(historySymbol('aapl'), 'AAPL')
  for (const symbol of ['TSLA', ' AAPL', 'A1', undefined]) assert.equal(historySymbol(symbol), null)
})

test('valid, single-point, empty, and partial responses preserve metadata', () => {
  const valid = parseHistory(fixture())
  assert.equal(valid.bars.length, 3)
  assert.equal(valid.adjustment_basis, 'unknown')
  assert.deepEqual(valid.limitations, ['Separate fictional fixtures.'])
  const single = fixture(); single.bars = single.bars.slice(0, 1); single.returned_range.end = single.returned_range.start
  assert.equal(parseHistory(single).bars.length, 1)
  const empty = fixture(); empty.bars = []; empty.returned_range = null; empty.status = 'empty'
  assert.equal(parseHistory(empty).status, 'empty')
  const partial = fixture(); partial.requested_range.end = '2026-01-05'; partial.coverage = 'partial_overlap'
  assert.equal(parseHistory(partial).coverage, 'partial_overlap')
  empty.requested_range = { start: '2026-01-01', end: '2026-01-03' }; empty.coverage = 'outside_fixture'
  assert.equal(parseHistory(empty).coverage, 'outside_fixture')
})

test('malformed prices, dates, provenance, ordering, and metadata are rejected, never repaired', () => {
  const mutations = [
    ...[NaN, Infinity, -Infinity, 0, -1, true, '200'].map((value) => (d) => { d.bars[0].close = value }),
    ...['2025-02-29', '2025-12-28', '2025-12-32', '2024-01-01'].map((value) => (d) => { d.bars[0].date = value }),
    (d) => { d.bars[1].date = d.bars[0].date }, (d) => { d.bars.reverse() },
    (d) => { d.returned_range = null }, (d) => { d.status = 'empty' }, (d) => { d.coverage = 'partial_overlap' },
    (d) => { d.source = 'alpha_vantage' }, (d) => { d.data_kind = 'real' },
    (d) => { d.adjustment_basis = 'adjusted' }, (d) => { d.fetched_at = '2025-12-31' },
    (d) => { d.limitations = 'none' }, (d) => { d.fixture_range.end = '2026-12-31' },
  ]
  for (const mutate of mutations) { const data = fixture(); mutate(data); assert.throws(() => parseHistory(data), /invalid response/) }
})

test('request uses the configured base, inclusive dates, and no credentials; validates correlation', async () => {
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(url, 'http://localhost:8000/prefix/api/stocks/AAPL/history?start_date=2025-12-29&end_date=2025-12-31')
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit')
    assert.equal(options.cache, 'no-store')
    return new Response(JSON.stringify(fixture()))
  }
  assert.equal((await requestHistory('http://localhost:8000/prefix/', 'AAPL', range, signal())).symbol, 'AAPL')
  assert.equal(calls, 1)
  const wrong = fixture(); wrong.symbol = 'MSFT'; respond(wrong)
  await assert.rejects(requestHistory('http://localhost:8000', 'AAPL', range, signal()), /invalid response/)
  respond(fixture())
  await assert.rejects(requestHistory('http://localhost:8000', 'AAPL', { ...range, start: '2025-12-28' }, signal()), /invalid response/)
})

test('safe network, HTTP, malformed JSON, and configuration errors without retries', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('SECRET') }
  await assert.rejects(requestHistory('http://localhost:8000', 'AAPL', range, signal()), /Could not reach/)
  assert.equal(calls, 1)
  for (const status of [422, 500, 503]) {
    respond({ detail: 'SECRET' }, status)
    await assert.rejects(requestHistory('http://localhost:8000', 'AAPL', range, signal()), (error) => !error.message.includes('SECRET'))
  }
  globalThis.fetch = async () => new Response('SECRET')
  await assert.rejects(requestHistory('http://localhost:8000', 'AAPL', range, signal()), /invalid response/)
  await assert.rejects(requestHistory('https://user:SECRET@example.com', 'AAPL', range, signal()), /address/)
})

test('timeout and caller cancellation abort transport and never retry', async () => {
  let calls = 0
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    calls++
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
  await assert.rejects(requestHistory('http://localhost:8000', 'AAPL', range, signal(), 5), /timed out/)
  const controller = new AbortController()
  const pending = requestHistory('http://localhost:8000', 'AAPL', range, controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(calls, 2)
  await assert.rejects(requestHistory('http://localhost:8000', 'AAPL', range, controller.signal), { name: 'AbortError' })
  assert.equal(calls, 2)
})

test('obsolete response is rejected even if a transport ignores cancellation', async () => {
  const controller = new AbortController()
  globalThis.fetch = async () => { controller.abort(); return new Response(JSON.stringify(fixture())) }
  await assert.rejects(requestHistory('http://localhost:8000', 'AAPL', range, controller.signal), { name: 'AbortError' })
})

// Self-authored API fixtures; no stored provider responses.
const realRange = { start: '2026-10-23', end: '2026-10-26' }
const realFixture = () => ({ symbol: 'AAPL', currency: 'USD', source: 'alpha_vantage', data_kind: 'end_of_day',
  adjustment_basis: 'unadjusted', interval: 'daily', requested_range: { ...realRange },
  available_range: { start: '2026-10-01', end: '2026-10-28' }, returned_range: { ...realRange },
  coverage: 'within_snapshot_bounds', status: 'ok', fetched_at: '2026-10-29T10:00:00+00:00',
  cache_hit: false, provider_timezone: 'US/Eastern', limitations: ['Raw prices, splits not handled.'],
  bars: ['2026-10-23', '2026-10-26'].map((date) => ({ date, open: 100, high: 102, low: 99, close: 101, volume: null })),
})
const base = 'http://127.0.0.1:8000'

import * as history from '../src/lib/history.ts'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const { providerHistoryEnabled, initialProviderDates, validateProviderDates, parseProviderHistory,
  requestProviderHistory, createProviderHistoryController } = history

test('provider opt-in is literal true; default ranges use UTC previous 30 dates without network', () => {
  for (const value of [undefined, null, false, true, 'false', '1', 'TRUE', ' true ']) assert.equal(providerHistoryEnabled(value), false)
  assert.equal(providerHistoryEnabled('true'), true)
  assert.deepEqual(initialProviderDates(new Date('2026-10-30T00:01:00Z')), { start: '2026-09-30', end: '2026-10-29' })
  assert.deepEqual(initialProviderDates(new Date('2024-03-01T23:59:59Z')), { start: '2024-01-31', end: '2024-02-29' })
})

test('provider inclusive date validation accepts 90 dates, rejects 91, malformed and reversed before fetch', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected network') }
  assert.deepEqual(validateProviderDates({ start: '2026-01-01', end: '2026-03-31' }), { start: '2026-01-01', end: '2026-03-31' })
  for (const range of [{ start: '2026-01-01', end: '2026-04-01' }, { start: '2026-10-26', end: '2026-10-23' },
    ...['', '2026-1-01', '2026-02-29', '20261023', '2026-10-23T00:00:00Z', '0000-01-01'].map((start) => ({ start, end: '2026-10-26' }))]) {
    await assert.rejects(requestProviderHistory(base, 'AAPL', range, signal()), /90 calendar days/)
  }
  assert.equal(calls, 0)
})

test('real result preserves provenance, nullable volume, ranges, gaps, timezone and empty/single cases', () => {
  const real = parseProviderHistory(realFixture())
  assert.equal(real.source, 'alpha_vantage'); assert.equal(real.adjustment_basis, 'unadjusted')
  assert.equal(real.bars[0].volume, null); assert.equal(real.provider_timezone, 'US/Eastern')
  assert.equal('fixture_range' in real, false)
  assert.equal('observation_calendar' in real, false)
  const single = realFixture(); single.bars.pop(); single.returned_range.end = single.returned_range.start
  single.provider_timezone = null; single.cache_hit = true
  assert.equal(parseProviderHistory(single).bars.length, 1)
  const empty = realFixture(); empty.bars = []; empty.returned_range = null; empty.status = 'empty'
  assert.equal(parseProviderHistory(empty).bars.length, 0)
  assert.throws(() => parseHistory(realFixture()))
  assert.throws(() => parseProviderHistory(fixture()))
})

test('real response rejects contradictory provenance, malformed OHLCV, windows, and metadata', () => {
  const mutations = [
    ...['demo', 'unknown'].map((v) => (d) => { d.source = v }),
    (d) => { d.data_kind = 'fictional' }, (d) => { d.adjustment_basis = 'adjusted' },
    (d) => { d.symbol = 'aapl' }, (d) => { d.currency = 'EUR' }, (d) => { d.interval = 'weekly' },
    (d) => { d.fixture_range = realRange }, (d) => { d.observation_calendar = 'synthetic_weekdays' },
    (d) => { d.label = 'FICTIONAL' }, (d) => { d.cache_hit = 'true' },
    (d) => { d.provider_timezone = 'PRIVATE_NOT_A_ZONE' }, (d) => { delete d.provider_timezone },
    (d) => { d.fetched_at = '2026-02-30T10:00:00Z' }, (d) => { d.fetched_at = '2026-10-29' },
    (d) => { d.limitations = [] }, (d) => { d.limitations = [''] },
    (d) => { d.coverage = 'complete' }, (d) => { d.status = 'empty' }, (d) => { d.returned_range = null },
    (d) => { d.requested_range.start = '2026-01-01' }, (d) => { d.available_range.start = '2026-10-24' },
    (d) => { d.bars.reverse() }, (d) => { d.bars[1].date = d.bars[0].date },
    (d) => { d.bars[0].date = '2026-10-22' }, (d) => { d.bars[0].high = 99 }, (d) => { d.bars[0].low = 102 },
    ...[true, '100', null, NaN, Infinity, 0, -1].map((v) => (d) => { d.bars[0].open = v }),
    ...[true, '100', -1, 0.5, undefined, NaN, Number.MAX_SAFE_INTEGER + 1].map((v) => (d) => { d.bars[0].volume = v }),
  ]
  for (const mutate of mutations) { const data = realFixture(); mutate(data); assert.throws(() => parseProviderHistory(data), /invalid response/) }
})

test('explicit provider request uses correct endpoint, no credentials, and validates correlation', async () => {
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(url, base + '/api/stocks/AAPL/history/provider?start_date=2026-10-23&end_date=2026-10-26')
    assert.equal(options.credentials, 'omit'); assert.equal(options.headers, undefined)
    assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error')
    return new Response(JSON.stringify(realFixture()))
  }
  assert.equal((await requestProviderHistory(base, 'AAPL', realRange, signal())).data_kind, 'end_of_day')
  assert.equal(calls, 1)
  const wrong = realFixture(); wrong.symbol = 'MSFT'; respond(wrong)
  await assert.rejects(requestProviderHistory(base, 'AAPL', realRange, signal()), /invalid response/)
  respond(realFixture())
  await assert.rejects(requestProviderHistory(base, 'AAPL', { ...realRange, start: '2026-10-22' }, signal()), /invalid response/)
})

test('provider disabled/quota/timeout/malformed errors are safe; only validated range bounds displayed', async () => {
  for (const [status, pattern] of [[503, /disabled or unavailable/], [429, /quota/], [504, /timed out/], [502, /unavailable/], [422, /range was rejected/]]) {
    respond({ detail: 'SECRET', available_range: { start: '2026-10-01', end: '2026-10-28' } }, status)
    await assert.rejects(requestProviderHistory(base, 'AAPL', realRange, signal()), (error) => {
      assert.match(error.message, pattern); assert.doesNotMatch(error.message, /SECRET/)
      assert.deepEqual(error.available, status === 422 ? { start: '2026-10-01', end: '2026-10-28' } : null)
      return true
    })
  }
  respond({ detail: 'SECRET', available_range: { start: 'SECRET', end: '2026-10-28' } }, 422)
  await assert.rejects(requestProviderHistory(base, 'AAPL', realRange, signal()), (error) => error.available === null && !error.message.includes('SECRET'))
  globalThis.fetch = async () => new Response('SECRET')
  await assert.rejects(requestProviderHistory(base, 'AAPL', realRange, signal()), /invalid response/)
  globalThis.fetch = async () => { throw new Error('SECRET') }
  await assert.rejects(requestProviderHistory(base, 'AAPL', realRange, signal()), /Could not reach/)
})

test('provider timeout and cancellation reject late transport/body responses', async () => {
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('SECRET', 'AbortError')), { once: true })
  })
  await assert.rejects(requestProviderHistory(base, 'AAPL', realRange, signal(), 5), /timed out/)
  const cancel = new AbortController()
  const pending = requestProviderHistory(base, 'AAPL', realRange, cancel.signal)
  cancel.abort(); await assert.rejects(pending, { name: 'AbortError' })
  globalThis.fetch = async () => ({ ok: true, json: async () => { cancel.abort(); return realFixture() } })
  await assert.rejects(requestProviderHistory(base, 'AAPL', realRange, cancel.signal), { name: 'AbortError' })
  const late = new AbortController()
  globalThis.fetch = async () => ({ ok: true, json: async () => { late.abort(); return realFixture() } })
  await assert.rejects(requestProviderHistory(base, 'AAPL', realRange, late.signal), { name: 'AbortError' })
})

test('form controller never fetches on construction; disabled Load, duplicates, cancellation and stale completions', async () => {
  const states = [], calls = []
  const retrieve = (_base, symbol, dates, signal) => new Promise((resolve, reject) => calls.push({ symbol, dates, signal, resolve, reject }))
  const disabled = createProviderHistoryController(false, (state) => states.push(state), retrieve)
  await disabled.load(base, 'AAPL', realRange)
  assert.equal(calls.length, 0)
  const controller = createProviderHistoryController(true, (state) => states.push(state), retrieve)
  assert.equal(calls.length, 0)
  const old = controller.load(base, 'AAPL', realRange)
  await controller.load(base, 'AAPL', realRange)
  assert.equal(calls.length, 1)
  controller.cancel() // input/mode/symbol change or unmount
  assert.equal(calls[0].signal.aborted, true)
  const next = controller.load(base, 'MSFT', realRange)
  calls[0].resolve(parseProviderHistory(realFixture())); await old
  assert.equal(states.at(-1).kind, 'loading')
  const newData = realFixture(); newData.symbol = 'MSFT'
  calls[1].resolve(parseProviderHistory(newData)); await next
  assert.equal(states.at(-1).result.symbol, 'MSFT')
  const failed = controller.load(base, 'AAPL', realRange)
  controller.cancel(); calls[2].reject(new Error('SECRET')); await failed
  assert.equal(states.at(-1).kind, 'loading') // no stale error publication
})

// Real component transpilation with mocked React hooks/router/chart dependencies.
// These are handler/static-render tests, not mounted DOM or browser tests.
const require = createRequire(import.meta.url)
function componentHarness(flag = 'true') {
  const slots = []; let cursor = 0; const cleanups = []
  const output = { exports: {} }
  const code = ts.transpileModule(readFileSync(new URL('../src/pages/StockHistoryPage.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText.replaceAll('import.meta.env.VITE_API_BASE_URL', JSON.stringify(base))
    .replaceAll('import.meta.env.VITE_REAL_HISTORY_ENABLED', JSON.stringify(flag))
  runInNewContext(code + '\nexports.ProviderHistory = ProviderHistory;', { exports: output.exports, require: (name) => {
    if (name === 'react') return { useState: (initial) => {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    }, useRef: () => ({ current: null }), useEffect: (effect) => { cleanups.push(effect) } }
    if (name === '../lib/history') return history
    if (name === '../components/HistoryChart') return () => null
    if (name === 'react-router-dom') return { useParams: () => ({ symbol: 'AAPL' }), useNavigate: () => () => {},
      Link: ({ to, children }) => createElement('a', { href: to }, children) }
    if (name.endsWith('.css')) return {}
    return require(name)
  } })
  return { render(provider = false) { cursor = 0; return provider ? output.exports.ProviderHistory({ symbol: 'AAPL' }) : output.exports.default() }, cleanups }
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  const children = tree.props?.children
  return [tree, ...(Array.isArray(children) ? children.flat(Infinity) : [children]).flatMap(nodes)]
}

test('page handler starts demo; opt-in mode button alone sends no provider request', () => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error() }
  for (const flag of ['false', 'TRUE', 'true']) {
    const harness = componentHarness(flag)
    const tree = harness.render()
    const button = nodes(tree).find((node) => node.type === 'button' && node.props.children === 'Provider history (private local)')
    assert.equal(Boolean(button), flag === 'true')
    assert.ok(nodes(tree).some((node) => String(node.props?.children).includes('Fictional historical demo')))
    if (button) {
      button.props.onClick()
      const providerTree = harness.render()
      assert.ok(nodes(providerTree).some((node) => String(node.props?.children).includes('Raw/unadjusted history')))
      assert.equal(nodes(providerTree).some((node) => node.props?.['aria-label'] === 'Historical date range'), false)
    }
  }
  assert.equal(calls, 0)
})

test('provider form handlers require Load, disable duplicates, clear on input change and clean up unmount', async () => {
  const calls = []
  globalThis.fetch = (_url, options) => new Promise((resolve) => calls.push({ options, resolve }))
  const harness = componentHarness()
  let tree = harness.render(true)
  assert.equal(calls.length, 0)
  const submit = () => nodes(tree).find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  submit(); submit()
  assert.equal(calls.length, 1)
  tree = harness.render(true)
  assert.equal(nodes(tree).find((node) => node.props?.type === 'submit').props.disabled, true)
  const markup = renderToStaticMarkup(tree)
  assert.match(markup, /role="status"/); assert.match(markup, /Loading AAPL provider history/)
  nodes(tree).find((node) => node.type === 'input').props.onChange({ target: { value: '2026-10-23' } })
  tree = harness.render(true)
  assert.equal(calls[0].options.signal.aborted, true)
  assert.match(renderToStaticMarkup(tree), /No provider request sent/)
  calls[0].resolve(new Response(JSON.stringify(realFixture())))
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(renderToStaticMarkup(harness.render(true)), /No provider request sent/)
  submit()
  const cleanup = harness.cleanups[0]()
  cleanup()
  assert.equal(calls[1].options.signal.aborted, true)
  calls[1].resolve(new Response(JSON.stringify(realFixture())))
  await new Promise((resolve) => setImmediate(resolve))
})

test('real chart/table static captions distinguish demo/provider, including single and empty results', () => {
  const output = { exports: {} }
  const code = ts.transpileModule(readFileSync(new URL('../src/components/HistoryChart.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  runInNewContext(code, { exports: output.exports, require: (name) => {
    if (name === '../lib/history') return history
    if (name === 'recharts') return new Proxy({}, { get: () => () => null })
    return require(name)
  } })
  for (const result of [parseHistory(fixture()), parseProviderHistory(realFixture())]) {
    const markup = renderToStaticMarkup(createElement(output.exports.default, { result }))
    assert.match(markup, /<caption>AAPL/)
    if (result.source === 'demo') assert.match(markup, /fictional daily closing prices/)
    else { assert.match(markup, /Alpha Vantage end-of-day unadjusted closing prices/); assert.doesNotMatch(markup, /fictional/) }
    const single = { ...result, bars: result.bars.slice(0, 1) }
    assert.match(renderToStaticMarkup(createElement(output.exports.default, { result: single })), /1 observations/)
    assert.match(renderToStaticMarkup(createElement(output.exports.default, { result: { ...result, bars: [] } })), /No observations/)
  }
})

test('provider form displays safe provenance and clears completed result/error on date edit', async () => {
  const harness = componentHarness()
  let tree = harness.render(true)
  const edit = (index, value) => {
    nodes(tree).filter((node) => node.type === 'input')[index].props.onChange({ target: { value } })
    tree = harness.render(true)
  }
  edit(0, realRange.start); edit(1, realRange.end)
  respond(realFixture())
  nodes(tree).find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  await new Promise((resolve) => setImmediate(resolve))
  tree = harness.render(true)
  const markup = renderToStaticMarkup(tree)
  for (const pattern of [/2 provider observations/, /Available snapshot/, /2026-10-01/, /US\/Eastern/,
    /not market freshness/, /Newly fetched snapshot/, /Raw prices, splits not handled/]) assert.match(markup, pattern)
  assert.doesNotMatch(markup, /fictional|synthetic/i)
  edit(0, '2026-10-24')
  assert.doesNotMatch(renderToStaticMarkup(tree), /Fetched at:|provider observations loaded/)
  respond({ detail: 'SECRET' }, 503)
  nodes(tree).find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  await new Promise((resolve) => setImmediate(resolve))
  tree = harness.render(true)
  assert.match(renderToStaticMarkup(tree), /disabled or unavailable/)
  edit(1, '2026-10-25')
  assert.doesNotMatch(renderToStaticMarkup(tree), /disabled or unavailable|SECRET/)
})
