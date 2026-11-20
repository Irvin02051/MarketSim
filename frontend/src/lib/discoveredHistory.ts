import { identityUrl } from './identity.ts'
import { HistoryError, ProviderHistoryError, parseDiscoveredHistory, utcDate, validateProviderDates } from './history.ts'
import type { DateRange, DiscoveredHistoryResult } from './history.ts'

export async function requestDiscoveredHistory(base: unknown, reference: string, symbol: string, range: DateRange,
  signal: AbortSignal, timeoutMs = 12000): Promise<DiscoveredHistoryResult> {
  validateProviderDates(range)
  const url = new URL(identityUrl(base).replace(/\/api\/me$/, '/api/stocks/discovered/history'))
  url.search = new URLSearchParams({ selection_ref: reference, symbol, start_date: range.start, end_date: range.end }).toString()
  const controller = new AbortController()
  let reject: (error: unknown) => void = () => {}
  const interrupted = new Promise<never>((_, no) => { reject = no })
  const cancel = () => { controller.abort(); reject(new DOMException('Cancelled', 'AbortError')) }
  signal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => { controller.abort(); reject(new HistoryError('History request timed out. Retry explicitly.')) }, timeoutMs)
  const work = async () => {
    controller.signal.throwIfAborted()
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' })
    if (response.redirected) throw new HistoryError('History redirect rejected.')
    if (response.status === 409) throw new HistoryError('Selection evidence expired or unavailable. Search again and select a result.')
    if (response.status === 429) throw new HistoryError('Provider budget or quota exhausted. Try later.')
    if (response.status === 503) throw new HistoryError('Provider history is disabled, busy or unavailable.')
    if (response.status === 504) throw new HistoryError('History provider timed out.')
    if (response.status === 422) {
      let available: DateRange | null = null
      try {
        const body = await response.json()
        if (body.available_range) {
          const { start, end } = body.available_range
          if (typeof start === 'string' && typeof end === 'string' && utcDate(start) <= utcDate(end)) available = { start, end }
        }
      } catch { /* Never display raw error text. */ }
      throw new ProviderHistoryError('Requested range is invalid or unavailable in the compact snapshot.', available)
    }
    if (response.status !== 200) throw new HistoryError('Provider could not supply verified history.')
    const result = parseDiscoveredHistory(await response.json(), symbol)
    controller.signal.throwIfAborted()
    if (result.requested_range.start !== range.start || result.requested_range.end !== range.end) throw new HistoryError('History range did not match the request.')
    return result
  }
  try { if (signal.aborted) cancel(); return await Promise.race([interrupted, work()]) }
  catch (error) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    throw error instanceof HistoryError ? error : new HistoryError('Could not load verified history. Retry explicitly.')
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
}
export type DiscoveredState = { kind: 'idle' | 'loading' } | { kind: 'result'; result: DiscoveredHistoryResult }
  | { kind: 'error'; message: string; available: DateRange | null }
export function createDiscoveredController(run: (range: DateRange, signal: AbortSignal) => Promise<DiscoveredHistoryResult>, publish: (state: DiscoveredState) => void) {
  let pending: AbortController | null = null
  let disposed = false
  return {
    async load(range: DateRange) {
      if (disposed || pending) return
      const controller = new AbortController(); pending = controller
      publish({ kind: 'loading' })
      try {
        const result = await run({ ...range }, controller.signal)
        if (!disposed && pending === controller && !controller.signal.aborted) publish({ kind: 'result', result })
      } catch (error) {
        if (!disposed && pending === controller && !controller.signal.aborted) publish({ kind: 'error',
          message: error instanceof HistoryError ? error.message : 'History unavailable. Try an explicit Load again.',
          available: error instanceof ProviderHistoryError ? error.available : null })
      } finally { if (pending === controller) pending = null }
    },
    cancel() { pending?.abort(); pending = null; if (!disposed) publish({ kind: 'idle' }) },
    dispose() { disposed = true; pending?.abort(); pending = null },
  }
}
