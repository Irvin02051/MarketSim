import { identityUrl } from './identity.ts'

// provider_timezone is bounded provider-reported text, not a verified timezone identifier.
export type SearchMatch = { symbol: string; name: string; instrument_type: 'Equity'; region: 'United States';
  currency: 'USD'; market_open: string; market_close: string; provider_timezone: string; match_score: string }
export type SearchResult = { query: string; selection_ref: string; matches: SearchMatch[]; source: 'alpha_vantage'; fetched_at: string; cache_hit: boolean }
export type SearchCode = 'invalid' | 'configuration' | 'unavailable' | 'quota' | 'timeout' | 'network' | 'malformed'
export const searchMessages: Record<SearchCode, string> = {
  invalid: 'Enter 1–80 characters without control characters.', configuration: 'Search configuration is unavailable.',
  unavailable: 'Stock search is unavailable. Try again later.', quota: 'The provider request budget or quota is exhausted. Try later.',
  timeout: 'Search timed out. You may explicitly retry.', network: 'Could not reach stock search. Check your connection and retry.',
  malformed: 'Search returned data that could not be verified. Try again later.',
}
export class SearchError extends Error {
  code: SearchCode
  constructor(code: SearchCode) { super(searchMessages[code]); this.code = code }
}
export function normalizeQuery(value: string): string {
  if (/\p{C}/u.test(value) || !value.trim() || [...value.trim()].length > 80) throw new SearchError('invalid')
  return value.trim()
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => k in v)
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && [...v].length <= 200 && v === v.trim() && !/\p{C}/u.test(v)
export function parseSearch(value: unknown, query: string): SearchResult {
  const fail = () => { throw new SearchError('malformed') }
  if (!object(value) || !exact(value, ['query', 'selection_ref', 'matches', 'source', 'fetched_at', 'cache_hit'])) return fail()
  if (typeof value.selection_ref !== 'string' || !/^[a-f0-9]{32}$/.test(value.selection_ref) || value.query !== query || value.source !== 'alpha_vantage' || typeof value.cache_hit !== 'boolean'
    || typeof value.fetched_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.fetched_at)
    || !Number.isFinite(Date.parse(value.fetched_at)) || !Array.isArray(value.matches) || value.matches.length > 20) return fail()
  const seen = new Set<string>()
  const matches = value.matches.map(row => {
    if (!object(row) || !exact(row, ['symbol','name','instrument_type','region','currency','market_open','market_close','provider_timezone','match_score'])
      || !Object.values(row).every(text)) return fail()
    const r = row as SearchMatch
    if (!/^[A-Za-z0-9][A-Za-z0-9.\-^/]{0,31}$/.test(r.symbol) || seen.has(r.symbol)
      || r.instrument_type !== 'Equity' || r.region !== 'United States' || r.currency !== 'USD'
      || ![r.market_open, r.market_close].every(v => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v))
      || !/^(?:0(?:\.\d{1,8})?|1(?:\.0{1,8})?)$/.test(r.match_score)) return fail()
    seen.add(r.symbol)
    return { ...r }
  })
  return { query, selection_ref: value.selection_ref, matches, source: 'alpha_vantage', fetched_at: value.fetched_at, cache_hit: value.cache_hit }
}
export async function requestSearch(base: unknown, input: string, signal: AbortSignal, timeoutMs = 12000): Promise<SearchResult> {
  const query = normalizeQuery(input)
  let url: URL
  try { url = new URL(identityUrl(base).replace(/\/api\/me$/, '/api/stocks/search')); url.searchParams.set('q', query) }
  catch { throw new SearchError('configuration') }
  const controller = new AbortController()
  let interrupt: (reason: unknown) => void = () => {}
  const interrupted = new Promise<never>((_, reject) => { interrupt = reject })
  const cancel = () => { controller.abort(); interrupt(new DOMException('Cancelled', 'AbortError')) }
  signal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => { controller.abort(); interrupt(new SearchError('timeout')) }, timeoutMs)
  const work = async () => {
    controller.signal.throwIfAborted()
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' })
    if (response.redirected || (response.status >= 300 && response.status < 400)) throw new SearchError('network')
    if (response.status === 429) throw new SearchError('quota')
    if (response.status === 504) throw new SearchError('timeout')
    if (response.status === 422) throw new SearchError('invalid')
    if (response.status !== 200) throw new SearchError('unavailable')
    let body: unknown
    try { body = await response.json() } catch { throw new SearchError('malformed') }
    controller.signal.throwIfAborted()
    return parseSearch(body, query)
  }
  try { if (signal.aborted) cancel(); return await Promise.race([interrupted, work()]) }
  catch (error) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    throw error instanceof SearchError ? error : new SearchError('network')
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
}
export type SearchState = { status: 'idle' | 'loading' } | { status: 'loaded'; result: SearchResult; selected: SearchMatch | null }
  | { status: 'error'; code: SearchCode }
export function createSearchController(run: (query: string, signal: AbortSignal) => Promise<SearchResult>, publish: (s: SearchState) => void) {
  let pending: AbortController | null = null
  let disposed = false
  let result: SearchResult | null = null
  return {
    async submit(input: string) {
      if (disposed || pending) return
      result = null
      const controller = new AbortController(); pending = controller
      publish({ status: 'loading' })
      try {
        const next = await run(normalizeQuery(input), controller.signal)
        if (!disposed && !controller.signal.aborted && pending === controller) {
          result = next; publish({ status: 'loaded', result: next, selected: null })
        }
      } catch (error) {
        if (!disposed && !controller.signal.aborted && pending === controller)
          publish({ status: 'error', code: error instanceof SearchError ? error.code : 'network' })
      } finally { if (pending === controller) pending = null }
    },
    select(symbol: string) {
      if (disposed || pending || !result) return
      const selected = result.matches.find(row => row.symbol === symbol)
      if (selected) publish({ status: 'loaded', result, selected })
    },
    cancel() { pending?.abort(); pending = null; result = null; if (!disposed) publish({ status: 'idle' }) },
    dispose() { disposed = true; pending?.abort(); pending = null; result = null },
  }
}
