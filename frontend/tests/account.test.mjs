import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

// Real component static renders with mocked auth/router. Not mounted DOM tests.
const require = createRequire(import.meta.url)
function setup() {
  let state = { status: 'loading' }
  let redirects = []
  const cache = new Map()
  const router = {
    Link: ({ to, children, ...props }) => createElement('a', { ...props, href: to }, children),
    Navigate: (props) => { redirects.push(props); return null },
    useLocation: () => ({ pathname: '/account' }),
  }
  function load(path) {
    if (cache.has(path)) return cache.get(path)
    const output = { exports: {} }
    const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    })
    runInNewContext(outputText, { exports: output.exports, require: (name) => {
      if (name.endsWith('/authContext')) return { useAuth: () => state }
      if (name === 'react-router-dom') return router
      if (name.endsWith('.css')) return {}
      return require(name)
    } })
    cache.set(path, output.exports.default)
    return output.exports.default
  }
  const Guard = load('../src/auth/RequireAuth.tsx')
  const Account = load('../src/pages/AccountPage.tsx')
  return {
    render(next) {
      state = next; redirects = []
      const html = renderToStaticMarkup(createElement(Guard, null, createElement(Account)))
      return { html, redirects }
    },
  }
}
const signedIn = { status: 'signed_in', user: { email: '<script>person@example.test</script>' },
  session: { access_token: 'SECRET_ACCESS', refresh_token: 'SECRET_REFRESH' } }

test('loading guard displays accessible status without redirect or account content', () => {
  const { html, redirects } = setup().render({ status: 'loading' })
  assert.match(html, /role="status"/)
  assert.match(html, /Checking your session/)
  assert.doesNotMatch(html, /Your account|Signed in as|SECRET/)
  assert.equal(redirects.length, 0)
})

test('signed-out guard requests replacement login redirect with exact account return', () => {
  const { html, redirects } = setup().render({ status: 'signed_out' })
  assert.equal(html, '')
  assert.equal(redirects.length, 1)
  assert.equal(redirects[0].to, '/login')
  assert.equal(redirects[0].replace, true)
  assert.equal(redirects[0].state.returnTo, '/account')
})

test('unavailable guard has safe accessible fallback links and never redirects', () => {
  const { html, redirects } = setup().render({ status: 'unavailable' })
  assert.match(html, /role="status"/)
  assert.match(html, /Account access is unavailable/)
  assert.match(html, /href="\/login"/)
  assert.match(html, /href="\/dashboard"/)
  assert.doesNotMatch(html, /Signed in as|SECRET/)
  assert.equal(redirects.length, 0)
})

test('signed-in account escapes email and exposes no session tokens', () => {
  const { html, redirects } = setup().render(signedIn)
  assert.match(html, /Your account/)
  assert.match(html, /&lt;script&gt;person@example.test&lt;\/script&gt;/)
  assert.match(html, /not yet connected to this account/)
  assert.match(html, /href="\/dashboard"/)
  assert.doesNotMatch(html, /<script>|SECRET|access_token|refresh_token/)
  assert.equal(redirects.length, 0)
})

test('rendering session loss removes account content for every non-signed-in state', () => {
  const app = setup()
  for (const status of ['signed_out', 'loading', 'unavailable']) {
    assert.match(app.render(signedIn).html, /person@example.test/)
    const { html } = app.render({ status })
    assert.doesNotMatch(html, /person@example.test|Signed in as|Your account|SECRET/)
  }
})
