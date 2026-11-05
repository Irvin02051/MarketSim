import { historySymbol, utcDate, validateProviderDates } from './history.ts'
import type { DateRange, ProviderHistoryResult } from './history.ts'

export type RawMetric = {
  status: 'available' | 'unavailable'; value: string | null; unit: 'USD' | 'percent'
  window: DateRange | null; observation_count: number; required_observations: number; reason: string | null
}
export type HistoryMetrics = Omit<ProviderHistoryResult, 'bars' | 'limitations'> & {
  origin: 'backend'; calculation_basis: 'raw_closing_prices'; observation_count: number
  calendar_completeness: 'not_verified'; corporate_actions_checked: false
  raw_price_change: RawMetric; raw_sma_20: RawMetric; raw_sma_50: RawMetric
  raw_return_sample_stddev_20: RawMetric; return_count: number
  source_limitations: string[]; calculation_limitations: string[]
}
export class HistoryMetricsError extends Error {}
const invalid = (): never => { throw new HistoryMetricsError('The metrics service returned an invalid response. Try loading metrics again.') }
const mismatch = (): never => { throw new HistoryMetricsError('The metrics snapshot differs from this chart. Reload history, then explicitly load metrics again.') }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function text(value: unknown): string { return typeof value === 'string' && value.trim() ? value : invalid() }
function range(value: unknown): DateRange {
  const d = object(value), start = text(d.start), end = text(d.end)
  if (utcDate(start) > utcDate(end)) return invalid()
  return { start, end }
}
const equalRange = (a: DateRange | null, b: DateRange | null) => a === null || b === null
  ? a === b : a.start === b.start && a.end === b.end
function strings(value: unknown): string[] {
  return Array.isArray(value) && value.length > 0 ? value.map(text) : invalid()
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100 ? value : invalid()
}
function timestamp(value: unknown): string {
  const s = text(value)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s)
    || !Number.isFinite(Date.parse(s)) || Number(s.slice(11, 13)) > 23
    || Number(s.slice(14, 16)) > 59 || Number(s.slice(17, 19)) > 59) return invalid()
  utcDate(s.slice(0, 10))
  return s
}
// This validates structure and windows, never recalculates prices or metrics.
export function parseHistoryMetrics(value: unknown): HistoryMetrics {
  try {
    const d = object(value)
    const symbol = historySymbol(typeof d.symbol === 'string' ? d.symbol : undefined)
    if (!symbol || symbol !== d.symbol || d.origin !== 'backend' || d.calculation_basis !== 'raw_closing_prices'
      || d.currency !== 'USD' || d.source !== 'alpha_vantage' || d.data_kind !== 'end_of_day'
      || d.adjustment_basis !== 'unadjusted' || d.interval !== 'daily' || d.coverage !== 'within_snapshot_bounds'
      || d.calendar_completeness !== 'not_verified' || d.corporate_actions_checked !== false
      || typeof d.cache_hit !== 'boolean' || ['bars', 'history', 'fixture_range', 'observation_calendar', 'label'].some((key) => key in d)) return invalid()
    const requested = validateProviderDates(range(d.requested_range)), available = range(d.available_range)
    const returned = d.returned_range === null ? null : range(d.returned_range)
    const total = count(d.observation_count)
    if (requested.start < available.start || requested.end > available.end
      || d.status !== (total ? 'ok' : 'empty') || Boolean(returned) !== Boolean(total)
      || (returned && (returned.start < requested.start || returned.end > requested.end
        || total > (utcDate(returned.end) - utcDate(returned.start)) / 86400000 + 1
        || (total === 1 && returned.start !== returned.end)))) return invalid()
    const fetched = timestamp(d.fetched_at)
    const timezone = d.provider_timezone
    if (timezone !== null) {
      if (typeof timezone !== 'string' || !timezone || timezone.length > 64) return invalid()
      new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    }
    function metric(value: unknown, required: number, unit: RawMetric['unit'], whole = false): RawMetric {
      const m = object(value), n = count(m.observation_count)
      if (m.required_observations !== required || m.unit !== unit) return invalid()
      if (total < required) {
        if (m.status !== 'unavailable' || m.value !== null || m.window !== null || n !== total) return invalid()
        return { status: 'unavailable', value: null, window: null, unit, observation_count: n,
          required_observations: required, reason: text(m.reason) }
      }
      const window = range(m.window), v = text(m.value)
      // Up to 634 integer digits are supported by the backend. Never use Number(v).
      if (m.status !== 'available' || m.reason !== null || n !== (whole ? total : required)
        || !/^-?(?:0|[1-9]\d{0,633})\.\d{6}$/.test(v) || v === '-0.000000'
        || (!whole && v.startsWith('-')) || !returned || window.end !== returned.end
        || window.start < returned.start || window.start > window.end
        || n > (utcDate(window.end) - utcDate(window.start)) / 86400000 + 1
        || ((whole || total === required) && !equalRange(window, returned))) return invalid()
      return { status: 'available', value: v, unit, window, observation_count: n,
        required_observations: required, reason: null }
    }
    const change = metric(d.raw_price_change, 2, 'percent', true)
    const sma20 = metric(d.raw_sma_20, 20, 'USD'), sma50 = metric(d.raw_sma_50, 50, 'USD')
    const variability = metric(d.raw_return_sample_stddev_20, 21, 'percent')
    if (d.return_count !== (total >= 21 ? 20 : 0)) return invalid()
    return { origin: 'backend', calculation_basis: 'raw_closing_prices', symbol, currency: 'USD',
      source: 'alpha_vantage', data_kind: 'end_of_day', adjustment_basis: 'unadjusted', interval: 'daily',
      requested_range: requested, available_range: available, returned_range: returned,
      fetched_at: fetched, cache_hit: d.cache_hit, provider_timezone: timezone as string | null,
      coverage: 'within_snapshot_bounds', status: total ? 'ok' : 'empty', observation_count: total,
      calendar_completeness: 'not_verified', corporate_actions_checked: false,
      raw_price_change: change, raw_sma_20: sma20, raw_sma_50: sma50, raw_return_sample_stddev_20: variability,
      return_count: d.return_count as number, source_limitations: strings(d.source_limitations),
      calculation_limitations: strings(d.calculation_limitations) }
  } catch { return invalid() }
}

