import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { DEMO_HISTORY_END, historyDates, historySymbol, parseHistory, requestHistory, utcDate, formatHistoryDate } from '../src/lib/history.ts'

const range = { start: '2025-12-29', end: '2025-12-31' }
const fixture = () => ({ symbol: 'AAPL', currency: 'USD', source: 'demo', data_kind: 'fictional',
  adjustment_basis: 'unknown', interval: 'daily', observation_calendar: 'synthetic_weekdays',
  label: 'FICTIONAL DEMO DATA', requested_range: { ...range }, returned_range: { ...range },
  fixture_range: { start: '2024-01-01', end: DEMO_HISTORY_END }, coverage: 'within_fixture', status: 'ok',
  fetched_at: '2026-01-01T12:00:00Z', limitations: ['Separate fictional fixtures.'],
  bars: [{ date: '2025-12-29', close: 200 }, { date: '2025-12-30', close: 201 }, { date: '2025-12-31', close: 202 }],
})
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const signal = () => new AbortController().signal
const respond = (body, status = 200) => { globalThis.fetch = async () => new Response(JSON.stringify(body), { status }) }

test('demo anchor matches the backend contract and ranges are inclusive calendar periods', () => {
  const backend = readFileSync(new URL('../../backend/app/historical_data.py', import.meta.url), 'utf8')
  assert.match(backend, /FIXTURE_END = date\(2025, 12, 31\)/)
  assert.equal(DEMO_HISTORY_END, '2025-12-31')
  for (const [name, start] of [['1W', '2025-12-25'], ['1M', '2025-12-01'], ['3M', '2025-10-01'], ['1Y', '2025-01-01']]) {
    assert.deepEqual(historyDates(name), { start, end: DEMO_HISTORY_END })
  }
  assert.equal(historyDates('1M', '2024-03-31').start, '2024-03-01')
  assert.equal(historyDates('1M', '2025-03-31').start, '2025-03-01')
  assert.equal(historyDates('1M', '2025-05-31').start, '2025-05-01')
  assert.equal(historyDates('3M', '2024-05-31').start, '2024-03-01')
  assert.equal(historyDates('1Y', '2024-02-29').start, '2023-03-01')
  assert.equal(historyDates('1W', '2025-01-03').start, '2024-12-28')
})

test('date-only parsing and formatting stay in UTC and reject normalized invalid dates', () => {
  assert.equal(utcDate('2024-02-29'), Date.UTC(2024, 1, 29))
  assert.equal(formatHistoryDate(utcDate('2025-12-31')), 'Dec 31, 2025')
  for (const day of ['2025-02-29', '2025-04-31', '2025-1-01', '20250101', '0000-01-01']) assert.throws(() => utcDate(day))
  assert.equal(historySymbol('aapl'), 'AAPL')
  for (const symbol of ['TSLA', ' AAPL', 'A1', undefined]) assert.equal(historySymbol(symbol), null)
})

test('valid, single-point, empty, and partial responses preserve metadata', () => {
  const valid = parseHistory(fixture())
  assert.equal(valid.bars.length, 3)
  assert.equal(valid.adjustment_basis, 'unknown')
  assert.deepEqual(valid.limitations, ['Separate fictional fixtures.'])
  const single = fixture(); single.bars = single.bars.slice(0, 1); single.returned_range.end = single.returned_range.start
  assert.equal(parseHistory(single).bars.length, 1)
  const empty = fixture(); empty.bars = []; empty.returned_range = null; empty.status = 'empty'
  assert.equal(parseHistory(empty).status, 'empty')
  const partial = fixture(); partial.requested_range.end = '2026-01-05'; partial.coverage = 'partial_overlap'
  assert.equal(parseHistory(partial).coverage, 'partial_overlap')
  empty.requested_range = { start: '2026-01-01', end: '2026-01-03' }; empty.coverage = 'outside_fixture'
  assert.equal(parseHistory(empty).coverage, 'outside_fixture')
})

test('malformed prices, dates, provenance, ordering, and metadata are rejected, never repaired', () => {
  const mutations = [
    ...[NaN, Infinity, -Infinity, 0, -1, true, '200'].map((value) => (d) => { d.bars[0].close = value }),
    ...['2025-02-29', '2025-12-28', '2025-12-32', '2024-01-01'].map((value) => (d) => { d.bars[0].date = value }),
    (d) => { d.bars[1].date = d.bars[0].date }, (d) => { d.bars.reverse() },
    (d) => { d.returned_range = null }, (d) => { d.status = 'empty' }, (d) => { d.coverage = 'partial_overlap' },
    (d) => { d.source = 'alpha_vantage' }, (d) => { d.data_kind = 'real' },
    (d) => { d.adjustment_basis = 'adjusted' }, (d) => { d.fetched_at = '2025-12-31' },
    (d) => { d.limitations = 'none' }, (d) => { d.fixture_range.end = '2026-12-31' },
  ]
  for (const mutate of mutations) { const data = fixture(); mutate(data); assert.throws(() => parseHistory(data), /invalid response/) }
})

test('request uses the configured base, inclusive dates, and no credentials; validates correlation', async () => {
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(url, 'http://localhost:8000/prefix/api/stocks/AAPL/history?start_date=2025-12-29&end_date=2025-12-31')
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit')
    assert.equal(options.cache, 'no-store')
    return new Response(JSON.stringify(fixture()))
  }
  assert.equal((await requestHistory('http://localhost:8000/prefix/', 'AAPL', range, signal())).symbol, 'AAPL')
  assert.equal(calls, 1)
  const wrong = fixture(); wrong.symbol = 'MSFT'; respond(wrong)
  await assert.rejects(requestHistory('http://localhost:8000', 'AAPL', range, signal()), /invalid response/)
  respond(fixture())
  await assert.rejects(requestHistory('http://localhost:8000', 'AAPL', { ...range, start: '2025-12-28' }, signal()), /invalid response/)
})

test('safe network, HTTP, malformed JSON, and configuration errors without retries', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('SECRET') }
  await assert.rejects(requestHistory('http://localhost:8000', 'AAPL', range, signal()), /Could not reach/)
  assert.equal(calls, 1)
  for (const status of [422, 500, 503]) {
    respond({ detail: 'SECRET' }, status)
    await assert.rejects(requestHistory('http://localhost:8000', 'AAPL', range, signal()), (error) => !error.message.includes('SECRET'))
  }
  globalThis.fetch = async () => new Response('SECRET')
  await assert.rejects(requestHistory('http://localhost:8000', 'AAPL', range, signal()), /invalid response/)
  await assert.rejects(requestHistory('https://user:SECRET@example.com', 'AAPL', range, signal()), /address/)
})

test('timeout and caller cancellation abort transport and never retry', async () => {
  let calls = 0
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    calls++
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
  await assert.rejects(requestHistory('http://localhost:8000', 'AAPL', range, signal(), 5), /timed out/)
  const controller = new AbortController()
  const pending = requestHistory('http://localhost:8000', 'AAPL', range, controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(calls, 2)
  await assert.rejects(requestHistory('http://localhost:8000', 'AAPL', range, controller.signal), { name: 'AbortError' })
  assert.equal(calls, 2)
})

test('obsolete response is rejected even if a transport ignores cancellation', async () => {
  const controller = new AbortController()
  globalThis.fetch = async () => { controller.abort(); return new Response(JSON.stringify(fixture())) }
  await assert.rejects(requestHistory('http://localhost:8000', 'AAPL', range, controller.signal), { name: 'AbortError' })
})
