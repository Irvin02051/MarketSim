// A validated UI projection of AgentResult. Calculations remain backend-owned;
// fields not displayed (including calculation internals) are not copied here.
export type Symbol = 'AAPL' | 'MSFT' | 'NVDA'
export type ResearchStatus = 'answered' | 'unavailable' | 'unsupported' | 'clarification'
export type ResearchDates = { start: string; end: string }
export type HistoricalMetricKey = 'price_change' | 'sma_20' | 'sma_50' | 'adjacent_return_volatility_20'
export type HistoricalMetric = {
  unit: 'USD' | 'percent'; observation_count: number; required_observations: number
} & ({ status: 'available'; value: string; window: ResearchDates; reason: null }
  | { status: 'unavailable'; value: null; window: null; reason: string })
export type HistoricalEvidence = {
  id: string; origin: 'backend'
  provenance: {
    symbol: Symbol; currency: 'USD'; source: 'demo'; data_kind: 'fictional'; label: string
    adjustment_basis: 'unknown'; interval: 'daily'; observation_calendar: 'synthetic_weekdays'
    requested_range: ResearchDates; returned_range: ResearchDates | null; fixture_range: ResearchDates
    coverage: 'within_fixture' | 'partial_overlap' | 'outside_fixture'; status: 'ok' | 'empty'; fetched_at: string
  }
  price_change: HistoricalMetric; sma_20: HistoricalMetric; sma_50: HistoricalMetric
  adjacent_return_volatility_20: HistoricalMetric; volatility_return_count: number; limitations: string[]
}
export type HistoricalFinding = {
  metric: HistoricalMetricKey; evidence_ids: string[]; relation: 'reported' | 'higher' | 'lower' | 'equal'
  statement: string; statement_origin: 'backend'
}
type ToolCode = 'ok' | 'partial' | 'unavailable' | 'unknown_tool' | 'invalid_tool_arguments' | 'research_timeout'
export type ResearchResult = {
  question: string
  status: ResearchStatus
  historical_evidence: HistoricalEvidence[]
  historical_findings: HistoricalFinding[]
  historical_tool_outcomes: {
    tool: 'get_historical_metrics'; symbols: Symbol[]; code: ToolCode; start_date: string | null; end_date: string | null
  }[]
  explanation: {
    status: 'answered' | 'unavailable' | 'unsupported' | 'clarification'
    code: string
    message: string
    findings: { statement: string; statement_origin: 'backend'; evidence_ids: string[] }[]
  }
  quotes: null | {
    label: string
    data_mode: 'fictional' | 'provider_backed' | 'mixed' | 'unavailable'
    limitations: string[]
    errors: { symbol: string; status: number; message: string }[]
    evidence: {
      id: string
      fictional: boolean
      quote: {
        symbol: Symbol; price: number; currency: 'USD'; change_percent: number
        latest_trading_day: string; fetched_at: string
        source: 'demo' | 'alpha_vantage'; data_kind: 'fictional' | 'end_of_day'
      }
    }[]
  }
  model_calls: number
  tool_requests: number
  tool_outcomes: { tool: 'get_quotes' | 'unknown'; symbols: Symbol[]; code:
    'ok' | 'partial' | 'unavailable' | 'unknown_tool' | 'invalid_tool_arguments' | 'research_timeout' }[]
}

