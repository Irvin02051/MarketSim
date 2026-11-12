import { historySymbol, utcDate, validateProviderDates } from './history.ts'
import type { DateRange, HistorySymbol } from './history.ts'
import { parseHistoryMetrics } from './historyMetrics.ts'
import type { HistoryMetrics } from './historyMetrics.ts'

export const metricLabels = {
  raw_price_change: 'Raw closing-price change', raw_sma_20: 'Raw SMA20', raw_sma_50: 'Raw SMA50',
  raw_return_sample_stddev_20: 'Raw-return sample standard deviation (not annualized)',
} as const
export type MetricKey = keyof typeof metricLabels
export type Plan = { status: 'planned' | 'clarification' | 'unsupported'; reason: string;
  symbols: HistorySymbol[]; start_date: string | null; end_date: string | null;
  intents: { kind: 'report' | 'compare'; metric: MetricKey }[] }
export type RealResult = { plan: Plan | null; status: 'answered' | 'partial' | 'unavailable' | 'clarification' | 'unsupported';
  code: string; message: string; evidence: { id: string; metrics: HistoryMetrics }[];
  errors: { symbol: HistorySymbol; status: number; message: string; available_range: DateRange | null }[];
  findings: { evidence_ids: string[]; metric: MetricKey; relation: 'reported' | 'higher' | 'lower' | 'equal';
    statement: string; statement_origin: 'backend' }[];
  model_calls: number; history_retrievals: number; limitations: string[]; omitted: string[] }
export class RealResearchError extends Error {}
const invalid = (): never => { throw new RealResearchError('The real-research service returned an invalid response.') }
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : invalid()
const text = (v: unknown): string => typeof v === 'string' && v.trim() && v.length <= 16000 ? v : invalid()
function keys(d: Record<string, unknown>, names: string) {
  const allowed = names.split(' ')
  if (Object.keys(d).length !== allowed.length || Object.keys(d).some((k) => !allowed.includes(k))) invalid()
}
function list(v: unknown, max: number): unknown[] { return Array.isArray(v) && v.length <= max ? v : invalid() }
function strings(v: unknown, max = 20): string[] { return list(v, max).map(text) }
function unique(v: string[]) { if (new Set(v).size !== v.length) invalid() }
function symbol(v: unknown): HistorySymbol { const s = historySymbol(typeof v === 'string' ? v : undefined); return s && s === v ? s : invalid() }
function metric(v: unknown): MetricKey { return typeof v === 'string' && Object.hasOwn(metricLabels, v) ? v as MetricKey : invalid() }
function integer(v: unknown, max: number): number { return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : invalid() }
function range(v: unknown): DateRange {
  const d = obj(v); keys(d, 'start end'); const start = text(d.start), end = text(d.end)
  if (utcDate(start) > utcDate(end)) invalid()
  return { start, end }
}
export const realResearchEnabled = (value: unknown) => value === 'true'
export function validateRealQuestion(value: string): string {
  const q = value.trim(), lines = q.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (!q || [...q].length > 1000 || /[{}[\]]/.test(q)
    || lines.some((s) => /\b(?:date|open|high|low|close|volume|price)\s*[,;\t]/i.test(s)
      || /^\d{4}-\d{2}-\d{2}\s*[,;\t]\s*[-+]?\d/.test(s))) {
    throw new RealResearchError('Enter an instruction of 1–1000 characters, without personal information or pasted datasets.')
  }
  return q
}
function parsePlan(v: unknown, question: string): Plan | null {
  if (v === null) return null
  const d = obj(v); keys(d, 'status reason symbols start_date end_date intents')
  if (!['planned', 'clarification', 'unsupported'].includes(text(d.status))) return invalid()
  const symbols = list(d.symbols, 2).map(symbol); unique(symbols)
  const intents = list(d.intents, 2).map((v) => {
    const i = obj(v); keys(i, 'kind metric'); const m = metric(i.metric)
    if (i.kind !== 'report' && i.kind !== 'compare') return invalid()
    if (i.kind === 'compare' && (m !== 'raw_price_change' || symbols.length !== 2)) return invalid()
    return { kind: i.kind as 'report' | 'compare', metric: m }
  })
  unique(intents.map((i) => `${i.kind}:${i.metric}`))
  const reason = text(d.reason)
  if (d.status !== 'planned') {
    if (symbols.length || intents.length || d.start_date !== null || d.end_date !== null
      || !(d.status === 'clarification' ? ['explicit_dates_required', 'clarify_instruction'] : ['unsupported_request']).includes(reason)) return invalid()
    return { status: d.status as 'clarification' | 'unsupported', reason, symbols, intents, start_date: null, end_date: null }
  }
  const start = text(d.start_date), end = text(d.end_date)
  validateProviderDates({ start, end })
  const mentions = question.match(/(?<![0-9])\b[0-9]{4}-[0-9]{2}-[0-9]{2}\b(?![0-9])/g)
  if (reason !== 'ready' || !symbols.length || !intents.length || mentions?.length !== 2
    || mentions[0] !== start || mentions[1] !== end) return invalid()
  return { status: 'planned', reason, symbols, intents, start_date: start, end_date: end }
}
const codes = ['disabled', 'unconfigured', 'research_busy', 'explicit_dates_required', 'clarify_instruction',
  'unsupported_request', 'model_refusal', 'model_truncated', 'model_quota', 'model_unavailable',
  'invalid_model_output', 'research_timeout', 'answered', 'partial', 'unavailable']
