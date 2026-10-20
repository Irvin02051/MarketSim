import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAuthClientGetter, observeAuth } from '../src/lib/auth.ts'

const configuration = { VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_fixture' }
const session = (id = 'user-1') => ({ user: { id }, access_token: 'synthetic-test-token' })
const flush = () => new Promise((resolve) => setImmediate(resolve))
function harness() {
  let resolve, reject, callback
  let unsubscribed = 0
  let calls = 0
  const pending = new Promise((yes, no) => { resolve = yes; reject = no })
  const auth = {
    getSession() { calls++; return pending },
    onAuthStateChange(cb) { callback = cb; return { data: { subscription: { unsubscribe() { unsubscribed++ } } } } },
  }
  return { auth, resolve, reject, emit: (event, value) => callback(event, value),
    get calls() { return calls }, get unsubscribed() { return unsubscribed } }
}

test('missing and invalid configuration never creates a client or accesses storage', () => {
  const fail = () => { assert.fail('Must not initialize SDK or storage') }
  for (const value of [{}, { ...configuration, VITE_SUPABASE_URL: '' },
    ...['http://example.com', 'garbage', 'https://user:pass@example.com', 'https://example.com/path',
      'https://example.com?key=secret', 'https://example.com#fragment'].map((url) => ({ ...configuration, VITE_SUPABASE_URL: url })),
    ...['', 'sb_secret_private', 'eyJlegacyJwt', 'sb_publishable_has whitespace'].map((key) => ({ ...configuration, VITE_SUPABASE_PUBLISHABLE_KEY: key }))]) {
    assert.equal(createAuthClientGetter(value, fail, fail)(), null)
  }
  const states = []
  observeAuth(null, (state) => states.push(state))()
  assert.deepEqual(states, [{ status: 'unavailable' }])
})

test('one client uses the supplied native session storage and SDK refresh', () => {
  const storage = { getItem() {}, setItem() {}, removeItem() {} }
  const client = {}
  let count = 0
  const get = createAuthClientGetter(configuration, () => storage, (url, key, options) => {
    count++
    assert.equal(url, configuration.VITE_SUPABASE_URL)
    assert.equal(key, configuration.VITE_SUPABASE_PUBLISHABLE_KEY)
    assert.deepEqual(options.auth, { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false })
    return client
  })
  assert.equal(get(), client)
  assert.equal(get(), client)
  assert.equal(count, 1)
})

test('storage access and client construction failures stay redacted', () => {
  for (const storageFails of [true, false]) {
    const get = createAuthClientGetter(configuration, () => {
      if (storageFails) throw new Error('SENSITIVE storage error')
      return {}
    }, () => { throw new Error('SENSITIVE SDK error') })
    assert.equal(get(), null)
    assert.equal(get(), null)
  }
})

test('initialization restores signed-out and signed-in states', async () => {
  for (const value of [null, session()]) {
    const h = harness(), states = []
    const stop = observeAuth(h.auth, (s) => states.push(s))
    assert.deepEqual(states, [{ status: 'loading' }])
    h.resolve({ data: { session: value }, error: null })
    await flush()
    assert.deepEqual(states.at(-1), value ? { status: 'signed_in', session: value, user: value.user } : { status: 'signed_out' })
    stop()
    stop()
    assert.equal(h.unsubscribed, 1)
  }
})

test('synchronous sign-in, refresh, user-update and sign-out events publish without auth calls', async () => {
  const h = harness(), states = []
  const stop = observeAuth(h.auth, (s) => states.push(s))
  for (const event of ['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED']) {
    const value = session(event)
    assert.equal(h.emit(event, value), undefined)
    assert.deepEqual(states.at(-1), { status: 'signed_in', session: value, user: value.user })
  }
  h.emit('SIGNED_OUT', null)
  assert.deepEqual(states.at(-1), { status: 'signed_out' })
  assert.equal(h.calls, 1)
  h.resolve({ data: { session: session('obsolete') }, error: null })
  await flush()
  assert.deepEqual(states.at(-1), { status: 'signed_out' })
  stop()
})

test('returned and thrown initialization errors are unavailable without raw details', async () => {
  for (const rejects of [false, true]) {
    const h = harness(), states = []
    const stop = observeAuth(h.auth, (s) => states.push(s))
    h.emit('INITIAL_SESSION', null)
    const error = new Error('SENSITIVE raw provider message')
    if (rejects) h.reject(error)
    else h.resolve({ data: { session: null }, error })
    await flush()
    assert.deepEqual(states.at(-1), { status: 'unavailable' })
    assert.doesNotMatch(JSON.stringify(states), /SENSITIVE/)
    stop()
  }
})

test('new auth events win over stale initialization failures and INITIAL_SESSION', async () => {
  const h = harness(), states = []
  const stop = observeAuth(h.auth, (s) => states.push(s))
  const value = session()
  h.emit('SIGNED_IN', value)
  h.emit('INITIAL_SESSION', null)
  h.reject(new Error('obsolete'))
  await flush()
  assert.deepEqual(states.at(-1), { status: 'signed_in', session: value, user: value.user })
  stop()
})

test('late INITIAL_SESSION cannot overwrite completed initialization', async () => {
  const h = harness(), states = []
  const stop = observeAuth(h.auth, (s) => states.push(s))
  h.resolve({ data: { session: session() }, error: null })
  await flush()
  h.emit('INITIAL_SESSION', null)
  assert.equal(states.at(-1).status, 'signed_in')
  stop()
})

test('effect cleanup/remount ignores old events and pending results', async () => {
  const old = harness(), current = harness(), states = []
  const stop = observeAuth(old.auth, (s) => states.push(s))
  stop()
  const stopCurrent = observeAuth(current.auth, (s) => states.push(s))
  old.emit('SIGNED_IN', session('old'))
  old.resolve({ data: { session: session('old') }, error: null })
  current.resolve({ data: { session: null }, error: null })
  await flush()
  assert.deepEqual(states, [{ status: 'loading' }, { status: 'loading' }, { status: 'signed_out' }])
  stopCurrent()
  current.emit('SIGNED_IN', session('late'))
  assert.equal(states.length, 3)
  assert.equal(old.unsubscribed, 1)
  assert.equal(current.unsubscribed, 1)
})

test('synchronous SDK setup failures are safe and release any subscription', () => {
  for (const subscribeFails of [true, false]) {
    let released = 0
    const states = []
    const stop = observeAuth({
      onAuthStateChange() {
        if (subscribeFails) throw new Error('SENSITIVE')
        return { data: { subscription: { unsubscribe() { released++ } } } }
      },
      getSession() { throw new Error('SENSITIVE') },
    }, (state) => states.push(state))
    stop()
    assert.deepEqual(states.at(-1), { status: 'unavailable' })
    assert.equal(released, subscribeFails ? 0 : 1)
  }
})
