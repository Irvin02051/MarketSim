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
  return fetchHistory(base, symbol, range, signal, timeoutMs, false) as Promise<HistoryResult>
}
async function fetchHistory(base: unknown, symbol: HistorySymbol, range: DateRange,
  signal: AbortSignal, timeoutMs: number, provider: boolean): Promise<ChartHistory> {
  if (historySymbol(symbol) !== symbol) throw new HistoryError('Choose AAPL, MSFT, or NVDA.')
  dates(range)
  let url: URL
  try {
    if (typeof base !== 'string' || !base.trim()) throw new Error()
    url = new URL(base.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/stocks/${symbol}/history${provider ? '/provider' : ''}`
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
      credentials: 'omit', cache: 'no-store', redirect: 'error' })
    if (provider && !response.ok) {
      let available: DateRange | null = null
      if (response.status === 422) {
        try {
          const error = object(await response.json())
          if (error.available_range !== undefined) available = dates(error.available_range)
        } catch { /* Never display provider/error text. */ }
      }
      controller.signal.throwIfAborted()
      const messages: Record<number, string> = {
        422: 'The provider range was rejected. Check the dates and available snapshot bounds.',
        429: 'The provider request budget or quota is exhausted. Do not repeatedly retry.',
        503: 'Provider history is disabled or unavailable. Check local backend configuration.',
        504: 'Provider history timed out. You can explicitly load again later.',
      }
      throw new ProviderHistoryError(messages[response.status] ?? 'Provider history is unavailable. Try again later.', available)
    }
    if (!response.ok) throw new HistoryError(response.status === 422
      ? 'The history request was rejected. Choose a supported stock and range.'
      : 'History is unavailable. Please try again later.')
    let value: unknown
    try { value = await response.json() } catch { return invalid() }
    controller.signal.throwIfAborted()
    const result = provider ? parseProviderHistory(value) : parseHistory(value)
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

export type ProviderHistoryResult = {
  symbol: HistorySymbol; currency: 'USD'; source: 'alpha_vantage'; data_kind: 'end_of_day'
  adjustment_basis: 'unadjusted'; interval: 'daily'; requested_range: DateRange
  available_range: DateRange; returned_range: DateRange | null
  coverage: 'within_snapshot_bounds'; status: 'ok' | 'empty'; fetched_at: string
  cache_hit: boolean; provider_timezone: string | null; limitations: string[]
  bars: { date: string; open: number; high: number; low: number; close: number; volume: number | null }[]
}
export type ChartHistory = HistoryResult | ProviderHistoryResult
export const providerHistoryEnabled = (value: unknown) => value === 'true'
export function initialProviderDates(now = new Date()): DateRange {
  const today = utcDate(iso(now))
  return { start: iso(new Date(today - 30 * 86400000)), end: iso(new Date(today - 86400000)) }
}
export function validateProviderDates(range: DateRange): DateRange {
  try {
    const checked = dates(range)
    if (utcDate(checked.end) - utcDate(checked.start) >= 90 * 86400000) throw new Error()
    return checked
  } catch { throw new HistoryError('Use valid YYYY-MM-DD dates in order, at most 90 calendar days inclusive.') }
}
export function parseProviderHistory(value: unknown): ProviderHistoryResult {
  const d = object(value)
  const symbol = historySymbol(typeof d.symbol === 'string' ? d.symbol : undefined)
  if (!symbol || symbol !== d.symbol || d.currency !== 'USD' || d.source !== 'alpha_vantage'
    || d.data_kind !== 'end_of_day' || d.adjustment_basis !== 'unadjusted' || d.interval !== 'daily'
    || d.coverage !== 'within_snapshot_bounds' || typeof d.cache_hit !== 'boolean'
    || 'fixture_range' in d || 'observation_calendar' in d || 'label' in d) return invalid()
  const requested = dates(d.requested_range), available = dates(d.available_range)
  if (utcDate(requested.end) - utcDate(requested.start) >= 90 * 86400000
    || requested.start < available.start || requested.end > available.end) return invalid()
  const returned = d.returned_range === null ? null : dates(d.returned_range)
  if (!Array.isArray(d.bars) || d.bars.length > 100 || !Array.isArray(d.limitations)
    || !d.limitations.length) return invalid()
  let previous = ''
  const bars = d.bars.map((value) => {
    const bar = object(value), day = text(bar.date)
    utcDate(day)
    if (day <= previous || day < requested.start || day > requested.end) return invalid()
    const price = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : invalid()
    const open = price(bar.open), high = price(bar.high), low = price(bar.low), close = price(bar.close)
    if (low > Math.min(open, close) || high < Math.max(open, close)
      || (bar.volume !== null && (typeof bar.volume !== 'number' || !Number.isSafeInteger(bar.volume) || bar.volume < 0))) return invalid()
    previous = day
    return { date: day, open, high, low, close, volume: bar.volume as number | null }
  })
  const status = bars.length ? 'ok' : 'empty'
  if (d.status !== status || (bars.length
    ? returned?.start !== bars[0].date || returned?.end !== bars[bars.length - 1].date
    : returned !== null)) return invalid()
  const fetched = text(d.fetched_at)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(fetched)
    || !Number.isFinite(Date.parse(fetched)) || Number(fetched.slice(11, 13)) > 23
    || Number(fetched.slice(14, 16)) > 59 || Number(fetched.slice(17, 19)) > 59) return invalid()
  utcDate(fetched.slice(0, 10))
  const timezone = d.provider_timezone
  if (timezone !== null) {
    if (typeof timezone !== 'string' || !timezone || timezone.length > 64) return invalid()
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }) } catch { return invalid() }
  }
  return { symbol, currency: 'USD', source: 'alpha_vantage', data_kind: 'end_of_day',
    adjustment_basis: 'unadjusted', interval: 'daily', requested_range: requested, available_range: available,
    returned_range: returned, coverage: 'within_snapshot_bounds', status, fetched_at: fetched,
    cache_hit: d.cache_hit, provider_timezone: timezone, limitations: d.limitations.map(text), bars }
}
export class ProviderHistoryError extends HistoryError {
  available: DateRange | null
  constructor(message: string, available: DateRange | null = null) { super(message); this.available = available }
}

export async function requestProviderHistory(base: unknown, symbol: HistorySymbol, range: DateRange,
  signal: AbortSignal, timeoutMs = 10000): Promise<ProviderHistoryResult> {
  validateProviderDates(range)
  return fetchHistory(base, symbol, range, signal, timeoutMs, true) as Promise<ProviderHistoryResult>
}

export type ProviderHistoryState = { kind: 'idle' } | { kind: 'loading' }
  | { kind: 'result'; result: ProviderHistoryResult }
  | { kind: 'error'; message: string; available: DateRange | null }
// Used by the form's submit/change/unmount handlers; construction never fetches.
export function createProviderHistoryController(enabled: boolean, publish: (state: ProviderHistoryState) => void,
  retrieve = requestProviderHistory) {
  let pending: AbortController | null = null
  let generation = 0
  return {
    cancel() { generation++; pending?.abort(); pending = null },
    async load(base: unknown, symbol: HistorySymbol, range: DateRange) {
      if (!enabled || pending) return
      const current = ++generation
      const controller = new AbortController()
      pending = controller
      publish({ kind: 'loading' })
      try {
        const result = await retrieve(base, symbol, { ...range }, controller.signal)
        if (current === generation) publish({ kind: 'result', result })
      } catch (error) {
        if (current === generation) publish({ kind: 'error', message: error instanceof HistoryError
          ? error.message : 'Provider history could not be loaded. Try an explicit Load again.',
        available: error instanceof ProviderHistoryError ? error.available : null })
      } finally { if (current === generation) pending = null }
    },
  }
}
