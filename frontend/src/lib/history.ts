// These bounds match backend/app/historical_data.py; they are not today's dates.
export const DEMO_HISTORY_START = '2024-01-01'
export const DEMO_HISTORY_END = '2025-12-31'
export const HISTORY_SYMBOLS = ['AAPL', 'MSFT', 'NVDA'] as const
export const HISTORY_RANGES = ['1W', '1M', '3M', '1Y'] as const
export type HistorySymbol = typeof HISTORY_SYMBOLS[number]
export type HistoryRange = typeof HISTORY_RANGES[number]
export type DateRange = { start: string; end: string }
// Only fields consumed by the UI are projected; OHLC/volume stay backend-owned.
export type HistoryResult = {
  symbol: HistorySymbol; currency: 'USD'; source: 'demo'; data_kind: 'fictional'
  adjustment_basis: 'unknown'; observation_calendar: 'synthetic_weekdays'; interval: 'daily'
  label: string; requested_range: DateRange; returned_range: DateRange | null
  fixture_range: DateRange; coverage: 'within_fixture' | 'partial_overlap' | 'outside_fixture'
  status: 'ok' | 'empty'; fetched_at: string; limitations: string[]
  bars: { date: string; close: number }[]
}
export class HistoryError extends Error {}
const invalid = (): never => { throw new HistoryError('The history service returned an invalid response. Try again.') }
export function historySymbol(value: string | undefined): HistorySymbol | null {
  const upper = value?.toUpperCase()
  return HISTORY_SYMBOLS.find((symbol) => symbol === upper) ?? null
}
export function utcDate(value: string): number {
  const time = Date.parse(`${value}T00:00:00Z`)
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')
    || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) return invalid()
  return time
}
const iso = (date: Date) => date.toISOString().slice(0, 10)
export function historyDates(range: HistoryRange, anchor = DEMO_HISTORY_END): DateRange {
  const end = new Date(utcDate(anchor))
  const start = new Date(end)
  if (range === '1W') start.setUTCDate(start.getUTCDate() - 6)
  else {
    const months = { '1M': 1, '3M': 3, '1Y': 12 }[range]
    if (!months) return invalid()
    start.setUTCDate(1)
    start.setUTCMonth(start.getUTCMonth() - months)
    const last = new Date(start)
    last.setUTCMonth(last.getUTCMonth() + 1)
    last.setUTCDate(0)
    start.setUTCDate(Math.min(end.getUTCDate(), last.getUTCDate()) + 1)
  }
  return { start: iso(start), end: iso(end) }
}
export const formatHistoryDate = (time: number) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric',
}).format(time)
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : invalid()
}
function dates(value: unknown): DateRange {
  const data = object(value)
  const start = text(data.start), end = text(data.end)
  if (utcDate(start) > utcDate(end)) return invalid()
  return { start, end }
}
export function parseHistory(value: unknown): HistoryResult {
  const d = object(value)
  const symbol = historySymbol(typeof d.symbol === 'string' ? d.symbol : undefined)
  if (!symbol || symbol !== d.symbol || d.currency !== 'USD' || d.source !== 'demo'
    || d.data_kind !== 'fictional' || d.adjustment_basis !== 'unknown' || d.interval !== 'daily'
    || d.observation_calendar !== 'synthetic_weekdays') return invalid()
  const requested = dates(d.requested_range), fixture = dates(d.fixture_range)
  if (fixture.start !== DEMO_HISTORY_START || fixture.end !== DEMO_HISTORY_END) return invalid()
  const returned = d.returned_range === null ? null : dates(d.returned_range)
  const coverage = requested.end < fixture.start || requested.start > fixture.end ? 'outside_fixture'
    : requested.start >= fixture.start && requested.end <= fixture.end ? 'within_fixture' : 'partial_overlap'
  if (d.coverage !== coverage || !Array.isArray(d.bars) || !Array.isArray(d.limitations)) return invalid()
  let previous = ''
  const bars = d.bars.map((value) => {
    const bar = object(value), day = text(bar.date)
    const time = utcDate(day)
    if (day <= previous || day < requested.start || day > requested.end
      || day < fixture.start || day > fixture.end || [0, 6].includes(new Date(time).getUTCDay())
      || typeof bar.close !== 'number' || !Number.isFinite(bar.close) || bar.close <= 0) return invalid()
    previous = day
    return { date: day, close: bar.close }
  })
  const status = bars.length ? 'ok' : 'empty'
  if (d.status !== status || (bars.length
    ? returned?.start !== bars[0].date || returned?.end !== bars[bars.length - 1].date
    : returned !== null)) return invalid()
  const fetched = text(d.fetched_at)
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(fetched)
    || !Number.isFinite(Date.parse(fetched))) return invalid()
  return { symbol, currency: d.currency, source: d.source, data_kind: d.data_kind,
    adjustment_basis: d.adjustment_basis, interval: d.interval, observation_calendar: d.observation_calendar,
    label: text(d.label), requested_range: requested, returned_range: returned, fixture_range: fixture,
    coverage, status, fetched_at: fetched, limitations: d.limitations.map(text), bars }
}

export async function requestHistory(base: unknown, symbol: HistorySymbol, range: DateRange,
  signal: AbortSignal, timeoutMs = 10000): Promise<HistoryResult> {
  if (historySymbol(symbol) !== symbol) throw new HistoryError('Choose AAPL, MSFT, or NVDA.')
  dates(range)
  let url: URL
  try {
    if (typeof base !== 'string' || !base.trim()) throw new Error()
    url = new URL(base.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/stocks/${symbol}/history`
    url.search = new URLSearchParams({ start_date: range.start, end_date: range.end }).toString()
  } catch { throw new HistoryError('The backend API address is missing or invalid.') }
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  try {
    controller.signal.throwIfAborted()
    const response = await fetch(url.href, { method: 'GET', signal: controller.signal,
      credentials: 'omit', cache: 'no-store' })
    if (!response.ok) throw new HistoryError(response.status === 422
      ? 'The history request was rejected. Choose a supported stock and range.'
      : 'History is unavailable. Please try again later.')
    let value: unknown
    try { value = await response.json() } catch { return invalid() }
    controller.signal.throwIfAborted()
    const result = parseHistory(value)
    if (result.symbol !== symbol || result.requested_range.start !== range.start
      || result.requested_range.end !== range.end) return invalid()
    return result
  } catch (error) {
    if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError')
    if (timedOut) throw new HistoryError('History request timed out. Please try again.')
    if (error instanceof HistoryError) throw error
    throw new HistoryError('Could not reach the history service. Check the backend connection.')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