export function parseRealResult(value: unknown, question: string, httpStatus = 200): RealResult {
  try {
    const d = obj(value)
    keys(d, 'plan status code message evidence errors findings model_calls history_retrievals limitations omitted')
    const plan = parsePlan(d.plan, question), code = text(d.code), message = text(d.message)
    const status = text(d.status)
    if (!codes.includes(code) || !['answered', 'partial', 'unavailable', 'clarification', 'unsupported'].includes(status)) return invalid()
    const model_calls = integer(d.model_calls, 1), history_retrievals = integer(d.history_retrievals, 2)
    const evidence = list(d.evidence, 2).map((v) => {
      const e = obj(v); keys(e, 'id metrics'); const m = parseHistoryMetrics(e.metrics), id = text(e.id)
      if (plan?.status !== 'planned' || id !== `rh${plan.symbols.indexOf(m.symbol) + 1}`
        || m.requested_range.start !== plan.start_date || m.requested_range.end !== plan.end_date) return invalid()
      return { id, metrics: m }
    })
    unique(evidence.map((e) => e.id)); unique(evidence.map((e) => e.metrics.symbol))
    const errors = list(d.errors, 2).map((v) => {
      const e = obj(v); keys(e, 'symbol status message available_range')
      const s = symbol(e.symbol), n = integer(e.status, 599)
      if (plan?.status !== 'planned' || !plan.symbols.includes(s) || ![422, 429, 502, 503, 504].includes(n)) return invalid()
      return { symbol: s, status: n, message: text(e.message), available_range: e.available_range === null ? null : range(e.available_range) }
    })
    unique([...evidence.map((e) => e.metrics.symbol), ...errors.map((e) => e.symbol)])
    if ((plan && model_calls !== 1) || (history_retrievals && (plan?.status !== 'planned' || model_calls !== 1))
      || history_retrievals < evidence.length + errors.length || history_retrievals > (plan?.symbols.length ?? 0)) return invalid()
    const findings = list(d.findings, 4).map((v) => {
      const f = obj(v); keys(f, 'evidence_ids metric relation statement statement_origin')
      const ids = strings(f.evidence_ids, 2); unique(ids)
      const m = metric(f.metric), relation = text(f.relation)
      const items = ids.map((id) => evidence.find((e) => e.id === id))
      if (!ids.length || items.some((e) => !e || e.metrics[m].status !== 'available') || f.statement_origin !== 'backend'
        || !['reported', 'higher', 'lower', 'equal'].includes(relation)
        || (relation === 'reported') !== (ids.length === 1)
        || !plan?.intents.some((i) => i.metric === m && i.kind === (ids.length === 1 ? 'report' : 'compare'))) return invalid()
      if (ids.length === 2) {
        const a = items[0]!.metrics, b = items[1]!.metrics
        if (m !== 'raw_price_change' || a.symbol !== plan.symbols[0] || b.symbol !== plan.symbols[1]
          || a[m].window?.start !== b[m].window?.start || a[m].window?.end !== b[m].window?.end
          || a[m].observation_count !== b[m].observation_count || a[m].unit !== b[m].unit) return invalid()
      }
      // Relationships and numerical prose are backend-owned; never recompute them in JS.
      return { evidence_ids: ids, metric: m, relation: relation as RealResult['findings'][number]['relation'],
        statement: text(f.statement), statement_origin: 'backend' as const }
    })
    unique(findings.map((f) => `${f.metric}:${f.evidence_ids.join(',')}`))
    const omitted = strings(d.omitted, 4), limitations = strings(d.limitations)
    if (!limitations.length) return invalid()
    if (httpStatus === 503 ? !['disabled', 'unconfigured'].includes(code)
      : httpStatus === 429 ? code !== 'research_busy'
        : httpStatus !== 200 || ['disabled', 'unconfigured', 'research_busy'].includes(code)) return invalid()
    if (['disabled', 'unconfigured', 'research_busy'].includes(code)
      && (plan || model_calls || history_retrievals || status !== 'unavailable' || findings.length || omitted.length)) return invalid()
    if (code === 'answered' || code === 'partial') {
      if (status !== code || !findings.length || plan?.status !== 'planned'
        || history_retrievals !== plan.symbols.length
        || (code === 'answered' ? errors.length || omitted.length : !errors.length && !omitted.length)) return invalid()
    } else if (findings.length) return invalid()
    if (code === 'unavailable' && (status !== 'unavailable' || plan?.status !== 'planned')) return invalid()
    if (['answered', 'partial', 'unavailable'].includes(code)
      && (history_retrievals !== plan?.symbols.length || evidence.length + errors.length !== history_retrievals)) return invalid()
    if ([...evidence.map((e) => e.metrics.symbol), ...errors.map((e) => e.symbol)]
      .some((s) => (plan?.symbols.indexOf(s) ?? -1) >= history_retrievals)) return invalid()
    if (['explicit_dates_required', 'clarify_instruction', 'unsupported_request'].includes(code)) {
      if (status !== (code === 'unsupported_request' ? 'unsupported' : 'clarification')
        || history_retrievals || (plan && (plan.reason !== code || plan.status !== status))) return invalid()
    } else if (code === 'research_timeout') {
      if (status !== (evidence.length ? 'partial' : 'unavailable') || model_calls !== 1) return invalid()
    } else if (code.startsWith('model_') || code === 'invalid_model_output') {
      if (status !== 'unavailable' || plan || history_retrievals || model_calls !== 1) return invalid()
    }
    return { plan, status: status as RealResult['status'], code, message, evidence, errors, findings,
      model_calls, history_retrievals, limitations, omitted }
  } catch { return invalid() }
}

