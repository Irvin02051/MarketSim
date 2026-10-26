import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as watchlist from '../src/lib/watchlist.ts'
const { requestWatchlist, parseItems, createWatchlist, initialState, WatchlistError } = watchlist
const base = 'http://127.0.0.1:8000/prefix', user = '11111111-1111-4111-8111-111111111111'
const row = (symbol = 'AAPL') => ({ symbol, created_at: '2026-10-23T12:00:00Z' })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function sdk(id = user, token = 'SYNTHETIC_TOKEN') {
  const callbacks = new Set()
  return {
    getSession: async () => ({ error: null, data: { session: { user: { id }, access_token: token } } }),
    onAuthStateChange(callback) { callbacks.add(callback); return { data: { subscription: { unsubscribe() { callbacks.delete(callback) } } } } },
    emit(session) { for (const callback of callbacks) callback('SIGNED_OUT', session) }, callbacks,
  }
}
const call = (auth, op = { method: 'GET' }, signal = new AbortController().signal, timeout = 1000) => requestWatchlist(base, auth, user, op, signal, timeout)

test('list, empty, add and delete contracts send only per-request bearer credentials', async t => {
  let result = Response.json({ items: [row()] }); const calls = [], auth = sdk()
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return result })
  assert.deepEqual(await call(auth), [row()])
  result = Response.json({ items: [] }); assert.deepEqual(await call(auth), [])
  result = Response.json(row(), { status: 201 }); assert.deepEqual(await call(auth, { method: 'POST', symbol: 'AAPL' }), [row()])
  result = { status: 204, json: () => assert.fail('No DELETE JSON parsing') }
  assert.deepEqual(await call(auth, { method: 'DELETE', symbol: 'AAPL' }), [])
  assert.equal(calls[0].url, base + '/api/watchlist'); assert.equal(calls[3].url, base + '/api/watchlist/AAPL')
  assert.equal(calls[2].options.body, '{"symbol":"AAPL"}'); assert.equal(calls[3].options.body, undefined)
  for (const { url, options } of calls) {
    assert.equal(options.headers.Authorization, 'Bearer SYNTHETIC_TOKEN')
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error')
    assert.doesNotMatch(url, /TOKEN|user_id/)
  }
  assert.equal(auth.callbacks.size, 0)
})
test('validation rejects duplicates, unsupported symbols, malformed timestamps and wrong write symbol', async t => {
  for (const value of [null, [], {}, { items: [row(), row()] }, { items: [row('TSLA')] },
    ...['2026-02-30T12:00:00Z', '2026-01-01', '2026-01-01T12:00:00', 'PRIVATE', '2026-01-01T25:00:00Z']
      .map(created_at => ({ items: [{ ...row(), created_at }] }))]) assert.throws(() => parseItems(value), { code: 'malformed' })
  assert.deepEqual(parseItems({ items: [row('NVDA'), row()] }).map(x => x.symbol), ['AAPL', 'NVDA'])
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(row('MSFT'), { status: 201 }))
  await assert.rejects(call(sdk(), { method: 'POST', symbol: 'AAPL' }), { code: 'malformed', uncertain: true })
  mock.mock.mockImplementation(async () => new Response('PRIVATE'))
  await assert.rejects(call(sdk()), { code: 'malformed' })
})
test('missing, expired or changed session and unsafe configuration never send requests', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No backend request'))
  for (const auth of [sdk('other'), { ...sdk(), getSession: async () => ({ data: { session: null }, error: null }) },
    { ...sdk(), getSession: async () => ({ data: { session: null }, error: { message: 'PRIVATE' } }) }, sdk(user, '')]) await assert.rejects(call(auth), { code: 'authentication' })
  await assert.rejects(call(null), { code: 'configuration' })
  for (const url of ['http://evil.test', 'https://a.test?token=x', 'https://u:p@a.test', undefined]) {
    await assert.rejects(requestWatchlist(url, sdk(), user, { method: 'GET' }, new AbortController().signal), { code: 'configuration' })
  }
})
test('safe HTTP errors, duplicate feedback and network uncertainty redact provider bodies', async t => {
  const mock = t.mock.method(globalThis, 'fetch')
  for (const [status, code] of [[401, 'authentication'], [403, 'forbidden'], [422, 'invalid'], [503, 'unavailable'], [409, 'duplicate'], [302, 'network']]) {
    mock.mock.mockImplementation(async () => new Response('PRIVATE', { status }))
    await assert.rejects(call(sdk(), { method: 'POST', symbol: 'AAPL' }), e => e.code === code && !e.message.includes('PRIVATE') && e.uncertain === [503, 302].includes(status))
  }
  mock.mock.mockImplementation(async () => { throw new Error('PRIVATE') })
  await assert.rejects(call(sdk(), { method: 'DELETE', symbol: 'AAPL' }), { code: 'network', uncertain: true })
})
test('deadline covers SDK lookup and prevents late fetch; subscriptions are cleaned', async t => {
  const pending = deferred(), auth = sdk(); auth.getSession = () => pending.promise
  t.mock.method(globalThis, 'fetch', () => assert.fail('Late fetch'))
  await assert.rejects(call(auth, { method: 'POST', symbol: 'AAPL' }, undefined, 5), { code: 'timeout', uncertain: false })
  pending.resolve(await sdk().getSession()); await new Promise(r => setImmediate(r)); assert.equal(auth.callbacks.size, 0)
})
test('fetch and body deadlines mark sent writes uncertain', async t => {
  const never = new Promise(() => {}), mock = t.mock.method(globalThis, 'fetch', () => never)
  await assert.rejects(call(sdk(), { method: 'DELETE', symbol: 'AAPL' }, undefined, 5), { code: 'timeout', uncertain: true })
  mock.mock.mockImplementation(async () => ({ status: 201, json: () => never }))
  await assert.rejects(call(sdk(), { method: 'POST', symbol: 'AAPL' }, undefined, 5), { code: 'timeout', uncertain: true })
})
test('sign-out or account change during SDK lookup cannot send the old token', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Old token fetch'))
  for (const session of [null, { user: { id: 'other' }, access_token: 'OTHER' }]) {
    const auth = sdk(), pending = deferred(); auth.getSession = () => pending.promise
    const request = call(auth); auth.emit(session); await assert.rejects(request, { name: 'AbortError' })
    pending.resolve(await sdk().getSession()); await new Promise(r => setImmediate(r)); assert.equal(auth.callbacks.size, 0)
  }
})
test('cancellation stops pending work and cleans subscriptions', async t => {
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}))
  const auth = sdk(), controller = new AbortController(), request = call(auth, { method: 'GET' }, controller.signal)
  controller.abort(); await assert.rejects(request, { name: 'AbortError' }); assert.equal(auth.callbacks.size, 0)
  await assert.rejects(call(auth, { method: 'GET' }, controller.signal), { name: 'AbortError' })
})
test('concurrent users have isolated tokens', async t => {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => { seen.push(options.headers.Authorization); return Response.json({ items: [] }) })
  await Promise.all(['FIRST', 'SECOND'].map(token => call(sdk(user, token))))
  assert.deepEqual(seen.sort(), ['Bearer FIRST', 'Bearer SECOND'])
})
// Controllers, not mounted browser interactions.
test('controller gates duplicate clicks and refresh races, applies confirmed writes, handles duplicate add', async () => {
  let state, calls = 0; const pending = deferred()
  const control = createWatchlist(async op => {
    calls++; if (op.method === 'GET') return []
    if (calls === 2) return pending.promise
    if (op.method === 'POST') throw new WatchlistError('duplicate')
    return []
  }, next => { state = next })
  await control.execute({ method: 'GET' })
  const first = control.execute({ method: 'POST', symbol: 'AAPL' })
  await control.execute({ method: 'POST', symbol: 'MSFT' }); await control.execute({ method: 'GET' })
  assert.equal(calls, 2); assert.deepEqual(state.items, [])
  pending.resolve([row()]); await first; assert.deepEqual(state.items, [row()])
  await control.execute({ method: 'DELETE', symbol: 'AAPL' }); assert.deepEqual(state.items, [])
  await control.execute({ method: 'POST', symbol: 'AAPL' }); assert.equal(state.code, 'duplicate'); assert.equal(state.needsRefresh, true)
})
test('uncertain writes block further mutations until a successful refresh', async () => {
  let state, calls = 0, failRead = false
  const control = createWatchlist(async op => {
    calls++; if (op.method !== 'GET') throw new WatchlistError('timeout', true)
    if (failRead) throw new WatchlistError('unavailable'); return []
  }, next => { state = next })
  await control.execute({ method: 'GET' }); await control.execute({ method: 'POST', symbol: 'AAPL' })
  assert.match(state.notice, /may have completed/)
  await control.execute({ method: 'DELETE', symbol: 'AAPL' }); assert.equal(calls, 2)
  failRead = true; await control.execute({ method: 'GET' }); assert.equal(state.needsRefresh, true); assert.match(state.notice, /may have completed/)
  failRead = false; await control.execute({ method: 'GET' }); assert.equal(state.needsRefresh, false)
})
test('disposal clears private rows and ignores stale success/failure; fresh controller can reload', async () => {
  for (const fail of [false, true]) {
    const pending = deferred(); let state, signal
    const control = createWatchlist(async (op, s) => { signal = s; return op.method === 'GET' ? [row()] : pending.promise }, next => { state = next })
    await control.execute({ method: 'GET' })
    const write = control.execute({ method: 'POST', symbol: 'MSFT' })
    control.dispose(); assert.equal(signal.aborted, true); assert.deepEqual(state, initialState)
    if (fail) pending.reject(new Error('PRIVATE')); else pending.resolve([row('MSFT')])
    await write; assert.deepEqual(state, initialState)
    await control.execute({ method: 'GET' }); assert.deepEqual(state, initialState)
    const fresh = createWatchlist(async () => [], next => { state = next }); await fresh.execute({ method: 'GET' }); assert.deepEqual(state.items, [])
  }
})
// Actual static component HTML and redirect intent, not mounted React DOM tests.
const require = createRequire(import.meta.url)
function component(path, state, pathname = '/watchlist') {
  const output = { exports: {} }, redirects = []
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText.replaceAll('import.meta.env.VITE_API_BASE_URL', '"http://localhost:8000"')
  runInNewContext(code, { exports: output.exports, require: name => {
    if (name.endsWith('/authContext')) return { useAuth: () => state }
    if (name === '../lib/watchlist') return watchlist
    if (name === '../components/WatchlistQuote') return { __esModule: true, default: ({ symbol }) => createElement('p', { role: 'alert' }, `${symbol} quote unavailable (mock)`) }
    if (name === '../lib/auth') return { getBrowserAuthClient: () => assert.fail('No SSR request') }
    if (name.endsWith('.css')) return {}
    if (name === 'react-router-dom') return {
      Link: ({ to, children }) => createElement('a', { href: to }, children),
      Navigate: props => { redirects.push(props); return null }, useLocation: () => ({ pathname }),
    }
    return require(name)
  } })
  return { exports: output.exports, redirects }
}
test('guard allows exact account/watchlist returns only, preserving loading and unavailable states', () => {
  for (const pathname of ['/account', '/watchlist', '/research', '//evil.test', '/watchlist/', '/watchlist?x=y', '/%77atchlist']) {
    const loaded = component('../src/auth/RequireAuth.tsx', { status: 'signed_out' }, pathname)
    renderToStaticMarkup(createElement(loaded.exports.default, null, 'PRIVATE CONTENT'))
    assert.equal(loaded.redirects[0].replace, true)
    assert.equal(loaded.redirects[0].state?.returnTo, ['/account', '/watchlist'].includes(pathname) ? pathname : undefined)
  }
  for (const status of ['loading', 'unavailable']) {
    const loaded = component('../src/auth/RequireAuth.tsx', { status })
    const html = renderToStaticMarkup(createElement(loaded.exports.default, null, 'PRIVATE CONTENT'))
    assert.match(html, /role="status"/); assert.doesNotMatch(html, /PRIVATE CONTENT/); assert.equal(loaded.redirects.length, 0)
  }
})
test('static page has labeled controls, empty/loading/error states, dates, and fictional chart links', () => {
  const loaded = component('../src/pages/WatchlistPage.tsx', { status: 'signed_in', user: { id: user } })
  const render = state => renderToStaticMarkup(createElement(loaded.exports.WatchlistView, { state, selected: 'AAPL', select() {}, execute() {} }))
  assert.match(render({ ...initialState, busy: 'GET' }), /Loading your watchlist/)
  const empty = render({ ...initialState, loaded: true })
  assert.match(empty, /No symbols saved/); assert.match(empty, /label for="watchlist-symbol"/); assert.match(empty, />Add<\/button>/)
  const full = render({ ...initialState, loaded: true, items: [row()] })
  assert.match(full, /AAPL quote unavailable/); assert.doesNotMatch(full, /<button[^>]*disabled[^>]*aria-label="Remove/); assert.match(full, /membership only/)
  assert.match(full, /href="\/stocks\/AAPL"/); assert.match(full, /Remove AAPL from my watchlist/); assert.match(full, /2026-10-23/)
  assert.match(render({ ...initialState, code: 'authentication' }), /Log in again/)
  assert.match(render({ ...initialState, code: 'unavailable' }), /role="alert"/)
  assert.match(render({ ...initialState, loaded: true, needsRefresh: true }), /disabled/)
  const page = renderToStaticMarkup(createElement(loaded.exports.default))
  assert.match(page, /fictional historical charts/); assert.match(page, /not holdings/)
  assert.equal(renderToStaticMarkup(createElement(component('../src/pages/WatchlistPage.tsx', { status: 'signed_out' }).exports.default)), '')
})
