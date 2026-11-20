import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSearch, requestSearch, createSearchController, normalizeQuery } from '../src/lib/stockSearch.ts'
const match = () => ({ symbol: 'TEST.A', name: 'Synthetic & Co', instrument_type: 'Equity', region: 'United States', currency: 'USD', market_open: '09:30', market_close: '16:00', provider_timezone: 'UTC-04', match_score: '0.9000' })
const fixture = () => ({ query: 'Test', selection_ref: 'a'.repeat(32), matches: [match()], source: 'alpha_vantage', fetched_at: '2026-11-14T12:00:00Z', cache_hit: false })
const base = 'http://127.0.0.1:8000'
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
test('strict provisional parser and query validation', () => {
  assert.deepEqual(parseSearch(fixture(), 'Test'), fixture())
  assert.equal(parseSearch({ ...fixture(), matches: [] }, 'Test').matches.length, 0)
  for (const change of [{ currency: 'EUR' }, { region: 'US' }, { instrument_type: 'ETF' }, { symbol: 'a b' }, { match_score: 'NaN' }, { provider_timezone: '' }, { market_open: '24:00' }, { name: '' }, { extra: 'x' }])
    assert.throws(() => parseSearch({ ...fixture(), matches: [{ ...match(), ...change }] }, 'Test'))
  for (const key of Object.keys(match())) { const m = match(); delete m[key]; assert.throws(() => parseSearch({ ...fixture(), matches: [m] }, 'Test')) }
  for (const change of [{ query: 'Other' }, { source: 'demo' }, { fetched_at: 'yesterday' }, { cache_hit: 'yes' }, { matches: Array(21).fill(match()) }])
    assert.throws(() => parseSearch({ ...fixture(), ...change }, 'Test'))
  for (const q of ['', '  ', 'a'.repeat(81), 'a\n', '\u0000']) assert.throws(() => normalizeQuery(q))
  assert.equal(normalizeQuery(' Test.A & Co '), 'Test.A & Co')
})
test('request security, safe errors, complete timeout and cancellation', async () => {
  const original = global.fetch
  try {
    let calls = 0
    global.fetch = async (url, options) => {
      calls++; assert.equal(new URL(url).searchParams.get('q'), 'Test')
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store'); assert.equal(options.headers, undefined)
      return new Response(JSON.stringify(fixture()))
    }
    assert.deepEqual(await requestSearch(base, ' Test ', new AbortController().signal), fixture())
    await assert.rejects(requestSearch('http://evil.example', 'Test', new AbortController().signal), { code: 'configuration' }); assert.equal(calls, 1)
    for (const [status, code] of [[429,'quota'], [503,'unavailable'], [502,'unavailable'], [504,'timeout'], [422,'invalid'], [302,'network']]) {
      global.fetch = async () => new Response('SENTINEL_SECRET', { status })
      await assert.rejects(requestSearch(base, 'Test', new AbortController().signal), e => e.code === code && !e.message.includes('SENTINEL'))
    }
    global.fetch = async () => { throw new Error('SENTINEL_SECRET') }
    await assert.rejects(requestSearch(base, 'Test', new AbortController().signal), { code: 'network' })
    global.fetch = async () => ({ status: 200, json: () => new Promise(() => {}) })
    await assert.rejects(requestSearch(base, 'Test', new AbortController().signal, 5), { code: 'timeout' })
    const controller = new AbortController(); controller.abort()
    await assert.rejects(requestSearch(base, 'Test', controller.signal), { name: 'AbortError' })
  } finally { global.fetch = original }
})
test('explicit submission, duplicate gate, local selection, cancellation and stale unmount results', async () => {
  const pending = deferred(); const states = []; let calls = 0; let signal
  const controller = createSearchController((q, s) => { calls++; signal = s; return pending.promise }, s => states.push(s))
  assert.equal(calls, 0); controller.select('TEST.A'); assert.equal(calls, 0)
  const first = controller.submit('Test'); await controller.submit('Test'); assert.equal(calls, 1)
  controller.cancel(); assert.equal(signal.aborted, true)
  pending.resolve(fixture()); await first; assert.equal(states.at(-1).status, 'idle')
  await controller.submit('Test'); controller.select('TEST.A')
  assert.equal(states.at(-1).selected.symbol, 'TEST.A'); assert.equal(calls, 2)
  controller.dispose(); await controller.submit('Test'); assert.equal(calls, 2)
  const late = deferred(); const updates = []
  const unmounted = createSearchController(() => late.promise, s => updates.push(s))
  const work = unmounted.submit('Test'); unmounted.dispose(); late.resolve(fixture()); await work
  assert.deepEqual(updates, [{ status: 'loading' }])
})

test('static page disables search and escapes provider text (not mounted-browser coverage)', async () => {
  const { readFileSync } = await import('node:fs')
  const { createRequire } = await import('node:module')
  const { runInNewContext } = await import('node:vm')
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { default: ts } = await import('typescript')
  const require = createRequire(import.meta.url)
  const source = readFileSync(new URL('../src/pages/StockSearchPage.tsx', import.meta.url), 'utf8').replaceAll('import.meta.env', '__env')
  const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText
  function render(enabled, state) {
    const exports = {}
    runInNewContext(code, { exports, __env: { VITE_STOCK_SEARCH_ENABLED: enabled }, require: name => {
      if (name.endsWith('.css')) return {}
      if (name === '../components/DiscoveredHistory') return { default: () => null }
      if (name === 'react') return { ...require('react'), useEffect: () => {}, useRef: () => ({ current: null }), useState: initial => [typeof initial === 'string' ? '' : state, () => {}] }
      if (name === 'react-router-dom') return { Link: ({ to, children }) => createElement('a', { href: to }, children) }
      if (name === '../lib/stockSearch') return { createSearchController, searchMessages: {} }
      return require(name)
    } })
    return renderToStaticMarkup(createElement(exports.default))
  }
  assert.match(render('false', { status: 'idle' }), /disabled/)
  const result = fixture(); result.matches[0].name = '<script>synthetic</script>'
  const html = render('true', { status: 'loaded', result, selected: result.matches[0] })
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/)
  assert.match(html, /aria-live="polite"/); assert.match(html, /Select TEST.A/)
})


test('timezone metadata preserves synthetic display strings without semantic interpretation', () => {
  // Self-authored examples, not the rejected live value or a captured provider response.
  for (const value of ['UTC-05', 'UTC-05:00', 'UTC+05:30', 'US/Eastern', 'Provider zone label', 'x'.repeat(200)]) {
    const result = parseSearch({ ...fixture(), matches: [{ ...match(), provider_timezone: value }] }, 'Test')
    assert.equal(result.matches[0].provider_timezone, value)
  }
  for (const value of ['', null, true, 5, [], {}, 'x'.repeat(201), 'UTC-05\n', 'UTC\u0000zone', 'UTC\u200bzone', ' UTC-05'])
    assert.throws(() => parseSearch({ ...fixture(), matches: [{ ...match(), provider_timezone: value }] }, 'Test'), { code: 'malformed' })
})
