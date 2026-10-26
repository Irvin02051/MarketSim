import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as quotes from '../src/lib/quotes.ts'
const { parseQuote, requestQuote, createQuoteRequest, QuoteError, signedQuoteNumber } = quotes
const fixture = (symbol = 'AAPL') => ({ symbol, currency: 'USD', price: 205, change: 5, change_percent: 2.5,
  high: 208, low: 198, volume: 100000, latest_trading_day: '2026-01-02', source: 'demo', data_kind: 'fictional',
  fetched_at: '2026-10-26T12:00:00Z', cache_hit: false })
const base = 'http://127.0.0.1:8000/prefix'
const signal = () => new AbortController().signal
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test('parser preserves full quote and exact percentage units, including provider/cache metadata', () => {
  assert.deepEqual(parseQuote(fixture(), 'AAPL'), fixture())
  const provider = { ...fixture(), source: 'alpha_vantage', data_kind: 'end_of_day', cache_hit: true }
  assert.deepEqual(parseQuote(provider, 'AAPL'), provider)
  assert.equal(signedQuoteNumber(2.5), '+2.5'); assert.equal(signedQuoteNumber(-1), '-1')
  assert.equal(signedQuoteNumber(0), '0'); assert.equal(signedQuoteNumber(-0), '0')
})
test('parser rejects mismatched symbols, unsafe numeric values and range violations', () => {
  for (const patch of [{ symbol: 'MSFT' }, { symbol: 'TSLA' }, { currency: 'EUR' }, { price: 0 },
    { price: '205' }, { price: true }, { price: Infinity }, { change: NaN }, { change_percent: '2.5%' },
    { high: 200 }, { low: 206 }, { low: 0 }, { high: -1 }, { volume: true }, { volume: 1.5 },
    { volume: -1 }, { volume: Number.MAX_SAFE_INTEGER + 1 }, { cache_hit: 'false' }]) {
    assert.throws(() => parseQuote({ ...fixture(), ...patch }, 'AAPL'), { code: 'malformed' })
  }
  for (const field of Object.keys(fixture())) {
    const value = fixture(); delete value[field]
    assert.throws(() => parseQuote(value, 'AAPL'), { code: 'malformed' })
  }
})
test('parser rejects invalid dates, timestamps and unknown or contradictory provenance', () => {
  for (const patch of [{ latest_trading_day: '2026-02-30' }, { latest_trading_day: '2026-1-2' },
    { latest_trading_day: '2027-01-01' }, { fetched_at: '2026-02-30T12:00:00Z' },
    { fetched_at: '2026-10-26T12:00:00' }, { fetched_at: '2026-10-26T25:00:00Z' },
    { fetched_at: 'PRIVATE' }, { source: 'unknown' }, { data_kind: 'live' },
    { source: 'demo', data_kind: 'end_of_day' }, { source: 'alpha_vantage', data_kind: 'fictional' }]) {
    assert.throws(() => parseQuote({ ...fixture(), ...patch }, 'AAPL'), { code: 'malformed' })
  }
  // Backend compares dates in the timestamp's own timezone, not its UTC conversion.
  assert.ok(parseQuote({ ...fixture(), latest_trading_day: '2026-10-26', fetched_at: '2026-10-26T00:00:00+02:00' }, 'AAPL'))
})
test('public quote fetch uses trusted backend path, no auth headers/body/cookies, no redirects', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, base + '/api/stocks/AAPL/quote')
    assert.equal(options.method, 'GET'); assert.equal(options.headers, undefined); assert.equal(options.body, undefined)
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error')
    return Response.json(fixture())
  })
  assert.deepEqual(await requestQuote(base, 'AAPL', signal()), fixture())
})
test('invalid destinations and symbols never fetch', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No request'))
  for (const url of [undefined, '', 'http://example.test', 'https://u:p@example.test', 'https://example.test?token=x', 'https://example.test#x']) {
    await assert.rejects(requestQuote(url, 'AAPL', signal()), { code: 'configuration' })
  }
  await assert.rejects(requestQuote(base, 'TSLA', signal()), { code: 'invalid' })
})
test('safe rate-limit, provider, network, redirect and malformed errors never expose bodies', async t => {
  const mock = t.mock.method(globalThis, 'fetch')
  for (const [status, code] of [[429, 'rate_limit'], [504, 'timeout'], [502, 'unavailable'], [503, 'unavailable'],
    [400, 'invalid'], [404, 'invalid'], [302, 'network'], [200, 'malformed']]) {
    mock.mock.mockImplementation(async () => new Response('PRIVATE', { status }))
    await assert.rejects(requestQuote(base, 'AAPL', signal()), e => e.code === code && !e.message.includes('PRIVATE'))
  }
  mock.mock.mockImplementation(async () => { throw new Error('PRIVATE') })
  await assert.rejects(requestQuote(base, 'AAPL', signal()), { code: 'network' })
  mock.mock.mockImplementation(async () => ({ status: 200, redirected: true }))
  await assert.rejects(requestQuote(base, 'AAPL', signal()), { code: 'network' })
})
test('total deadline bounds both fetch and stalled response reading', async t => {
  const never = new Promise(() => {}), mock = t.mock.method(globalThis, 'fetch', () => never)
  await assert.rejects(requestQuote(base, 'AAPL', signal(), 5), { code: 'timeout' })
  mock.mock.mockImplementation(async () => ({ status: 200, json: () => never }))
  await assert.rejects(requestQuote(base, 'AAPL', signal(), 5), { code: 'timeout' })
})
test('aborts reject promptly even when response reading ignores cancellation', async t => {
  const controller = new AbortController(), started = deferred()
  t.mock.method(globalThis, 'fetch', async () => ({ status: 200, json: () => { started.resolve(); return new Promise(() => {}) } }))
  const pending = requestQuote(base, 'AAPL', controller.signal)
  await started.promise; controller.abort(); await assert.rejects(pending, { name: 'AbortError' })
  await assert.rejects(requestQuote(base, 'AAPL', controller.signal), { name: 'AbortError' })
})
// Request controllers: independent items, single active request, disposal and retries.
test('each item succeeds/fails independently; retry is explicit and never substitutes demo data', async () => {
  const states = {}; let failed = true, calls = 0
  const first = createQuoteRequest(async () => fixture(), s => { states.AAPL = s })
  const second = createQuoteRequest(async () => { calls++; if (failed) throw new QuoteError('rate_limit'); return fixture('MSFT') }, s => { states.MSFT = s })
  await Promise.all([first.refresh(), second.refresh()])
  assert.equal(states.AAPL.status, 'loaded'); assert.deepEqual(states.MSFT, { status: 'error', code: 'rate_limit' })
  assert.equal(calls, 1); failed = false; await second.refresh(); assert.equal(states.MSFT.quote.symbol, 'MSFT')
  assert.equal(calls, 2)
})
test('duplicate refresh clicks start one request; a failed refresh clears previously loaded values', async () => {
  let calls = 0, state; const pending = deferred()
  const control = createQuoteRequest(async () => { calls++; if (calls === 1) return pending.promise; throw new QuoteError('network') }, s => { state = s })
  const first = control.refresh(); await control.refresh(); assert.equal(calls, 1)
  pending.resolve(fixture()); await first; assert.equal(state.status, 'loaded')
  const refresh = control.refresh(); assert.deepEqual(state, { status: 'loading' }); await refresh
  assert.deepEqual(state, { status: 'error', code: 'network' })
})
test('removal/account replacement/unmount disposal aborts and ignores late success and failure', async () => {
  for (const fails of [false, true]) {
    const pending = deferred(), states = []; let requestSignal
    const old = createQuoteRequest(s => { requestSignal = s; return pending.promise }, s => states.push(s))
    const first = old.refresh(); old.dispose(); assert.equal(requestSignal.aborted, true)
    const nextStates = [], next = createQuoteRequest(async () => fixture('MSFT'), s => nextStates.push(s))
    await next.refresh()
    if (fails) pending.reject(new Error('PRIVATE')); else pending.resolve(fixture())
    await first; await old.refresh()
    assert.deepEqual(states, [{ status: 'loading' }]); assert.equal(nextStates.at(-1).quote.symbol, 'MSFT')
  }
})
const require = createRequire(import.meta.url)
function loadComponent(hooks) {
  const output = { exports: {} }
  const code = ts.transpileModule(readFileSync(new URL('../src/components/WatchlistQuote.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText.replaceAll('import.meta.env.VITE_API_BASE_URL', JSON.stringify(base))
  runInNewContext(code, { exports: output.exports, require: name => {
    if (name === '../lib/quotes') return quotes
    if (name === 'react' && hooks) return hooks
    return require(name)
  } })
  return output.exports
}
test('actual static quote HTML labels fictional/provider origin and distinct dates, with correct percentage units', () => {
  const View = loadComponent().QuoteView
  const render = quote => renderToStaticMarkup(createElement(View, { symbol: 'AAPL', state: { status: 'loaded', quote }, refresh() {} }))
  const html = render(fixture())
  assert.match(html, /Fictional demo quote/); assert.match(html, /205 USD/); assert.match(html, /\+5 USD \(\+2.5%\)/)
  assert.doesNotMatch(html, /250%/); assert.match(html, /Trading date/); assert.match(html, /2026-01-02/)
  assert.match(html, /Fetched by backend \(not trading time\)/); assert.match(html, /2026-10-26T12:00:00Z/)
  assert.match(html, /separate and do not necessarily reconcile/); assert.match(html, /Refresh AAPL quote/)
  assert.match(render({ ...fixture(), change: -4, change_percent: -1 }), /-4 USD \(-1%\)/)
  assert.match(render({ ...fixture(), change: 0, change_percent: 0 }), /0 USD \(0%\)/)
  const provider = render({ ...fixture(), source: 'alpha_vantage', data_kind: 'end_of_day', cache_hit: true })
  assert.match(provider, /Provider quote — end-of-day data/); assert.match(provider, /not guaranteed to be live or real-time/)
  assert.match(provider, /Returned from cache/); assert.doesNotMatch(provider, /Fictional demo quote/)
})
test('loading and error static HTML have accessible feedback and never show zero substitute', () => {
  const View = loadComponent().QuoteView
  for (const state of [{ status: 'loading' }, { status: 'error', code: 'rate_limit' }]) {
    const html = renderToStaticMarkup(createElement(View, { symbol: 'AAPL', state, refresh() {} }))
    assert.match(html, /role="status"/); assert.doesNotMatch(html, /0 USD|Reported price/)
    if (state.status === 'loading') assert.match(html, /disabled/)
    else { assert.match(html, /role="alert"/); assert.match(html, /Retry AAPL quote/) }
  }
})
// Hook/effect harness executes component lifecycle; it is NOT mounted React DOM coverage.
test('unchanged symbol renders do not refetch; effect cleanup/replay cancels stale requests', async t => {
  let cursor = 0; const slots = [], queued = [], requests = []
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value }] },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] },
    useLayoutEffect(effect, deps) {
      const i = cursor++, previous = slots[i]
      if (!previous || deps.some((v, n) => v !== previous.deps[n])) {
        previous?.cleanup?.(); slots[i] = { deps, effect }; queued.push(() => { slots[i].cleanup = effect() })
      }
    },
  }
  t.mock.method(globalThis, 'fetch', (_url, options) => { const pending = deferred(); requests.push({ ...pending, signal: options.signal }); return pending.promise })
  const Component = loadComponent(hooks).default
  const render = symbol => { cursor = 0; const tree = Component({ symbol }); while (queued.length) queued.shift()(); return tree }
  render('AAPL'); render('AAPL'); render('AAPL'); assert.equal(requests.length, 1)
  // Strict Mode cleanup/replay of the effect.
  const effectSlot = slots.find(s => s?.effect); effectSlot.cleanup(); effectSlot.cleanup = effectSlot.effect()
  assert.equal(requests[0].signal.aborted, true); assert.equal(requests.length, 2)
  requests[0].resolve(Response.json(fixture())); requests[1].resolve(Response.json(fixture()))
  await new Promise(r => setImmediate(r)); assert.equal(render('AAPL').props.state.status, 'loaded'); assert.equal(requests.length, 2)
  render('MSFT'); assert.equal(requests.length, 3)
  effectSlot.cleanup() // prior cleanup is safe even after a new effect
  slots.find(s => s?.effect).cleanup(); assert.equal(requests[2].signal.aborted, true)
  requests[2].resolve(Response.json(fixture('MSFT'))); await new Promise(r => setImmediate(r))
})
