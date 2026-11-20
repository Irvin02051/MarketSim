import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { parseDiscoveredHistory, parseProviderHistory, HistoryError } from '../src/lib/history.ts'
import { requestDiscoveredHistory, createDiscoveredController } from '../src/lib/discoveredHistory.ts'
const range = { start: '2026-10-23', end: '2026-10-28' }
// Entirely synthetic observations, not captured provider bars.
const fixture = () => ({ symbol: 'NEW.A', currency: 'USD', source: 'alpha_vantage', data_kind: 'end_of_day',
  adjustment_basis: 'unadjusted', interval: 'daily', requested_range: { ...range }, available_range: { ...range },
  returned_range: { ...range }, coverage: 'within_snapshot_bounds', status: 'ok', fetched_at: '2026-11-01T12:00:00Z',
  cache_hit: false, provider_timezone: null, limitations: ['Synthetic test limitation'],
  bars: [range.start, range.end].map(date => ({ date, open: 10, high: 12, low: 9, close: 11, volume: null })) })
const base = 'http://127.0.0.1:8000', ref = 'a'.repeat(32)
const original = global.fetch
afterEach(() => { global.fetch = original })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('discovered parser preserves exact identity while original provider parser remains restricted', () => {
  assert.deepEqual(parseDiscoveredHistory(fixture(), 'NEW.A'), fixture())
  assert.throws(() => parseProviderHistory(fixture()))
  for (const change of [{ symbol: 'NEW-A' }, { currency: 'EUR' }, { source: 'demo' }, { adjustment_basis: 'adjusted' },
    { bars: [{ ...fixture().bars[0], high: 1 }] }, { status: 'empty' }])
    assert.throws(() => parseDiscoveredHistory({ ...fixture(), ...change }, 'NEW.A'))
  for (const symbol of ['NEW-A', 'NEW/A']) assert.equal(parseDiscoveredHistory({ ...fixture(), symbol }, symbol).symbol, symbol)
})
test('history requests encode selection and dates, omit credentials, reject stale/malformed identity and safe errors', async () => {
  let calls = 0
  global.fetch = async (url, options) => {
    calls++
    assert.equal(url.pathname, '/api/stocks/discovered/history')
    assert.deepEqual(Object.fromEntries(url.searchParams), { selection_ref: ref, symbol: 'NEW.A', start_date: range.start, end_date: range.end })
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store')
    assert.equal(options.headers, undefined)
    return new Response(JSON.stringify(fixture()))
  }
  assert.deepEqual(await requestDiscoveredHistory(base, ref, 'NEW.A', range, new AbortController().signal), fixture())
  assert.equal(calls, 1)
  for (const [status, message] of [[409, /Search again/], [429, /quota/], [503, /unavailable/], [504, /timed out/], [502, /verified history/]]) {
    global.fetch = async () => new Response('SECRET raw provider response', { status })
    await assert.rejects(requestDiscoveredHistory(base, ref, 'NEW.A', range, new AbortController().signal), error => message.test(error.message) && !error.message.includes('SECRET'))
  }
  // Snapshot bounds may span more than the 90-day request limit.
  global.fetch = async () => new Response(JSON.stringify({ available_range: { start: '2026-01-01', end: '2026-10-28' } }), { status: 422 })
  await assert.rejects(requestDiscoveredHistory(base, ref, 'NEW.A', range, new AbortController().signal), error => error.available.start === '2026-01-01')
  global.fetch = async () => new Response(JSON.stringify({ ...fixture(), symbol: 'OTHER' }))
  await assert.rejects(requestDiscoveredHistory(base, ref, 'NEW.A', range, new AbortController().signal))
})
test('total deadline covers body reading and cancellation; invalid dates never fetch', async () => {
  global.fetch = async () => { throw new Error('must not fetch') }
  await assert.rejects(requestDiscoveredHistory(base, ref, 'NEW.A', { start: '20261023', end: range.end }, new AbortController().signal))
  global.fetch = async () => ({ status: 200, json: () => new Promise(() => {}) })
  await assert.rejects(requestDiscoveredHistory(base, ref, 'NEW.A', range, new AbortController().signal, 5), /timed out/)
  const controller = new AbortController()
  const work = requestDiscoveredHistory(base, ref, 'NEW.A', range, controller.signal)
  controller.abort(); await assert.rejects(work, { name: 'AbortError' })
})
test('controller is explicit-only, gates duplicates, invalidates input changes and ignores unmounted responses', async () => {
  let calls = 0; const pending = deferred(); const states = []; let signal
  const controller = createDiscoveredController((r, s) => { calls++; signal = s; return pending.promise }, s => states.push(s))
  assert.equal(calls, 0)
  const first = controller.load(range); await controller.load(range); assert.equal(calls, 1)
  controller.cancel(); assert.equal(signal.aborted, true)
  pending.resolve(fixture()); await first; assert.equal(states.at(-1).kind, 'idle')
  await controller.load(range); assert.equal(states.at(-1).kind, 'result')
  controller.dispose(); await controller.load(range); assert.equal(calls, 2)
  const late = deferred(); const updates = []
  const next = createDiscoveredController(() => late.promise, s => updates.push(s))
  const request = next.load(range); next.dispose(); late.resolve(fixture()); await request
  assert.deepEqual(updates, [{ kind: 'loading' }])
  const failed = createDiscoveredController(async () => { throw new HistoryError('Search again explicitly.') }, s => updates.push(s))
  await failed.load(range); assert.equal(updates.at(-1).message, 'Search again explicitly.')
})

