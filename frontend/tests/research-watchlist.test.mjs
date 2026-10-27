import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { eligibleSymbols, createResearchSave, createResearchScope } from '../src/lib/researchWatchlist.ts'
import * as actionModule from '../src/lib/researchWatchlist.ts'
import * as watchlist from '../src/lib/watchlist.ts'
const user = '11111111-1111-4111-8111-111111111111'
const base = 'http://localhost:8000'
const row = symbol => ({ symbol, created_at: '2026-10-26T12:00:00Z' })
const fixture = (quoteSymbols = ['AAPL'], historySymbols = []) => ({
  question: 'NVDA', status: 'unavailable', explanation: { findings: [{ statement: 'NVDA' }] },
  quotes: { evidence: quoteSymbols.map(symbol => ({ fictional: true, quote: { symbol, source: 'demo', data_kind: 'fictional' } })), errors: [{ symbol: 'NVDA' }] },
  historical_evidence: historySymbols.map((symbol, i) => ({ id: `hm${i + 1}`, provenance: { symbol, status: 'empty', coverage: 'partial_overlap' },
    price_change: { status: 'unavailable' }, sma_20: { status: 'unavailable' }, sma_50: { status: 'unavailable' }, adjacent_return_volatility_20: { status: 'unavailable' } })),
  tool_outcomes: [{ symbols: ['NVDA'] }],
})
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function auth() {
  const callbacks = new Set()
  return { getSession: async () => ({ data: { session: { user: { id: user }, access_token: 'SYNTHETIC' } }, error: null }),
    onAuthStateChange(cb) { callbacks.add(cb); return { data: { subscription: { unsubscribe() { callbacks.delete(cb) } } } } },
    emit(session) { for (const cb of callbacks) cb('SIGNED_OUT', session) }, callbacks }
}
const binding = result => ({ generation: 1, account: user, result })

