import { identityUrl } from './identity.ts'

export const symbols = ['AAPL', 'MSFT', 'NVDA'] as const
export type Symbol = typeof symbols[number]
export type Item = { symbol: Symbol; created_at: string }
export type Operation = { method: 'GET' } | { method: 'POST' | 'DELETE'; symbol: Symbol }
export type Code = 'authentication' | 'forbidden' | 'configuration' | 'unavailable' | 'network' | 'timeout' | 'malformed' | 'invalid' | 'duplicate'
export const messages: Record<Code, string> = {
  authentication: 'Your session was not accepted. Please log in again.',
  forbidden: 'Access to your watchlist was denied. Please try again later.',
  configuration: 'Personal watchlists are unavailable with the current configuration.',
  unavailable: 'The watchlist service is unavailable. Please try again later.',
  network: 'Could not reach your watchlist. Check your connection and refresh.',
  timeout: 'The watchlist request timed out.',
  malformed: 'Your watchlist could not be verified. Please refresh.',
  invalid: 'Choose AAPL, MSFT, or NVDA.',
  duplicate: 'This symbol is already saved. Refresh to see the current list.',
}
export class WatchlistError extends Error {
  code: Code
  uncertain: boolean
  constructor(code: Code, uncertain = false) {
    super(messages[code]); this.code = code; this.uncertain = uncertain
  }
}
type Session = { access_token: string; user: { id: string } }
export type SessionAccess = {
  getSession: () => Promise<{ data: { session: Session | null }; error: unknown }>
  onAuthStateChange: (callback: (event: string, session: Session | null) => void) => {
    data: { subscription: { unsubscribe: () => void } }
  }
}
function supported(value: unknown): value is Symbol {
  return typeof value === 'string' && symbols.some(symbol => symbol === value)
}
function item(value: unknown): Item {
  if (!value || typeof value !== 'object' || !('symbol' in value) || !supported(value.symbol)
    || !('created_at' in value) || typeof value.created_at !== 'string') throw new WatchlistError('malformed')
  const stamp = value.created_at
  // Require a real calendar date and explicit offset, not Date.parse's date repair.
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(stamp)
  if (!match || !Number.isFinite(Date.parse(stamp))
    || new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1]) throw new WatchlistError('malformed')
  return { symbol: value.symbol, created_at: stamp }
}
export function parseItems(value: unknown): Item[] {
  if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)
    || value.items.length > 3) throw new WatchlistError('malformed')
  const items = value.items.map(item)
  if (new Set(items.map(row => row.symbol)).size !== items.length) throw new WatchlistError('malformed')
  return items.sort((a, b) => a.symbol.localeCompare(b.symbol))
}

