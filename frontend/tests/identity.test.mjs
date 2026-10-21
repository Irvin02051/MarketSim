import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createIdentityCheck, IdentityError, identityUrl, requestIdentity } from '../src/lib/identity.ts'
const id = '12345678-1234-4234-8234-123456789abc'
const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const base = 'http://127.0.0.1:8000'
const auth = { getSession: async () => ({ error: null, data: { session: { user: { id }, access_token: 'TEST_TOKEN' } } }) }
const signal = () => new AbortController().signal
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('identity sends only bearer credentials and rejects redirects', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, base + '/api/me')
    assert.deepEqual(options.headers, { Authorization: 'Bearer TEST_TOKEN' })
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store')
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'GET')
    return Response.json({ user_id: id })
  })
  assert.deepEqual(await requestIdentity(base, auth, id, signal()), { user_id: id })
})
test('missing session, client and changed SDK identity make no request', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No backend request'))
  for (const [client, code] of [[null, 'configuration'],
    [{ getSession: async () => ({ error: null, data: { session: null } }) }, 'authentication'], [auth, 'mismatch']]) {
    await assert.rejects(requestIdentity(base, client, other, signal()), { code })
  }
})
test('unsafe backend URLs fail before session acquisition', async () => {
  for (const url of ['', undefined, 'http://example.com', 'http://localhost.evil', 'ftp://localhost',
    'https://user:pass@example.com', 'https://example.com?token=x', 'https://example.com#x']) {
    await assert.rejects(requestIdentity(url, { getSession: () => assert.fail('No SDK call') }, id, signal()), { code: 'configuration' })
  }
  for (const url of ['https://example.com/prefix', 'http://localhost:8000', 'http://[::1]:8000']) assert.ok(identityUrl(url).endsWith('/api/me'))
})
test('401, 503, network, redirects, malformed responses and mismatch are safe and distinct', async t => {
  const mock = t.mock.method(globalThis, 'fetch')
  for (const [response, code] of [[new Response('PRIVATE', { status: 401 }), 'authentication'],
    [new Response('PRIVATE', { status: 503 }), 'unavailable'], [new Response('PRIVATE'), 'malformed'],
    [Response.json({}), 'malformed'], [Response.json({ user_id: 'bad' }), 'malformed'],
    [Response.json({ user_id: other }), 'mismatch'], [new Response('', { status: 302 }), 'network']]) {
    mock.mock.mockImplementation(async () => response)
    await assert.rejects(requestIdentity(base, auth, id, signal()), e => e.code === code && !e.message.includes('PRIVATE'))
  }
  mock.mock.mockImplementation(async () => { throw new TypeError('PRIVATE') })
  await assert.rejects(requestIdentity(base, auth, id, signal()), { code: 'network' })
})
test('deadline includes session acquisition and blocks late fetch', async t => {
  const pending = deferred()
  t.mock.method(globalThis, 'fetch', () => assert.fail('Late fetch'))
  await assert.rejects(requestIdentity(base, { getSession: () => pending.promise }, id, signal(), 5), { code: 'timeout' })
  pending.resolve(await auth.getSession()); await new Promise(r => setTimeout(r, 0))
})
test('deadline bounds fetch and body reading even when mocks ignore abort', async t => {
  const pending = new Promise(() => {})
  const mock = t.mock.method(globalThis, 'fetch', () => pending)
  await assert.rejects(requestIdentity(base, auth, id, signal(), 5), { code: 'timeout' })
  mock.mock.mockImplementation(async () => ({ status: 200, json: () => pending }))
  await assert.rejects(requestIdentity(base, auth, id, signal(), 5), { code: 'timeout' })
})
test('cancellation bounds stalled SDK and pre-aborted requests', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Cancelled fetch'))
  const controller = new AbortController()
  const pending = requestIdentity(base, { getSession: () => new Promise(() => {}) }, id, controller.signal)
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' })
  await assert.rejects(requestIdentity(base, auth, id, controller.signal), { name: 'AbortError' })
})
// Controller lifecycle tests, not mounted browser interactions.
test('duplicate submissions execute once; failures permit explicit retry', async () => {
  const pending = deferred(), states = []; let calls = 0
  const check = createIdentityCheck(() => { calls++; return pending.promise }, state => states.push(state))
  const first = check.start(); await check.start(); assert.equal(calls, 1)
  assert.deepEqual(states, [{ status: 'loading' }]); pending.resolve({ user_id: id }); await first
  assert.deepEqual(states.at(-1), { status: 'verified' })
  let retries = 0
  const retry = createIdentityCheck(async () => {
    if (++retries === 1) throw new IdentityError('unavailable')
    return { user_id: id }
  }, state => states.push(state))
  await retry.start(); assert.deepEqual(states.at(-1), { status: 'error', code: 'unavailable' })
  await retry.start(); assert.deepEqual(states.at(-1), { status: 'verified' })
})
test('cleanup for account change/sign-out ignores stale success and failure', async () => {
  for (const fail of [false, true]) {
    const pending = deferred(), states = []; let signal
    const old = createIdentityCheck(async s => {
      signal = s; await pending.promise
      if (fail) throw new IdentityError('unavailable')
      return { user_id: id }
    }, state => states.push(state))
    const work = old.start(); old.cancel(); assert.equal(signal.aborted, true)
    const nextStates = []
    const next = createIdentityCheck(async () => ({ user_id: other }), s => nextStates.push(s))
    assert.deepEqual(nextStates, []); pending.resolve(); await work
    assert.deepEqual(states, [{ status: 'loading' }])
    await next.start(); assert.deepEqual(nextStates.at(-1), { status: 'verified' })
  }
})