test('eligibility uses evidence alone, ordered/deduplicated across types, including empty/partial history', () => {
  assert.deepEqual(eligibleSymbols(fixture()), ['AAPL'])
  assert.deepEqual(eligibleSymbols(fixture([], ['MSFT'])), ['MSFT'])
  assert.deepEqual(eligibleSymbols(fixture(['NVDA', 'AAPL'], ['NVDA', 'MSFT', 'AAPL'])), ['AAPL', 'MSFT', 'NVDA'])
  assert.deepEqual(eligibleSymbols(fixture([], [])), [])
  assert.deepEqual(eligibleSymbols(fixture(['TSLA'], [])), [])
})
test('arrival, selection, review, cancel and unconfirmed clicks send zero writes', async () => {
  let writes = 0, state
  const c = createResearchSave(binding(fixture(['AAPL', 'MSFT'])), () => true, async () => { writes++ }, s => { state = s })
  await c.confirm(); c.select('MSFT'); c.review(); assert.equal(state.phase, 'review')
  assert.equal(c.cancel(), true); await c.confirm(); assert.equal(writes, 0)
  c.review(); c.select('AAPL'); await c.confirm(); assert.equal(writes, 0)
})
test('Confirm sends exactly one selected-symbol POST and uses the checked session', async t => {
  const pending = deferred(), client = auth(); let calls = 0, state
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++; assert.equal(url, base + '/api/watchlist'); assert.equal(options.method, 'POST')
    assert.equal(options.body, '{"symbol":"MSFT"}'); assert.equal(options.headers.Authorization, 'Bearer SYNTHETIC')
    assert.equal(options.credentials, 'omit'); return pending.promise
  })
  const c = createResearchSave(binding(fixture(['AAPL', 'MSFT'])), () => true,
    (symbol, signal) => watchlist.requestWatchlist(base, client, user, { method: 'POST', symbol }, signal), s => { state = s })
  c.select('MSFT'); c.review(); const first = c.confirm(); await c.confirm()
  await new Promise(r => setImmediate(r)); assert.equal(calls, 1); assert.equal(state.phase, 'saving')
  pending.resolve(Response.json(row('MSFT'), { status: 201 })); await first; assert.equal(state.phase, 'saved')
  await c.confirm(); assert.equal(calls, 1)
})
test('409 and definite errors require deliberate review; uncertain responses block that symbol', async t => {
  const mock = t.mock.method(globalThis, 'fetch')
  for (const [status, body, phase] of [[409, 'PRIVATE', 'duplicate'], [401, 'PRIVATE', 'error'], [403, 'PRIVATE', 'error'],
    [422, 'PRIVATE', 'error'], [503, 'PRIVATE', 'uncertain'], [201, '{}', 'uncertain']]) {
    let calls = 0, state
    mock.mock.mockImplementation(async () => { calls++; return new Response(body, { status }) })
    const c = createResearchSave(binding(fixture(['AAPL', 'MSFT'])), () => true,
      (symbol, signal) => watchlist.requestWatchlist(base, auth(), user, { method: 'POST', symbol }, signal), s => { state = s })
    c.review(); await c.confirm(); assert.equal(state.phase, phase); assert.doesNotMatch(JSON.stringify(state), /PRIVATE/)
    await c.confirm(); assert.equal(calls, 1)
    if (phase === 'uncertain') { assert.equal(c.review(), false); c.select('MSFT'); c.select('AAPL'); assert.equal(c.review(), false) }
    else assert.equal(c.review(), true)
  }
})
test('timeout/network uncertainty never reports success or retries automatically', async t => {
  let state, calls = 0
  t.mock.method(globalThis, 'fetch', () => { calls++; return new Promise(() => {}) })
  const c = createResearchSave(binding(fixture()), () => true,
    (symbol, signal) => watchlist.requestWatchlist(base, auth(), user, { method: 'POST', symbol }, signal, 5), s => { state = s })
  c.review(); await c.confirm(); assert.equal(state.phase, 'uncertain'); assert.equal(state.code, 'timeout')
  c.review(); await c.confirm(); assert.equal(calls, 1)
})
test('account change during delayed session acquisition prevents old-account POST', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No stale write'))
  const client = auth(), pending = deferred(); client.getSession = () => pending.promise
  let current = true, state
  const c = createResearchSave(binding(fixture()), () => current,
    (symbol, signal) => watchlist.requestWatchlist(base, client, user, { method: 'POST', symbol }, signal), s => { state = s })
  const subscription = client.onAuthStateChange(() => { current = false; c.dispose() })
  c.review(); const work = c.confirm(); client.emit(null)
  pending.resolve(await auth().getSession()); await work; assert.equal(state.phase, 'invalidated')
  subscription.data.subscription.unsubscribe(); assert.equal(client.callbacks.size, 0)
})
test('helper rejects a session belonging to a different account without a write', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Wrong account'))
  const client = auth(); client.getSession = async () => ({ data: { session: { user: { id: 'other' }, access_token: 'OTHER' } }, error: null })
  let state
  const c = createResearchSave(binding(fixture()), () => true,
    (symbol, signal) => watchlist.requestWatchlist(base, client, user, { method: 'POST', symbol }, signal), s => { state = s })
  c.review(); await c.confirm(); assert.equal(state.code, 'authentication'); assert.equal(state.phase, 'error')
})
test('generation/account/result invalidation and unmount suppress late success and failure', async () => {
  for (const fail of [false, true]) {
    const pending = deferred(); let current = true, state, signal, writes = 0
    const c = createResearchSave(binding(fixture()), () => current, (_symbol, s) => { writes++; signal = s; return pending.promise }, s => { state = s })
    c.review(); const work = c.confirm(); current = false; c.dispose(); assert.equal(signal.aborted, true)
    if (fail) pending.reject(new Error('PRIVATE')); else pending.resolve(row('AAPL'))
    await work; assert.equal(state.phase, 'invalidated'); c.review(); await c.confirm(); assert.equal(writes, 1)
  }
  let current = true, writes = 0
  const c = createResearchSave(binding(fixture()), () => current, async () => { writes++ }, () => {})
  c.review(); current = false; await c.confirm(); assert.equal(writes, 0)
})