export async function requestRealResearch(base: unknown, question: string, signal: AbortSignal, timeoutMs = 35000): Promise<RealResult> {
  const q = validateRealQuestion(question)
  let url: URL
  try {
    if (typeof base !== 'string' || !base.trim()) throw new Error()
    url = new URL(base.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/research/real`
  } catch { throw new RealResearchError('The backend address is missing or invalid.') }
  const controller = new AbortController(), abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  let timedOut = false, onAbort = () => {}
  const timer = setTimeout(() => { timedOut = true; abort() }, timeoutMs)
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException('Cancelled', 'AbortError'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    controller.signal.throwIfAborted()
    const work = async () => {
      const response = await fetch(url.href, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }), signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' })
      if (![200, 429, 503].includes(response.status)) throw new RealResearchError(response.status === 422
        ? 'The backend rejected the instruction. Check its length and content.' : 'Real research failed on the server. No automatic retry was made.')
      let body: unknown
      try { body = await response.json() } catch { return invalid() }
      controller.signal.throwIfAborted()
      return parseRealResult(body, q, response.status)
    }
    return await Promise.race([work(), cancelled])
  } catch (error) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    if (timedOut) throw new RealResearchError('The browser request timed out. Upstream work may still have completed; no automatic retry was made.')
    if (error instanceof RealResearchError) throw error
    throw new RealResearchError('Could not reach real research. Check the backend connection; no automatic retry was made.')
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort)
  }
}
export type RealState = { kind: 'idle' } | { kind: 'loading'; question: string }
  | { kind: 'error'; question: string; message: string } | { kind: 'result'; question: string; result: RealResult }
export function createRealResearchController(enabled: boolean, publish: (s: RealState) => void, retrieve = requestRealResearch) {
  let pending: AbortController | null = null, generation = 0
  return {
    cancel() { generation++; pending?.abort(); pending = null },
    async submit(base: unknown, draft: string) {
      if (!enabled || pending) return
      let question: string
      try { question = validateRealQuestion(draft) } catch (error) {
        publish({ kind: 'error', question: '', message: (error as RealResearchError).message }); return
      }
      const token = ++generation, controller = new AbortController(); pending = controller
      publish({ kind: 'loading', question })
      try {
        const result = await retrieve(base, question, controller.signal)
        if (token === generation) publish({ kind: 'result', question, result })
      } catch (error) {
        if (token === generation) publish({ kind: 'error', question, message: error instanceof RealResearchError ? error.message : 'Real research could not be completed.' })
      } finally { if (token === generation) pending = null }
    },
  }
}

export function resultHeading(result: RealResult) {
  if (result.code === 'research_timeout') return 'Research deadline expired'
  if (result.code === 'research_busy') return 'Research endpoint busy'
  return { answered: 'Backend findings', partial: 'Partial result', clarification: 'Clarification needed',
    unsupported: 'Request not supported', unavailable: 'Research unavailable' }[result.status]
}