export function matchHistoryMetrics(metrics: HistoryMetrics, history: ProviderHistoryResult): HistoryMetrics {
  for (const key of ['symbol', 'currency', 'source', 'data_kind', 'adjustment_basis', 'interval',
    'fetched_at', 'coverage', 'status', 'provider_timezone'] as const) {
    if (metrics[key] !== history[key]) return mismatch()
  }
  for (const key of ['requested_range', 'available_range', 'returned_range'] as const) {
    if (!equalRange(metrics[key], history[key])) return mismatch()
  }
  if (metrics.observation_count !== history.bars.length) return mismatch()
  for (const metric of [metrics.raw_price_change, metrics.raw_sma_20, metrics.raw_sma_50, metrics.raw_return_sample_stddev_20]) {
    if (metric.status === 'available' && (metric.window?.start !== history.bars[history.bars.length - metric.observation_count]?.date
      || metric.window?.end !== history.bars.at(-1)?.date)) return mismatch()
  }
  return metrics // cache_hit may differ after the history request warms the cache.
}

export async function requestHistoryMetrics(base: unknown, history: ProviderHistoryResult,
  signal: AbortSignal, timeoutMs = 10000): Promise<HistoryMetrics> {
  let url: URL
  try {
    if (typeof base !== 'string' || !base.trim()) throw new Error()
    url = new URL(base.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    if (historySymbol(history.symbol) !== history.symbol) throw new Error()
    validateProviderDates(history.requested_range)
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/stocks/${history.symbol}/history/provider/metrics`
    url.search = new URLSearchParams({ start_date: history.requested_range.start, end_date: history.requested_range.end }).toString()
  } catch { throw new HistoryMetricsError('The backend address or loaded history selection is invalid.') }
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  // Race bounds even response decoding or a transport that ignores abort.
  let onAbort: () => void = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException('Request cancelled', 'AbortError'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    controller.signal.throwIfAborted()
    const work = async () => {
      const response = await fetch(url.href, { method: 'GET', signal: controller.signal,
        credentials: 'omit', cache: 'no-store', redirect: 'error' })
      if (!response.ok) {
        const messages: Record<number, string> = {
          422: 'The metrics range is unavailable or invalid. Reload history, then load metrics again.',
          429: 'The provider request budget or quota is exhausted. Do not repeatedly retry.',
          502: 'The provider could not supply metrics. Try again later.',
          503: 'Provider metrics are disabled or unavailable. Check local backend configuration.',
          504: 'Provider metrics timed out. You can explicitly try again later.',
        }
        throw new HistoryMetricsError(messages[response.status] ?? 'Metrics are unavailable. Try again later.')
      }
      let body: unknown
      try { body = await response.json() } catch { return invalid() }
      controller.signal.throwIfAborted()
      return matchHistoryMetrics(parseHistoryMetrics(body), history)
    }
    return await Promise.race([work(), cancelled])
  } catch (error) {
    if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError')
    if (timedOut) throw new HistoryMetricsError('The metrics request timed out. You can explicitly try again later.')
    if (error instanceof HistoryMetricsError) throw error
    throw new HistoryMetricsError('Could not reach the metrics service. Check the backend connection.')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', onAbort)
  }
}

export type HistoryMetricsState = { kind: 'idle' } | { kind: 'loading' }
  | { kind: 'result'; result: HistoryMetrics } | { kind: 'error'; message: string }
// One controller per loaded chart generation. Construction never sends a request.
export function createHistoryMetricsController(history: ProviderHistoryResult,
  publish: (state: HistoryMetricsState) => void, retrieve = requestHistoryMetrics) {
  const snapshot = structuredClone(history)
  let pending: AbortController | null = null
  let generation = 0
  return {
    cancel() { generation++; pending?.abort(); pending = null },
    async load(base: unknown) {
      if (pending) return
      const current = ++generation, controller = new AbortController()
      pending = controller
      publish({ kind: 'loading' })
      try {
        const result = matchHistoryMetrics(await retrieve(base, snapshot, controller.signal), snapshot)
        if (current === generation) publish({ kind: 'result', result })
      } catch (error) {
        if (current === generation) publish({ kind: 'error', message: error instanceof HistoryMetricsError
          ? error.message : 'Metrics could not be loaded. Try again later.' })
      } finally { if (current === generation) pending = null }
    },
  }
}
