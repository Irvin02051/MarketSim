import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as actions from '../src/lib/auth.ts'

const callback = 'http://localhost:5173/auth/callback'
const input = { mode: 'login', email: ' person@example.test ', password: 'synthetic-password', fullName: ' Person ' }
const session = { user: { id: 'synthetic-user' } }
const success = { data: { session }, error: null }
const failure = { data: { session: null }, error: { message: 'SECRET raw provider details' } }
const location = { origin: 'http://localhost:5173', pathname: '/auth/callback', search: '',
  hash: '#access_token=synthetic-access&refresh_token=synthetic-refresh&type=signup&token_type=bearer' }

test('password login sends only credentials, requires a session and redacts failures', async () => {
  let received
  assert.equal(await actions.submitCredentials({ signInWithPassword: async (value) => { received = value; return success } }, input, null), 'signed_in')
  assert.deepEqual(received, { email: 'person@example.test', password: input.password })
  for (const response of [failure, { data: { session: null }, error: null }]) {
    assert.equal(await actions.submitCredentials({ signInWithPassword: async () => response }, input, null), 'login_failed')
  }
  assert.equal(await actions.submitCredentials({ signInWithPassword: async () => { throw new Error('SECRET') } }, input, null), 'login_failed')
  assert.doesNotMatch(JSON.stringify(actions.authMessages), /SECRET|synthetic-password/)
})

test('signup preserves trusted redirect and name, handles sessions and ambiguous pending results', async () => {
  for (const response of [success, { data: { session: null, user: { identities: [] } }, error: null },
    { data: { session: null, user: null }, error: null }]) {
    let received
    const result = await actions.submitCredentials({ signUp: async (value) => { received = value; return response } },
      { ...input, mode: 'signup' }, callback)
    assert.equal(result, response.data.session ? 'signed_in' : 'confirmation_pending')
    assert.deepEqual(received.options, { emailRedirectTo: callback, data: { full_name: 'Person' } })
    assert.equal(received.password, input.password)
  }
  assert.match(actions.authMessages.confirmation_pending, /does not confirm that an account was created/)
  assert.equal(await actions.submitCredentials({ signUp: async () => failure }, { ...input, mode: 'signup' }, callback), 'failed')
})

test('missing client or callback never submits signup', async () => {
  const auth = { signUp() { assert.fail('Must not call SDK') } }
  assert.equal(await actions.submitCredentials(null, input, callback), 'unavailable')
  assert.equal(await actions.submitCredentials(auth, { ...input, mode: 'signup' }, null), 'unavailable')
})

test('callback configuration requires a fixed same-origin URL without credentials or redirect parameters', () => {
  assert.equal(actions.trustedCallback(callback, location.origin), callback)
  assert.equal(actions.trustedCallback('https://example.test/auth/callback', 'https://example.test'), 'https://example.test/auth/callback')
  for (const value of [undefined, '', '/auth/callback', 'http://evil.test/auth/callback',
    `${callback}?next=https://evil.test`, `${callback}#access_token=SECRET`, 'http://user:pass@localhost:5173/auth/callback',
    'http://localhost:5173/other', ` ${callback}`]) {
    assert.equal(actions.trustedCallback(value, location.origin), null)
  }
  assert.equal(actions.trustedCallback('http://example.test/auth/callback', 'http://example.test'), null)
})