const require = createRequire(import.meta.url)
function compile(file, dependencies, globals = {}) {
  const output = { exports: {} }
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText.replaceAll('import.meta.env.VITE_API_BASE_URL', JSON.stringify(base))
  runInNewContext(code, { exports: output.exports, ...globals, require: name => name in dependencies ? dependencies[name] : name.endsWith('.css') ? {} : require(name) })
  return output.exports.default
}
const router = { Link: ({ to, children }) => createElement('a', { href: to }, children) }
const props = () => { const scope = createResearchScope(); return { result: fixture(), generation: scope.next(), scope } }
function action(state, overrides = {}) {
  return compile('../src/components/ResearchWatchlistAction.tsx', {
    '../auth/authContext': { useAuth: () => state }, '../lib/auth': { getBrowserAuthClient: () => null },
    '../lib/researchWatchlist': actionModule, '../lib/watchlist': watchlist, 'react-router-dom': router, ...overrides,
  })
}
test('static HTML handles all auth states, eligibility and evidence limitations without writes', () => {
  for (const status of ['loading', 'unavailable', 'signed_out', 'signed_in']) {
    const html = renderToStaticMarkup(createElement(action({ status, user: { id: user } }), props()))
    assert.match(html, /Save an analyzed stock/)
    if (status === 'signed_in') { assert.match(html, /Review save/); assert.match(html, /Fictional|fictional/); assert.match(html, /explanation was not completed/); assert.doesNotMatch(html, />Confirm add<\/button>/) }
    else assert.doesNotMatch(html, /Review save|Confirm add/)
    if (status === 'signed_out') assert.match(html, /No pending save will resume/)
  }
  const p = props(); p.result = fixture([], ['MSFT'])
  const html = renderToStaticMarkup(createElement(action({ status: 'signed_in', user: { id: user } }), p))
  assert.match(html, /No historical observations/); assert.match(html, /coverage is partial/); assert.match(html, /metrics are unavailable/)
  p.result = fixture([], [])
  assert.doesNotMatch(renderToStaticMarkup(createElement(action({ status: 'signed_in', user: { id: user } }), p)), /Review save|<select/)
})
// Mock hook/handler harness, not mounted React DOM or browser coverage.
function harness(client) {
  const slots = [], effects = [], focused = []; let cursor = 0
  const hooks = {
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], next => { slots[i] = next }] },
    useRef(value) { const i = cursor++; if (!(i in slots)) slots[i] = { current: value }; return slots[i] },
    useLayoutEffect(effect, deps) {
      const i = cursor++, prev = slots[i]
      if (!prev || deps.some((v, n) => v !== prev.deps[n])) { prev?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = effect() }) }
    },
  }
  const Component = action({ status: 'signed_in', user: { id: user } }, { react: hooks,
    '../lib/auth': { getBrowserAuthClient: () => ({ auth: client }) } })
  const p = props(), outer = Component(p), child = outer.props.children.at(-1)
  let tree
  function nodes(node = tree) { if (Array.isArray(node)) return node.flatMap(nodes); return node && typeof node === 'object' ? [node, ...nodes(node.props?.children)] : [] }
  const render = () => {
    cursor = 0; tree = child.type(child.props)
    for (const node of nodes()) if (node.props?.ref) node.props.ref.current = { focus: () => focused.push(node.type) }
    while (effects.length) effects.shift()()
    return tree
  }
  render(); render()
  return { p, render, focused, nodes, button: text => nodes().find(n => n.type === 'button' && n.props.children === text),
    dispose: () => slots.forEach(slot => slot?.cleanup?.()) }
}
test('real handlers open/focus confirmation, Cancel returns focus, and Confirm alone writes', async t => {
  let writes = 0
  t.mock.method(globalThis, 'fetch', async () => { writes++; return Response.json(row('AAPL'), { status: 201 }) })
  const h = harness(auth())
  h.button('Review save').props.onClick(); h.render(); assert.equal(h.focused.at(-1), 'h3'); assert.equal(writes, 0)
  h.button('Cancel').props.onClick(); h.render(); assert.equal(h.focused.at(-1), 'button'); assert.equal(writes, 0)
  h.button('Review save').props.onClick(); h.render(); h.button('Confirm add').props.onClick(); h.button('Confirm add').props.onClick()
  await new Promise(r => setImmediate(r)); h.render(); assert.equal(writes, 1)
  assert.match(JSON.stringify(h.nodes().map(n => n.props?.children).filter(x => typeof x === 'string')), /saved to your watchlist/)
  h.dispose()
})
test('synchronous component auth invalidation and parent generation invalidator cancel confirmation', () => {
  for (const event of ['account', 'generation']) {
    const client = auth(), h = harness(client)
    h.button('Review save').props.onClick(); h.render(); const focusCount = h.focused.length
    if (event === 'account') client.emit({ user: { id: 'other' } })
    else { h.p.scope.next() }
    h.render(); assert.equal(h.button('Confirm add'), undefined); assert.equal(h.focused.length, focusCount)
    h.dispose(); assert.equal(client.callbacks.size, 0)
  }
})
test('research page retains evidence with independent action and increments generation even for identical submissions', async () => {
  const slots = []; let cursor = 0, tree, invalidations = 0, requests = 0
  const hooks = {
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value; return [slots[i], v => { slots[i] = v }] },
    useRef(value) { const i = cursor++; if (!(i in slots)) slots[i] = { current: value }; return slots[i] }, useEffect() {},
  }
  const Page = compile('../src/pages/ResearchPage.tsx', { react: hooks, 'react-router-dom': router,
    '../components/ResearchWatchlistAction': { __esModule: true, default: () => createElement('p', null, 'Save failed safely') },
    '../components/HistoricalResearchEvidence': { __esModule: true, default: () => null },
    '../lib/researchWatchlist': actionModule,
    '../lib/research': { validateQuestion: q => q, requestResearch: async () => { requests++; return { ...fixture(), question: 'same', model_calls: 0, tool_requests: 0, historical_tool_outcomes: [], quotes: { ...fixture().quotes, label: 'Fictional', limitations: [] }, explanation: { findings: [], message: 'Evidence retained', code: 'unavailable' } } }, researchOutcome: () => ({ status: 'unavailable', message: 'Evidence retained', code: 'unavailable' }) },
  }, { AbortController, setTimeout, clearTimeout })
  const render = () => { cursor = 0; tree = Page(); return tree }
  const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.props?.children)] : []
  render(); nodes(tree).find(n => n.type === 'textarea').props.onChange({ target: { value: 'same' } }); render()
  const scope = slots.find(s => s?.register)
  scope.register(0, () => { invalidations++ })
  for (let i = 1; i <= 2; i++) {
    await nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); render()
    const result = nodes(tree).find(n => typeof n.type === 'function' && n.props.result)
    assert.equal(result.props.generation, i)
    scope.register(i, () => { invalidations++ })
    const html = renderToStaticMarkup(createElement(result.type, result.props))
    assert.match(html, /Quote evidence/); assert.match(html, /Evidence retained/); assert.match(html, /Save failed safely/)
  }
  assert.equal(requests, 2); assert.equal(invalidations, 2)
})

test('scope replaces research contexts and prevents stale confirmation before any session lookup', async () => {
  const scope = createResearchScope(); let writes = 0
  const generation = scope.next(), result = fixture()
  const old = createResearchSave({ generation, account: user, result }, () => scope.isCurrent(generation), async () => { writes++ }, () => {})
  scope.register(generation, () => old.dispose()); old.review()
  assert.equal(scope.next(), generation + 1); await old.confirm(); assert.equal(writes, 0)
  let invalidated = false
  scope.register(generation, () => { invalidated = true }); assert.equal(invalidated, true)
  // Same generation but a replacement result still requires a fresh, empty confirmation.
  const replacement = createResearchSave({ generation: generation + 1, account: user, result: fixture(['MSFT']) }, () => true, async () => { writes++ }, () => {})
  await replacement.confirm(); assert.equal(writes, 0)
  replacement.select('AAPL'); replacement.review(); await replacement.confirm(); assert.equal(writes, 1)
})