export class ResearchError extends Error {}
const invalid = (): never => { throw new ResearchError('The research service returned an invalid response. Please try again.') }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string') return invalid()
  return value
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) return invalid()
  return value.map(parse)
}
function oneOf<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== 'string' || !choices.includes(value)) return invalid()
  return value as T[number]
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalid()
  return value
}
function count(value: unknown): number {
  const n = number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : invalid()
}
const symbol = (value: unknown) => oneOf(value, ['AAPL', 'MSFT', 'NVDA'] as const)
const statuses = ['answered', 'unavailable', 'unsupported', 'clarification'] as const
const metricKeys = ['price_change', 'sma_20', 'sma_50', 'adjacent_return_volatility_20'] as const
const toolCodes = ['ok', 'partial', 'unavailable', 'unknown_tool', 'invalid_tool_arguments', 'research_timeout'] as const
function nonempty(value: unknown): string {
  const result = text(value)
  return result.trim() ? result : invalid()
}
function day(value: unknown): string {
  const result = text(value)
  const time = Date.parse(`${result}T00:00:00Z`)
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(result) || result.startsWith('0000')
    || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== result) return invalid()
  return result
}
function dates(value: unknown): ResearchDates {
  const data = object(value), start = day(data.start), end = day(data.end)
  return start <= end ? { start, end } : invalid()
}
function timestamp(value: unknown): string {
  const result = text(value)
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(result)
    || !Number.isFinite(Date.parse(result))) return invalid()
  day(result.slice(0, 10))
  return result
}
function evidenceId(value: unknown, prefix: 'q' | 'hm'): string {
  const id = text(value)
  return new RegExp(`^${prefix}[1-9][0-9]*$`).test(id) ? id : invalid()
}
function unique<T>(items: T[]): T[] {
  return new Set(items).size === items.length ? items : invalid()
}
function metric(value: unknown, unit: HistoricalMetric['unit'], required: number): HistoricalMetric {
  const data = object(value)
  if (data.unit !== unit || data.required_observations !== required) return invalid()
  const observation_count = count(data.observation_count)
  if (data.status === 'unavailable') {
    if (data.value !== null || data.window !== null || observation_count >= required) return invalid()
    return { status: 'unavailable', value: null, window: null, reason: nonempty(data.reason),
      unit, observation_count, required_observations: required }
  }
  if (data.status !== 'available' || data.reason !== null || observation_count < required) return invalid()
  const valueString = text(data.value)
  // Finite decimal syntax, including exponents; never convert financial values to Number.
  if (!/^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(valueString)) return invalid()
  return { status: 'available', value: valueString, window: dates(data.window), reason: null,
    unit, observation_count, required_observations: required }
}
function historicalEvidence(value: unknown): HistoricalEvidence {
  const data = object(value), p = object(data.provenance)
  const requested = dates(p.requested_range), fixture = dates(p.fixture_range)
  const returned = p.returned_range === null ? null : dates(p.returned_range)
  const status = oneOf(p.status, ['ok', 'empty'])
  if ((status === 'empty') !== (returned === null)
    || fixture.start !== '2024-01-01' || fixture.end !== '2025-12-31'
    || (returned && (returned.start < requested.start || returned.end > requested.end
      || returned.start < fixture.start || returned.end > fixture.end))) return invalid()
  const metrics = {
    price_change: metric(data.price_change, 'percent', 2), sma_20: metric(data.sma_20, 'USD', 20),
    sma_50: metric(data.sma_50, 'USD', 50), adjacent_return_volatility_20: metric(data.adjacent_return_volatility_20, 'percent', 21),
  }
  for (const key of metricKeys) {
    const item = metrics[key]
    if (status === 'empty' && item.observation_count !== 0) return invalid()
    if (item.status === 'available' && (!returned || item.window.start < returned.start
      || item.window.end > returned.end || (key !== 'price_change' && item.observation_count !== item.required_observations))) return invalid()
  }
  const volatility_return_count = count(data.volatility_return_count)
  if (volatility_return_count !== (metrics.adjacent_return_volatility_20.status === 'available' ? 20 : 0)) return invalid()
  return { id: evidenceId(data.id, 'hm'), origin: oneOf(data.origin, ['backend']), ...metrics,
    volatility_return_count, limitations: list(data.limitations, nonempty), provenance: {
      symbol: symbol(p.symbol), currency: oneOf(p.currency, ['USD']), source: oneOf(p.source, ['demo']),
      data_kind: oneOf(p.data_kind, ['fictional']), label: nonempty(p.label),
      adjustment_basis: oneOf(p.adjustment_basis, ['unknown']), interval: oneOf(p.interval, ['daily']),
      observation_calendar: oneOf(p.observation_calendar, ['synthetic_weekdays']),
      requested_range: requested, returned_range: returned, fixture_range: fixture,
      coverage: oneOf(p.coverage, ['within_fixture', 'partial_overlap', 'outside_fixture']),
      status, fetched_at: timestamp(p.fetched_at),
    } }
}

