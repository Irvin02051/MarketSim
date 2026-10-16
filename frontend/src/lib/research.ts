// A validated UI projection of AgentResult. Calculations remain backend-owned;
// fields not displayed (including calculation internals) are not copied here.
export type Symbol = 'AAPL' | 'MSFT' | 'NVDA'
export type ResearchResult = {
  question: string
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

export function parseResearch(value: unknown): ResearchResult {
  const data = object(value)
  const exp = object(data.explanation)
  const explanation: ResearchResult['explanation'] = {
    status: oneOf(exp.status, ['answered', 'unavailable', 'unsupported', 'clarification']),
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
        const tradingDate = text(q.latest_trading_day)
        const fetchedAt = text(q.fetched_at)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDate) || !Number.isFinite(Date.parse(tradingDate))
          || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(fetchedAt)
          || !Number.isFinite(Date.parse(fetchedAt))) return invalid()
        const price = number(q.price)
        if (price <= 0) return invalid()
        return { id: text(evidence.id), fictional: evidence.fictional,
          quote: { symbol: symbol(q.symbol), currency: oneOf(q.currency, ['USD']), price,
            change_percent: number(q.change_percent), latest_trading_day: tradingDate, fetched_at: fetchedAt,
            source: oneOf(q.source, ['demo', 'alpha_vantage']), data_kind: oneOf(q.data_kind, ['fictional', 'end_of_day']) } }
      }),
    }
  }
  if (explanation.status === 'answered' && (!quotes?.evidence.length || !explanation.findings.length)) return invalid()
  if (explanation.status !== 'answered' && explanation.findings.length) return invalid()
  const ids = new Set(quotes?.evidence.map((item) => item.id))
  if (explanation.findings.some((finding) => !finding.evidence_ids.length
    || finding.evidence_ids.some((id) => !ids.has(id)))) return invalid()
  return { question: text(data.question), explanation, quotes,
    model_calls: count(data.model_calls), tool_requests: count(data.tool_requests),
    tool_outcomes: list(data.tool_outcomes, (item) => {
      const outcome = object(item)
      return { tool: oneOf(outcome.tool, ['get_quotes', 'unknown']), symbols: list(outcome.symbols, symbol),
        code: oneOf(outcome.code, ['ok', 'partial', 'unavailable', 'unknown_tool', 'invalid_tool_arguments', 'research_timeout']) }
    }) }
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
  if (response.status !== 200 && (result.explanation.status !== 'unavailable'
    || result.explanation.code !== (response.status === 429 ? 'research_busy' : 'research_unavailable'))) return invalid()
  return result
}