const require = createRequire(import.meta.url)
function loadComponent(path, mocks, env = {}) {
  const exports = {}
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS,
  } }).outputText.replaceAll('import.meta.env', '__env')
  runInNewContext(code, { exports, __env: env, require: name => name in mocks ? mocks[name] : name.endsWith('.css') ? {} : require(name) })
  return exports.default
}
test('component handlers load only on submit, cancel on date change and cleanup; static accessibility/escaping', async () => {
  let run = 0, cancel = 0, dispose = 0, cleanup
  const controller = { load: () => { run++ }, cancel: () => { cancel++ }, dispose: () => { dispose++ } }
  const component = loadComponent('../src/components/DiscoveredHistory.tsx', {
    react: { ...require('react'), useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
      useRef: () => ({ current: null }), useEffect: callback => { cleanup = callback() } },
    './HistoryChart': { __esModule: true, default: () => null },
    '../lib/history': { initialProviderDates: () => ({ ...range }) },
    '../lib/discoveredHistory': { createDiscoveredController: () => controller },
  })
  const tree = component({ reference: ref, selected: { name: '<script>Synthetic</script>', symbol: 'NEW.A' } })
  const nodes = []
  const walk = node => { if (!node || typeof node !== 'object') return; nodes.push(node); for (const child of [node.props?.children].flat(Infinity)) walk(child) }
  walk(tree)
  assert.equal(run, 0)
  nodes.find(n => n.type === 'input').props.onChange({ target: { value: '2026-10-24' } }); assert.equal(cancel, 1); assert.equal(run, 0)
  nodes.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); assert.equal(run, 1)
  cleanup(); assert.equal(dispose, 1)
  const html = renderToStaticMarkup(tree)
  assert.match(html, /&lt;script&gt;/); assert.match(html, /aria-live="polite"/); assert.match(html, /Load price history/)
})
test('search component binds child to selected reference/symbol, retains results and removes history on new search/input', () => {
  let state, callback, searchCalls = 0
  const controller = { submit: () => { searchCalls++ }, cancel: () => { state = { status: 'idle' } }, dispose() {} }
  const selected = { name: 'Synthetic', symbol: 'NEW.A', instrument_type: 'Equity', region: 'United States', currency: 'USD', match_score: '1' }
  const loaded = () => ({ status: 'loaded', selected, result: { selection_ref: ref, matches: [selected], query: 'Synthetic', source: 'alpha_vantage', fetched_at: '2026-11-01T12:00:00Z', cache_hit: false } })
  const Child = () => createElement('p', null, 'Synthetic history failure; search results stay visible')
  const component = loadComponent('../src/pages/StockSearchPage.tsx', {
    react: { ...require('react'), useState: initial => [typeof initial === 'string' ? 'Synthetic' : state, value => { if (typeof value !== 'string') state = value }],
      useRef: () => ({ current: null }), useEffect: effect => effect() },
    'react-router-dom': { Link: ({ children }) => createElement('a', null, children) },
    '../components/DiscoveredHistory': { __esModule: true, default: Child },
    '../lib/stockSearch': { createSearchController: (run, publish) => { callback = publish; return controller }, searchMessages: {} },
  }, { VITE_STOCK_SEARCH_ENABLED: 'true', VITE_REAL_HISTORY_ENABLED: 'true' })
  state = loaded(); const tree = component()
  const html = renderToStaticMarkup(tree)
  assert.match(html, /Select NEW.A/); assert.match(html, /Synthetic history failure/); assert.equal(searchCalls, 0)
  callback({ status: 'loading' }); assert.doesNotMatch(renderToStaticMarkup(component()), /Synthetic history failure/)
  state = loaded(); const next = component(); const form = next.props.children.find(n => n?.type === 'form')
  form.props.children.find(n => n?.type === 'input').props.onChange({ target: { value: 'Other' } })
  assert.doesNotMatch(renderToStaticMarkup(component()), /Synthetic history failure/)
})
