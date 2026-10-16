import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { parseResearch, requestResearch, validateQuestion } from '../src/lib/research.ts'

const question = 'Compare Apple and Microsoft reported percentage changes.'
const fixture = () => ({
  question, model_calls: 2, tool_requests: 1,
  tool_outcomes: [{ tool: 'get_quotes', symbols: ['AAPL'], code: 'ok' }],
  explanation: { status: 'answered', code: 'answered', message: 'Validated from evidence.',
    findings: [{ statement: 'AAPL reported daily range is 4 USD.', statement_origin: 'backend', evidence_ids: ['q1'] }] },
  quotes: { data_mode: 'fictional', label: 'FICTIONAL DEMO DATA', limitations: ['Fetch time is not market freshness.'],
    errors: [], evidence: [{ id: 'q1', fictional: true, quote: {
      symbol: 'AAPL', currency: 'USD', price: 200, change_percent: 2.5,
      latest_trading_day: '2026-01-02', fetched_at: '2026-01-03T00:00:00Z', source: 'demo', data_kind: 'fictional',
    } }] },
})
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const signal = () => new AbortController().signal
function respond(body, status = 200) {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status })
}

test('submits only a trimmed question to the configured base; preserves evidence', async () => {
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(url, 'http://localhost:8000/prefix/api/research/agent')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.equal(options.credentials, 'omit')
    assert.deepEqual(JSON.parse(options.body), { question })
    return new Response(JSON.stringify(fixture()))
  }
  const result = await requestResearch('http://localhost:8000/prefix/', ` ${question} `, signal())
  assert.equal(calls, 1)
  assert.equal(result.quotes.evidence[0].quote.price, 200)
  assert.equal(result.quotes.evidence[0].fictional, true)
  assert.equal(result.explanation.findings[0].statement_origin, 'backend')
})

test('unavailable HTTP 200 retains evidence, errors and limitations', async () => {
  const data = fixture()
  data.explanation = { status: 'unavailable', code: 'model_quota', message: 'Quota exhausted.', findings: [] }
  data.quotes.errors = [{ symbol: 'MSFT', status: 502, message: 'Quote retrieval failed.' }]
  respond(data)
  const result = await requestResearch('http://localhost:8000', question, signal())
  assert.equal(result.explanation.status, 'unavailable')
  assert.equal(result.quotes.evidence.length, 1)
  assert.deepEqual(result.quotes.errors, data.quotes.errors)
  assert.deepEqual(result.quotes.limitations, data.quotes.limitations)
})

test('empty clarification and unsupported results are valid', async () => {
  for (const status of ['clarification', 'unsupported']) {
    const data = fixture()
    data.quotes = null
    data.explanation = { status, code: 'clarify_question', message: 'Ask about supported quotes.', findings: [] }
    data.tool_outcomes = []
    respond(data)
    assert.equal((await requestResearch('http://localhost:8000', question, signal())).quotes, null)
  }
})

test('429 and 503 retain safe structured outcomes; 422 does not echo server text', async () => {
  for (const [status, code] of [[429, 'research_busy'], [503, 'research_unavailable']]) {
    const data = fixture()
    data.quotes = null
    data.explanation = { status: 'unavailable', code, message: 'Research unavailable.', findings: [] }
    respond(data, status)
    assert.equal((await requestResearch('http://localhost:8000', question, signal())).explanation.code, code)
  }
  respond({ detail: 'SECRET' }, 422)
  await assert.rejects(requestResearch('http://localhost:8000', question, signal()), /question was rejected/)
})

test('network and invalid JSON failures are safe and never retried', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('SECRET') }
  await assert.rejects(requestResearch('http://localhost:8000', question, signal()), /Could not reach/)
  assert.equal(calls, 1)
  globalThis.fetch = async () => new Response('SECRET')
  await assert.rejects(requestResearch('http://localhost:8000', question, signal()), /invalid response/)
})

test('malformed consumed fields and wrong question fail closed', async () => {
  for (const mutate of [
    (d) => { d.quotes.evidence[0].quote.price = '200' },
    (d) => { d.quotes.evidence[0].quote.fetched_at = 'yesterday' },
    (d) => { d.explanation.status = 'unexpected' },
    (d) => { d.explanation.findings[0].statement_origin = 'model' },
    (d) => { d.explanation.findings[0].evidence_ids = ['invented'] },
    (d) => { d.quotes = null },
    (d) => { d.tool_outcomes[0].symbols = 'AAPL' },
  ]) {
    const data = fixture(); mutate(data)
    assert.throws(() => parseResearch(data), /invalid response/)
  }
  const wrong = fixture(); wrong.question = 'A different question'
  respond(wrong)
  await assert.rejects(requestResearch('http://localhost:8000', question, signal()), /invalid response/)
})

test('validation prevents requests and counts Unicode characters like the backend', async () => {
  globalThis.fetch = () => { throw new Error('Should not fetch') }
  assert.equal(validateQuestion(' x '), 'x')
  assert.equal(validateQuestion('😀'.repeat(1000)).length, 2000)
  for (const value of ['', '  ', 'x'.repeat(1001)]) {
    await assert.rejects(requestResearch('http://localhost:8000', value, signal()), /between 1 and 1,000/)
  }
  await assert.rejects(requestResearch('https://user:SECRET@example.com', question, signal()), /address/)
})

test('caller cancellation passes through to fetch without retry', async () => {
  const controller = new AbortController()
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.signal, controller.signal)
    controller.abort()
    throw new DOMException('Aborted', 'AbortError')
  }
  await assert.rejects(requestResearch('http://localhost:8000', question, controller.signal), { name: 'AbortError' })
})
