import { identityUrl } from './identity.ts'
import { symbols } from './watchlist.ts'
import type { Symbol } from './watchlist.ts'

export type Quote = {
  symbol: Symbol; currency: 'USD'; price: number; change: number; change_percent: number;
  high: number; low: number; volume: number; latest_trading_day: string; fetched_at: string;
  source: 'demo' | 'alpha_vantage'; data_kind: 'fictional' | 'end_of_day'; cache_hit: boolean
}
export type QuoteCode = 'configuration' | 'invalid' | 'malformed' | 'network' | 'timeout' | 'rate_limit' | 'unavailable'
export const quoteMessages: Record<QuoteCode, string> = {
  configuration: 'Quotes are unavailable with the current configuration.',
  invalid: 'A quote is not available for this symbol.',
  malformed: 'The quote response could not be verified. Please try again later.',
  network: 'Could not reach the quote service. Check your connection and retry.',
  timeout: 'The quote request timed out. You can retry.',
  rate_limit: 'The quote request limit has been reached. Please retry later.',
  unavailable: 'The quote service is unavailable. Please retry later.',
}
export class QuoteError extends Error {
  code: QuoteCode
  constructor(code: QuoteCode) { super(quoteMessages[code]); this.code = code }
}
function validDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}
export function parseQuote(value: unknown, symbol: Symbol): Quote {
  if (!value || typeof value !== 'object') throw new QuoteError('malformed')
  const q = value as Record<string, unknown>
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  if (q.symbol !== symbol || !symbols.includes(symbol) || q.currency !== 'USD'
    || !finite(q.price) || !finite(q.change) || !finite(q.change_percent)
    || !finite(q.high) || !finite(q.low) || q.low <= 0 || q.low > q.price || q.price > q.high
    || !finite(q.volume) || !Number.isSafeInteger(q.volume) || q.volume < 0
    || typeof q.cache_hit !== 'boolean' || !validDay(q.latest_trading_day)
    || typeof q.fetched_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(q.fetched_at)
    || !validDay(q.fetched_at.slice(0, 10)) || !Number.isFinite(Date.parse(q.fetched_at))
    // Match backend's date comparison in the timestamp's own offset.
    || q.latest_trading_day > q.fetched_at.slice(0, 10)
    || !((q.source === 'demo' && q.data_kind === 'fictional')
      || (q.source === 'alpha_vantage' && q.data_kind === 'end_of_day'))) throw new QuoteError('malformed')
  return { symbol, currency: 'USD', price: q.price, change: q.change, change_percent: q.change_percent,
    high: q.high, low: q.low, volume: q.volume, cache_hit: q.cache_hit,
    latest_trading_day: q.latest_trading_day, fetched_at: q.fetched_at,
    source: q.source, data_kind: q.data_kind }
}
/** Percent is already in percentage units; never use Intl's percent multiplier. */
export function signedQuoteNumber(value: number): string {
  return `${value > 0 ? '+' : ''}${Object.is(value, -0) ? '0' : String(value)}`
}
export async function requestQuote(base: unknown, symbol: Symbol, signal: AbortSignal, timeoutMs = 12000): Promise<Quote> {
  if (!symbols.includes(symbol)) throw new QuoteError('invalid')
  let url: string
  try { url = identityUrl(base).replace(/\/api\/me$/, `/api/stocks/${symbol}/quote`) }
  catch { throw new QuoteError('configuration') }
  const controller = new AbortController()
  let interrupt: (error: unknown) => void = () => {}
  const interrupted = new Promise<never>((_, reject) => { interrupt = reject })
  const cancel = () => { controller.abort(); interrupt(new DOMException('Cancelled', 'AbortError')) }
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort(); interrupt(new QuoteError('timeout')) }, timeoutMs)
  signal.addEventListener('abort', cancel, { once: true })
  const work = async () => {
    controller.signal.throwIfAborted()
    const response = await fetch(url, { method: 'GET', signal: controller.signal,
      credentials: 'omit', cache: 'no-store', redirect: 'error' })
    controller.signal.throwIfAborted()
    if (response.redirected || (response.status >= 300 && response.status < 400)) throw new QuoteError('network')
    if (response.status === 429) throw new QuoteError('rate_limit')
    if (response.status === 504) throw new QuoteError('timeout')
    if (response.status === 400 || response.status === 404) throw new QuoteError('invalid')
    if (response.status !== 200) throw new QuoteError('unavailable')
    let body: unknown
    try { body = await response.json() } catch { throw new QuoteError('malformed') }
    controller.signal.throwIfAborted()
    return parseQuote(body, symbol)
  }
  try {
    if (signal.aborted) cancel()
    return await Promise.race([interrupted, work()])
  } catch (error) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    if (timedOut) throw new QuoteError('timeout')
    throw error instanceof QuoteError ? error : new QuoteError('network')
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
}
export type QuoteState = { status: 'loading' } | { status: 'loaded'; quote: Quote } | { status: 'error'; code: QuoteCode }
/** Per-mounted-item gate. Refresh clears prior values; disposal ignores all late results. */
export function createQuoteRequest(run: (signal: AbortSignal) => Promise<Quote>, publish: (state: QuoteState) => void) {
  let pending: AbortController | null = null
  let disposed = false
  return {
    async refresh() {
      if (disposed || pending) return
      const controller = new AbortController(); pending = controller
      publish({ status: 'loading' })
      try {
        const quote = await run(controller.signal)
        if (!disposed && !controller.signal.aborted) publish({ status: 'loaded', quote })
      } catch (error) {
        if (!disposed && !controller.signal.aborted) publish({ status: 'error', code: error instanceof QuoteError ? error.code : 'network' })
      } finally { if (pending === controller) pending = null }
    },
    dispose() { disposed = true; pending?.abort(); pending = null },
  }
}