test('confirmation scrubs URL before SDK call and is processed once across effect replay', async () => {
  const complete = actions.createConfirmationHandler()
  let cleared = 0, calls = 0, resolve
  const pending = new Promise((yes) => { resolve = yes })
  const auth = { setSession: (value) => {
    calls++
    assert.equal(cleared, 1)
    assert.deepEqual(value, { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' })
    return pending
  } }
  const first = complete(auth, location, callback, () => { cleared++ })
  const replay = complete(auth, { ...location, hash: '' }, callback, () => { cleared++ })
  assert.equal(first, replay)
  resolve(success)
  assert.equal(await first, 'signed_in')
  assert.equal(calls, 1)
  assert.equal(cleared, 1)
})

test('invalid callbacks scrub URL without processing tokens, arbitrary redirects or PKCE codes', async () => {
  const auth = { setSession() { assert.fail('Must not call SDK') } }
  for (const change of [{ hash: '' }, { search: '?code=SECRET' }, { search: '?next=https://evil.test' },
    { pathname: '/other' }, { hash: `${location.hash}&error=SECRET` },
    { hash: location.hash.replace('type=signup', 'type=recovery') },
    { hash: location.hash.replace('refresh_token=synthetic-refresh', 'refresh_token=') },
    { hash: `${location.hash}&access_token=duplicate` }]) {
    let cleared = false
    assert.equal(await actions.createConfirmationHandler()(auth, { ...location, ...change }, callback,
      () => { cleared = true }), 'failed')
    assert.equal(cleared, true)
  }
})

test('callback missing configuration and SDK failures are safe', async () => {
  assert.equal(await actions.createConfirmationHandler()(null, location, callback, () => {}), 'unavailable')
  for (const setSession of [async () => failure, async () => { throw new Error('SECRET') },
    async () => ({ data: { session: null }, error: null })]) {
    assert.equal(await actions.createConfirmationHandler()({ setSession }, location, callback, () => {}), 'failed')
  }
})

test('submission gate prevents duplicates and releases after failure', async () => {
  const gate = actions.createSubmissionGate()
  let resolve, calls = 0
  const first = gate(() => { calls++; return new Promise((yes) => { resolve = yes }) })
  assert.equal(await gate(() => { assert.fail('duplicate SDK request') }), null)
  resolve('failed')
  assert.equal(await first, 'failed')
  assert.equal(await gate(async () => { calls++; return 'signed_in' }), 'signed_in')
  assert.equal(calls, 2)
})

test('sign-out explicitly uses local scope, reporting errors without discarding them', async () => {
  let options
  assert.equal(await actions.signOutLocal({ signOut: async (value) => { options = value; return { error: null } } }), 'signed_out')
  assert.deepEqual(options, { scope: 'local' })
  assert.equal(await actions.signOutLocal(null), 'unavailable')
  assert.equal(await actions.signOutLocal({ signOut: async () => failure }), 'failed')
  assert.equal(await actions.signOutLocal({ signOut: async () => { throw new Error('SECRET') } }), 'failed')
})

// Render actual components to HTML using the existing TypeScript/React toolchain.
// These assertions are not mounted browser interaction tests.
const require = createRequire(import.meta.url)
function component(path, state) {
  const output = { exports: {} }
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  })
  runInNewContext(outputText, { exports: output.exports, require: (name) => {
    if (name === '../auth/authContext') return { useAuth: () => state }
    if (name === '../lib/auth') return actions
    if (name === 'react-router-dom') return { useNavigate: () => () => {}, useLocation: () => ({ state: null }), Link: ({ to, children, ...props }) => createElement('a', { ...props, href: to }, children) }
    if (name.endsWith('.css')) return {}
    if (name === '../components/ServiceStatus') return { __esModule: true, default: () => null }
    return require(name)
  } })
  return output.exports.default
}

test('rendered forms retain labels, password controls, educational wording and unavailable states', () => {
  const Form = component('../src/components/AuthForm.tsx', { status: 'unavailable' })
  const login = renderToStaticMarkup(createElement(Form, { mode: 'login' }))
  assert.match(login, /Authentication is unavailable/)
  assert.match(login, /Remember me is unavailable/)
  assert.match(login, /Forgot password\? \(Unavailable\)/)
  assert.match(login, /aria-label="Show password"/)
  const signup = renderToStaticMarkup(createElement(Form, { mode: 'signup' }))
  assert.match(signup, /Full name/)
  assert.match(signup, /Confirm password/)
  assert.match(signup, /not a legal terms or privacy policy/)
  assert.doesNotMatch(signup, /No account is created|Form data is not sent/)
})

test('rendered dashboard exposes sign-out only to signed-in users and keeps demo navigation', () => {
  for (const status of ['signed_in', 'signed_out']) {
    const Dashboard = component('../src/pages/DashboardPage.tsx', { status })
    const html = renderToStaticMarkup(createElement(Dashboard))
    assert.equal(html.includes('>Sign out</button>'), status === 'signed_in')
    assert.match(html, /Back to login/)
    assert.match(html, /Demo mode/)
    assert.match(html, /not personal account data/)
  }
})

