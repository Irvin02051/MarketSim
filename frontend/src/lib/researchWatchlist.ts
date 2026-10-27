import type { ResearchResult } from './research.ts'
import { symbols, WatchlistError } from './watchlist.ts'
import type { Code, Symbol } from './watchlist.ts'

/** Only validated evidence fields; no findings, prose, errors or tool arguments. */
export function eligibleSymbols(result: ResearchResult): Symbol[] {
  const found = new Set([
    ...(result.quotes?.evidence.map(e => e.quote.symbol) ?? []),
    ...result.historical_evidence.map(e => e.provenance.symbol),
  ])
  return symbols.filter(symbol => found.has(symbol))
}
/** Parent-owned generation and invalidation, never sent to the backend. */
export function createResearchScope() {
  let generation = 0
  let invalidate: (() => void) | null = null
  return {
    next() { generation++; invalidate?.(); invalidate = null; return generation },
    isCurrent(value: number) { return generation === value },
    register(value: number, stop: () => void) {
      if (generation !== value) stop()
      else invalidate = stop
      return () => { if (invalidate === stop) invalidate = null }
    },
    dispose() { generation++; invalidate?.(); invalidate = null },
  }
}
export type ResearchScope = ReturnType<typeof createResearchScope>
export type Binding = { generation: number; account: string; result: ResearchResult }
export type SaveState = {
  symbol: Symbol; phase: 'idle' | 'review' | 'saving' | 'saved' | 'duplicate' | 'error' | 'uncertain' | 'invalidated';
  code: Code | null
}
export function createResearchSave(binding: Binding, isCurrent: () => boolean,
  write: (symbol: Symbol, signal: AbortSignal) => Promise<unknown>, publish: (state: SaveState) => void) {
  const eligible = eligibleSymbols(binding.result)
  let state: SaveState = { symbol: eligible[0] ?? 'AAPL', phase: 'idle', code: null }
  let confirmation: (Binding & { symbol: Symbol }) | null = null
  let pending: AbortController | null = null
  let disposed = false
  const uncertain = new Set<Symbol>()
  const update = (next: Partial<SaveState>) => { state = { ...state, ...next }; publish(state) }
  const valid = () => !disposed && isCurrent()
  publish(state)
  return {
    select(symbol: Symbol) {
      if (!valid() || pending || !eligible.includes(symbol)) return
      confirmation = null
      update({ symbol, phase: uncertain.has(symbol) ? 'uncertain' : 'idle', code: null })
    },
    review() {
      if (!valid() || pending || uncertain.has(state.symbol) || !eligible.includes(state.symbol)) return false
      confirmation = { ...binding, symbol: state.symbol }
      update({ phase: 'review', code: null }); return true
    },
    cancel() {
      if (!valid() || pending || state.phase !== 'review') return false
      confirmation = null; update({ phase: 'idle', code: null }); return true
    },
    async confirm() {
      const confirmed = confirmation
      if (!valid() || pending || state.phase !== 'review' || !confirmed
        || confirmed.generation !== binding.generation || confirmed.account !== binding.account
        || confirmed.result !== binding.result || confirmed.symbol !== state.symbol
        || !eligible.includes(confirmed.symbol) || uncertain.has(confirmed.symbol)) return
      const controller = new AbortController(); pending = controller; confirmation = null
      update({ phase: 'saving', code: null })
      try {
        // Recheck after publishing state, immediately before session acquisition/write.
        if (!valid()) return
        await write(confirmed.symbol, controller.signal)
        if (valid() && !controller.signal.aborted) update({ phase: 'saved' })
      } catch (error) {
        if (!valid() || controller.signal.aborted) return
        const safe = error instanceof WatchlistError ? error : new WatchlistError('network', true)
        if (safe.uncertain) uncertain.add(confirmed.symbol)
        update({ phase: safe.uncertain ? 'uncertain' : safe.code === 'duplicate' ? 'duplicate' : 'error', code: safe.code })
      } finally { if (pending === controller) pending = null }
    },
    dispose() {
      disposed = true; confirmation = null; pending?.abort(); pending = null
      update({ phase: 'invalidated', code: null })
    },
  }
}