export function parseResearch(value: unknown): ResearchResult {
  const data = object(value)
  const exp = object(data.explanation)
  const explanation: ResearchResult['explanation'] = {
    status: oneOf(exp.status, statuses),
    code: text(exp.code), message: text(exp.message),
    findings: list(exp.findings, (item) => {
      const finding = object(item)
      return { statement: text(finding.statement), statement_origin: oneOf(finding.statement_origin, ['backend']),
        evidence_ids: list(finding.evidence_ids, text) }
    }),
  }
  let quotes: ResearchResult['quotes'] = null
  if (data.quotes !== null) {
    const bundle = object(data.quotes)
    quotes = {
      label: text(bundle.label),
      data_mode: oneOf(bundle.data_mode, ['fictional', 'provider_backed', 'mixed', 'unavailable']),
      limitations: list(bundle.limitations, text),
      errors: list(bundle.errors, (item) => {
        const error = object(item)
        return { symbol: text(error.symbol), status: count(error.status), message: text(error.message) }
      }),
      evidence: list(bundle.evidence, (item) => {
        const evidence = object(item)
        const q = object(evidence.quote)
        if (typeof evidence.fictional !== 'boolean') return invalid()
        const tradingDate = day(q.latest_trading_day)
        const fetchedAt = timestamp(q.fetched_at)
        const price = number(q.price)
        if (price <= 0) return invalid()
        return { id: evidenceId(evidence.id, 'q'), fictional: evidence.fictional,
          quote: { symbol: symbol(q.symbol), currency: oneOf(q.currency, ['USD']), price,
            change_percent: number(q.change_percent), latest_trading_day: tradingDate, fetched_at: fetchedAt,
            source: oneOf(q.source, ['demo', 'alpha_vantage']), data_kind: oneOf(q.data_kind, ['fictional', 'end_of_day']) } }
      }),
    }
  }
  if (explanation.status === 'answered' && (!quotes?.evidence.length || !explanation.findings.length)) return invalid()
  if (explanation.status !== 'answered' && explanation.findings.length) return invalid()
  const ids = new Set(quotes?.evidence.map((item) => item.id))
  if (ids.size !== (quotes?.evidence.length ?? 0)) return invalid()
  if (explanation.findings.some((finding) => !finding.evidence_ids.length
    || finding.evidence_ids.some((id) => !ids.has(id)))) return invalid()
  const historical_evidence = list(data.historical_evidence, historicalEvidence)
  unique(historical_evidence.map((item) => item.id))
  const historical_findings = list(data.historical_findings, (value): HistoricalFinding => {
    const finding = object(value)
    const metric = oneOf(finding.metric, metricKeys)
    const evidence_ids = unique(list(finding.evidence_ids, (id) => evidenceId(id, 'hm')))
    const relation = oneOf(finding.relation, ['reported', 'higher', 'lower', 'equal'])
    if (evidence_ids.length !== (relation === 'reported' ? 1 : 2)
      || evidence_ids.some((id) => historical_evidence.find((e) => e.id === id)?.[metric].status !== 'available')) return invalid()
    return { metric, evidence_ids, relation, statement: nonempty(finding.statement),
      statement_origin: oneOf(finding.statement_origin, ['backend']) }
  })
  const status = oneOf(data.status, statuses)
  if (status !== (historical_findings.length ? 'answered' : explanation.status)) return invalid()
  const historicalNotice = explanation.status === 'clarification' && explanation.code === 'historical_answer_available'
  if ((historicalNotice && !historical_findings.length)
    || (historical_findings.length && explanation.status !== 'answered' && !historicalNotice)
    || historical_findings.length + explanation.findings.length > 4) return invalid()
  const historical_tool_outcomes = list(data.historical_tool_outcomes, (value): ResearchResult['historical_tool_outcomes'][number] => {
    const outcome = object(value)
    const symbols = unique(list(outcome.symbols, symbol))
    const start_date = outcome.start_date === null ? null : day(outcome.start_date)
    const end_date = outcome.end_date === null ? null : day(outcome.end_date)
    const code = oneOf(outcome.code, toolCodes)
    if (symbols.length > 3 || ((start_date === null) !== (end_date === null))
      || (start_date !== null && (start_date > end_date! || !symbols.length))
      || (code === 'invalid_tool_arguments' ? symbols.length !== 0 || start_date !== null
        : start_date === null)) return invalid()
    return { tool: oneOf(outcome.tool, ['get_historical_metrics']), symbols, code, start_date, end_date }
  })
  return { question: text(data.question), status, explanation, quotes,
    historical_evidence, historical_findings, historical_tool_outcomes,
    model_calls: count(data.model_calls), tool_requests: count(data.tool_requests),
    tool_outcomes: list(data.tool_outcomes, (item) => {
      const outcome = object(item)
      return { tool: oneOf(outcome.tool, ['get_quotes', 'unknown']), symbols: list(outcome.symbols, symbol),
        code: oneOf(outcome.code, toolCodes) }
    }) }
}

export function researchOutcome(result: ResearchResult): { status: ResearchStatus; message: string; code: string } {
  if (result.status === 'answered' && result.historical_findings.length && result.explanation.code === 'historical_answer_available') {
    return { status: result.status, message: 'Historical findings validated against fictional evidence.', code: 'answered' }
  }
  return { status: result.status, message: result.explanation.message, code: result.explanation.code }
}

export function validateQuestion(value: string): string {
  const question = value.trim()
  if (!question || [...question].length > 1000) throw new ResearchError('Enter a question between 1 and 1,000 characters.')
  return question
}

// Base comes from the same VITE_API_BASE_URL used for health; no API keys.
export async function requestResearch(base: unknown, input: string, signal: AbortSignal): Promise<ResearchResult> {
  const question = validateQuestion(input)
  let url: URL
  try {
    if (typeof base !== 'string' || !base.trim()) throw new Error()
    url = new URL(base.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/research/agent`
  } catch { throw new ResearchError('The backend API address is missing or invalid.') }
  let response: Response
  try {
    response = await fetch(url.href, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }), credentials: 'omit', cache: 'no-store', signal })
  } catch (error) {
    if (signal.aborted) throw error
    throw new ResearchError('Could not reach the research service. Check the backend connection.')
  }
  if (response.status === 422) throw new ResearchError('The question was rejected. Use 1–1,000 characters and try again.')
  if (![200, 429, 503].includes(response.status)) throw new ResearchError('Research could not be completed. Please try again later.')
  let data: unknown
  try { data = await response.json() } catch (error) {
    if (signal.aborted) throw error
    return invalid()
  }
  const result = parseResearch(data)
  if (result.question !== question) return invalid()
  if (response.status !== 200 && (result.status !== 'unavailable' || result.explanation.status !== 'unavailable'
    || result.explanation.code !== (response.status === 429 ? 'research_busy' : 'research_unavailable'))) return invalid()
  return result
}