test('login errors use safe categories and never confirmation or account-existence wording', async () => {
  for (const [error, expected] of [
    [{ code: 'invalid_credentials', message: 'SECRET account missing' }, 'login_failed'],
    [{ code: 'email_not_confirmed' }, 'login_failed'],
    [{ name: 'AuthRetryableFetchError', status: 0 }, 'network_failed'],
    [{ status: 503 }, 'network_failed'],
    [{ code: 'invalid_api_key' }, 'unavailable'],
  ]) {
    const result = await actions.submitCredentials({ signInWithPassword: async () => ({ ...failure, error }) }, input, null)
    assert.equal(result, expected)
    assert.doesNotMatch(actions.authMessages[result], /SECRET|account missing|expired|confirmation link/i)
  }
  assert.equal(await actions.submitCredentials({ signInWithPassword: async () => { throw new TypeError('SECRET') } }, input, null), 'network_failed')
})

// Executes real component handlers with a small mocked hook/router harness.
// This is handler-level interaction coverage, not React DOM/browser interaction.
function handlers(path, status, sdk, routerState = null) {
  const slots = [], effects = [], navigations = []
  let cursor = 0, tree
  const location = { state: routerState }
  const hooks = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(effect) {
      const index = cursor++
      if (!(index in slots)) { slots[index] = true; effects.push(effect) }
    },
  }
  const output = { exports: {} }
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  })
  runInNewContext(outputText, { exports: output.exports, document: { getElementById: () => ({ focus() {} }) }, require: (name) => {
    if (name === 'react') return hooks
    if (name === '../auth/authContext') return { useAuth: () => ({ status }) }
    if (name === '../lib/auth') return { ...actions, getBrowserAuthClient: () => ({ auth: sdk }), browserCallback: () => callback }
    if (name === 'react-router-dom') return { Link: 'a', useLocation: () => location,
      useNavigate: () => (to, options) => { navigations.push(JSON.parse(JSON.stringify({ to, options }))); location.state = options.state ?? null } }
    if (name.endsWith('.css')) return {}
    if (name === '../components/ServiceStatus') return { __esModule: true, default: () => null }
    return require(name)
  } })
  const render = () => { cursor = 0; tree = output.exports.default({ mode: 'login' }); return tree }
  render()
  const cleanup = effects.map((effect) => effect())
  function nodes(value = tree) {
    if (Array.isArray(value)) return value.flatMap(nodes)
    if (!value || typeof value !== 'object') return []
    return [value, ...nodes(value.props?.children ?? null)]
  }
  return { render, navigations, nodes, unmount: () => cleanup.forEach((stop) => stop?.()),
    field: (id) => nodes().find((node) => node.props?.id === id),
    submit: () => nodes().find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} }),
    text: () => JSON.stringify(tree),
  }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('login handler navigates with replacement and clears sign-out feedback on a new attempt', async () => {
  const h = handlers('../src/components/AuthForm.tsx', 'signed_out', { signInWithPassword: async () => success }, { signedOut: true })
  assert.match(h.text(), /Signed out successfully/)
  h.field('email').props.onChange('person@example.test')
  h.field('password').props.onChange('synthetic-password')
  h.render()
  h.submit()
  h.render()
  assert.doesNotMatch(h.text(), /Signed out successfully/)
  assert.equal(h.field('password').props.value, '')
  await settle()
  assert.deepEqual(h.navigations.at(-1), { to: '/dashboard', options: { replace: true } })
  assert.deepEqual(h.navigations[0], { to: '/login', options: { replace: true, state: null } })
  h.unmount()
})

test('failed login stays on the form with login-specific feedback', async () => {
  const h = handlers('../src/components/AuthForm.tsx', 'signed_out', { signInWithPassword: async () => failure })
  h.field('email').props.onChange('person@example.test')
  h.field('password').props.onChange('synthetic-password')
  h.render(); h.submit(); await settle(); h.render()
  assert.equal(h.navigations.length, 0)
  assert.match(h.text(), /Unable to log in/)
  assert.doesNotMatch(h.text(), /Confirmation links|SECRET/)
  h.unmount()
})

test('sign-out handler navigates with success state only after SDK success', async () => {
  for (const error of [null, { message: 'SECRET' }]) {
    const h = handlers('../src/pages/DashboardPage.tsx', 'signed_in', { signOut: async (options) => {
      assert.equal(options.scope, 'local')
      return { error }
    } })
    h.nodes().find((node) => node.type === 'button' && node.props.onClick).props.onClick()
    await settle(); h.render()
    if (error) {
      assert.equal(h.navigations.length, 0)
      assert.match(h.text(), /Unable to sign out/)
      assert.doesNotMatch(h.text(), /Signed out successfully|SECRET/)
    } else {
      assert.deepEqual(h.navigations, [{ to: '/login', options: { replace: true, state: { signedOut: true } } }])
    }
    h.unmount()
  }
})