/** Twelve seconds total: session lookup, fetch and response reading; no retries. */
export async function requestWatchlist(base: unknown, auth: SessionAccess | null, userId: string,
  operation: Operation, signal: AbortSignal, timeoutMs = 12000): Promise<Item[]> {
  let url: string
  try { url = identityUrl(base).replace(/\/api\/me$/, '/api/watchlist') }
  catch { throw new WatchlistError('configuration') }
  if (!auth) throw new WatchlistError('configuration')
  if (operation.method !== 'GET' && !supported(operation.symbol)) throw new WatchlistError('invalid')
  if (operation.method === 'DELETE') url += `/${operation.symbol}`
  const controller = new AbortController()
  let sent = false
  let rejectAbort: (error: unknown) => void = () => {}
  const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject })
  const abort = () => { controller.abort(); rejectAbort(new DOMException('Cancelled', 'AbortError')) }
  const timer = setTimeout(() => {
    controller.abort(); rejectAbort(new WatchlistError('timeout', sent && operation.method !== 'GET'))
  }, timeoutMs)
  signal.addEventListener('abort', abort, { once: true })
  let unsubscribe: (() => void) | undefined
  try {
    if (signal.aborted) abort()
    const work = async () => {
      controller.signal.throwIfAborted()
      // Synchronous invalidation prevents a delayed getSession from sending an old token.
      unsubscribe = auth.onAuthStateChange((_event, session) => {
        if (!session || session.user.id !== userId) abort()
      }).data.subscription.unsubscribe
      const { data, error } = await auth.getSession()
      controller.signal.throwIfAborted()
      if (error) throw new WatchlistError('authentication')
      const session = data.session
      if (!session || session.user.id !== userId || !/^[A-Za-z0-9._~+/-]+=*$/.test(session.access_token)
        || session.access_token.length > 8185) throw new WatchlistError('authentication')
      const headers: Record<string, string> = { Authorization: `Bearer ${session.access_token}` }
      if (operation.method === 'POST') headers['Content-Type'] = 'application/json'
      sent = true
      const response = await fetch(url, { method: operation.method, headers, signal: controller.signal,
        credentials: 'omit', cache: 'no-store', redirect: 'error',
        ...(operation.method === 'POST' ? { body: JSON.stringify({ symbol: operation.symbol }) } : {}) })
      controller.signal.throwIfAborted()
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new WatchlistError('network')
      const codes: Record<number, Code> = { 401: 'authentication', 403: 'forbidden', 422: 'invalid', 503: 'unavailable' }
      if (operation.method === 'POST' && response.status === 409) throw new WatchlistError('duplicate')
      if (codes[response.status]) throw new WatchlistError(codes[response.status])
      const expected = operation.method === 'GET' ? 200 : operation.method === 'POST' ? 201 : 204
      if (response.status !== expected) throw new WatchlistError('unavailable')
      if (operation.method === 'DELETE') return [] // A 204 has no JSON body.
      let body: unknown
      try { body = await response.json() } catch { throw new WatchlistError('malformed') }
      controller.signal.throwIfAborted()
      if (operation.method === 'GET') return parseItems(body)
      const added = item(body)
      if (added.symbol !== operation.symbol) throw new WatchlistError('malformed')
      return [added]
    }
    return await Promise.race([interrupted, work()])
  } catch (error) {
    if (signal.aborted || (controller.signal.aborted && !(error instanceof WatchlistError))) {
      throw new DOMException('Cancelled', 'AbortError')
    }
    const safe = error instanceof WatchlistError ? error : new WatchlistError('network')
    if (sent && operation.method !== 'GET' && ['network', 'timeout', 'unavailable', 'malformed'].includes(safe.code)) safe.uncertain = true
    throw safe
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort); unsubscribe?.()
  }
}

export type WatchlistState = {
  items: Item[]; loaded: boolean; busy: 'GET' | 'POST' | 'DELETE' | null;
  code: Code | null; notice: string; needsRefresh: boolean
}
export const initialState: WatchlistState = { items: [], loaded: false, busy: null, code: null, notice: '', needsRefresh: false }
/** One component-owned queue gate; reads and writes cannot race. Disposal clears private data. */
export function createWatchlist(run: (op: Operation, signal: AbortSignal) => Promise<Item[]>,
  publish: (state: WatchlistState) => void) {
  let state = { ...initialState }
  let pending: AbortController | null = null
  let disposed = false
  const update = (next: Partial<WatchlistState>) => { state = { ...state, ...next }; publish(state) }
  return {
    async execute(op: Operation) {
      if (disposed || pending || (op.method !== 'GET' && (!state.loaded || state.needsRefresh))) return
      const controller = new AbortController(); pending = controller
      update({ busy: op.method, code: null, notice: state.needsRefresh ? state.notice : '' })
      try {
        const rows = await run(op, controller.signal)
        if (disposed || controller.signal.aborted) return
        const items = op.method === 'GET' ? rows : op.method === 'DELETE'
          ? state.items.filter(row => row.symbol !== op.symbol)
          : [...state.items.filter(row => row.symbol !== op.symbol), ...rows].sort((a, b) => a.symbol.localeCompare(b.symbol))
        update({ items, loaded: true, needsRefresh: false, notice: op.method === 'GET' ? 'Watchlist refreshed.'
          : op.method === 'POST' ? `${op.symbol} saved.` : `${op.symbol} removed.` })
      } catch (error) {
        if (disposed || controller.signal.aborted) return
        const safe = error instanceof WatchlistError ? error : new WatchlistError('network', op.method !== 'GET')
        update({ code: safe.code, needsRefresh: state.needsRefresh || safe.uncertain || safe.code === 'duplicate',
          ...(safe.code === 'authentication' ? { items: [], loaded: false } : {}),
          notice: safe.uncertain ? 'This change may have completed. Refresh your watchlist before trying another change.' : state.needsRefresh ? state.notice : '' })
      } finally {
        if (pending === controller) { pending = null; if (!disposed) update({ busy: null }) }
      }
    },
    dispose() { disposed = true; pending?.abort(); pending = null; update({ ...initialState }) },
  }
}
