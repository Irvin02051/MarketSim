"""Internal manual research loop. No endpoint, implicit configuration, or live setup."""

import asyncio
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Literal

from google.genai import types
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    computed_field,
    field_validator,
)

from app.gemini_client import GeminiClient
from app.historical_findings import (
    AgentReply,
    RenderedHistoricalFinding,
    render_historical_findings,
)
from app.historical_research import (
    HistoricalMetricEvidence,
    HistoricalResearchInput,
    HistoricalResearchResult,
    get_historical_metrics,
)
from app.market_data import MarketData, Quote, QuoteError
from app.research import QuotesInput, QuotesResult, get_quotes
from app.research_explanation import (
    Explanation,
    Finding,
    ModelFailure,
    ModelReply,
    RenderedFinding,
    allowed_findings,
    explanation,
    validate_reply,
)

MAX_MODEL_CALLS = 3
MAX_TOOL_CALLS = 2
DEADLINE = 30.0


class AgentInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, revalidate_instances='always')
    question: str = Field(min_length=1, max_length=1000)

    @field_validator('question', mode='before')
    @classmethod
    def trim_question(cls, value):
        return value.strip() if isinstance(value, str) else value


class ToolOutcome(BaseModel):
    tool: Literal['get_quotes', 'unknown']
    symbols: list[str] = Field(default_factory=list)
    code: Literal['ok', 'partial', 'unavailable', 'unknown_tool', 'invalid_tool_arguments',
                  'research_timeout']


class HistoricalToolOutcome(ToolOutcome):
    tool: Literal['get_historical_metrics'] = 'get_historical_metrics'
    start_date: date | None = None
    end_date: date | None = None


class AgentResult(BaseModel):
    question: str
    quotes: QuotesResult | None = None
    explanation: Explanation
    model_calls: int = 0
    tool_requests: int = 0
    tool_outcomes: list[ToolOutcome] = Field(default_factory=list)
    historical_evidence: list[HistoricalMetricEvidence] = Field(default_factory=list)
    historical_findings: list[RenderedHistoricalFinding] = Field(default_factory=list)
    historical_tool_outcomes: list[HistoricalToolOutcome] = Field(default_factory=list)

    @computed_field
    @property
    def status(self) -> Literal['answered', 'unsupported', 'clarification', 'unavailable']:
        # The existing frontend's explanation projection is quote-only.
        return 'answered' if self.historical_findings else self.explanation.status


def agent_outcome(code: str, status='unavailable') -> Explanation:
    messages = {
        'tool_budget_exhausted': 'The requested tool batch exceeds the remaining tool budget.',
        'model_budget_exhausted': 'The model-call budget was exhausted before a final answer.',
        'clarify_question': 'Specify Apple, Microsoft, or Nvidia and the metric. For history, '
                            'provide explicit start and end dates (YYYY-MM-DD); fictional '
                            'fixtures cover 2024-01-01 through 2025-12-31.',
        'unsupported_question': 'This request is outside supported quote and descriptive '
                                'historical-metric research.',
        'historical_answer_available': 'Historical research completed using fictional data. '
                                       'Findings and tool activity are available in the API response; '
                                       'this page currently displays quote results only.',
    }
    if code in messages:
        return Explanation(status=status, code=code, message=messages[code])
    return explanation(code, status)


class _RequestQuotes:
    """Memoize successful and failed outcomes. Never refresh evidence within a run."""

    def __init__(self, service: MarketData, ends_at: float):
        self.service = service
        self.ends_at = ends_at
        self.outcomes: dict[str, Quote | QuoteError] = {}
        self.symbols: list[str] = []
        self.replay = False

    def remaining(self) -> float:
        return max(0.0, self.ends_at - asyncio.get_running_loop().time())

    async def get_quote(self, symbol: str) -> Quote:
        if symbol not in self.outcomes:
            if self.replay:
                self.outcomes[symbol] = QuoteError(504, 'Quote collection interrupted.')
            else:
                remaining = self.remaining()
                if remaining <= 0:
                    raise asyncio.TimeoutError
                try:
                    quote = await asyncio.wait_for(self.service.get_quote(symbol), remaining)
                    if quote.symbol != symbol:
                        raise QuoteError(502, 'Quote symbol mismatch.')
                    self.outcomes[symbol] = quote
                except QuoteError as error:
                    # Keep no raw provider message in request-local outcomes.
                    self.outcomes[symbol] = QuoteError(error.status, 'Quote retrieval failed.')
        outcome = self.outcomes[symbol]
        if isinstance(outcome, QuoteError):
            raise outcome
        return outcome

    async def collect(self, symbols: list[str]) -> QuotesResult:
        self.symbols.extend(symbol for symbol in symbols if symbol not in self.symbols)
        # First-seen order + memoized failures keeps get_quotes' q1/q2/q3 IDs stable.
        return await get_quotes(self, QuotesInput(symbols=self.symbols))


@dataclass
class _State:
    result: AgentResult
    quotes: _RequestQuotes
    conversation: list[types.Content] = field(default_factory=list)
    call_ids: set[str] = field(default_factory=set)
    history: dict[tuple[str, date, date], HistoricalMetricEvidence] = field(default_factory=dict)


def candidates(quotes: QuotesResult | None) -> list[RenderedFinding]:
    if quotes is None or quotes.errors or len({e.quote.latest_trading_day for e in quotes.evidence}) > 1:
        return []
    result = []
    for intent in ('range', 'difference', 'ranking'):
        for item in allowed_findings(quotes, intent):
            if item not in result:
                result.append(item)
    return result


def final_explanation(reply: ModelReply, quotes: QuotesResult | None) -> Explanation:
    if reply.status != 'answered':
        if reply.findings:
            raise ModelFailure('invalid_model_output')
        return agent_outcome('unsupported_question' if reply.status == 'unsupported'
                             else 'clarify_question', reply.status)
    if quotes is None:
        raise ModelFailure('invalid_model_output')
    if quotes.errors:
        return agent_outcome('incomplete_evidence')
    if not quotes.evidence:
        raise ModelFailure('invalid_model_output')
    if len({e.quote.latest_trading_day for e in quotes.evidence}) > 1:
        return agent_outcome('different_dates')
    allowed = candidates(quotes)
    selected = []
    for finding in reply.findings:
        match = next((item for item in allowed if Finding.model_validate(
            item.model_dump(include=set(Finding.model_fields))) == finding), None)
        if match is None or match in selected:
            raise ModelFailure('invalid_model_output')
        selected.append(match)
    # Reuse exact relationship validation and backend rendering; accept a relevant
    # subset of the latest tool-returned candidates, never arbitrary model prose.
    return validate_reply(reply, selected)


def finish(content: types.Content, result: AgentResult):
    text = ''.join(part.text or '' for part in content.parts or [] if not part.thought)
    if len(text) > 16_000:
        raise ModelFailure('invalid_model_output')
    try:
        reply = AgentReply.model_validate_json(text)
    except ValidationError:
        raise ModelFailure('invalid_model_output') from None
    if len(reply.findings) + len(reply.historical_findings) > 4:
        raise ModelFailure('invalid_model_output')
    if reply.status != 'answered' and reply.historical_findings:
        raise ModelFailure('invalid_model_output')
    # Validate everything before publishing any final findings.
    historical = render_historical_findings(reply.historical_findings, result.historical_evidence)
    quote_reply = ModelReply(status=reply.status, findings=reply.findings)
    if historical and not reply.findings:
        legacy = agent_outcome('historical_answer_available', 'clarification')
    else:
        legacy = final_explanation(quote_reply, result.quotes)
        if historical and legacy.status != 'answered':
            raise ModelFailure('invalid_model_output')
    result.explanation, result.historical_findings = legacy, historical


def function_calls(content: types.Content) -> list[types.FunctionCall]:
    if content.role != 'model' or not content.parts:
        raise ModelFailure('invalid_model_output')
    calls = []
    for part in content.parts:
        if any(value is not None for value in part.model_dump(exclude={
            'text', 'thought', 'thought_signature', 'function_call',
        }).values()):
            raise ModelFailure('invalid_model_output')
        if part.function_call is not None:
            if part.thought or not part.function_call.name:
                raise ModelFailure('invalid_model_output')
            calls.append(part.function_call)
    return calls


class ResearchAgent:
    def __init__(self, model: GeminiClient | None, *, deadline: float = DEADLINE):
        if not 0 < deadline <= DEADLINE:
            raise ValueError('Agent deadline must be positive and at most 30 seconds.')
        self.model = model
        self.deadline = deadline

    async def run(self, service: MarketData, request: AgentInput | dict) -> AgentResult:
        request = AgentInput.model_validate(request)
        result = AgentResult(question=request.question, explanation=agent_outcome('research_unavailable'))
        if self.model is None:
            return result
        # This is a conservative scope guard, not an exact-question parser.
        # The model handles other ambiguity/unsupported stocks through its final status.
        if re.search(r'\b(momentum|forecast\w*|predict\w*|'
                     r'tomorrow|future|valuation|buy|sell)\b', request.question, re.IGNORECASE):
            result.explanation = agent_outcome('unsupported_question', 'unsupported')
            return result
        # Never reinterpret relative periods as old fixture dates. Other natural-
        # language ambiguities are handled by the model's clarification status.
        if re.search(r'\b(?:(?:last|this|previous|past)\s+(?:\d+\s+)?'
                     r'(?:days?|weeks?|months?|years?|quarters?)|yesterday|ytd)\b',
                     request.question, re.IGNORECASE):
            result.explanation = agent_outcome('clarify_question', 'clarification')
            return result
        state = _State(result, _RequestQuotes(service, asyncio.get_running_loop().time() + self.deadline))
        state.conversation.append(types.Content(role='user', parts=[
            types.Part.from_text(text=request.question),
        ]))
        try:
            await asyncio.wait_for(self._loop(state), state.quotes.remaining())
        except (asyncio.TimeoutError, TimeoutError):
            if state.quotes.symbols:
                state.quotes.replay = True
                result.quotes = await state.quotes.collect([])
            result.explanation = agent_outcome('research_timeout')
        except ModelFailure as error:
            result.explanation = agent_outcome(error.code)
        except Exception:  # noqa: BLE001 -- internal public result never contains raw failures.
            result.explanation = agent_outcome('research_failed')
        return result

    async def _loop(self, state: _State):
        result = state.result
        for _ in range(MAX_MODEL_CALLS):
            remaining = state.quotes.remaining()
            if remaining <= 0:
                raise asyncio.TimeoutError
            result.model_calls += 1
            content = await asyncio.wait_for(self.model.agent_turn(
                state.conversation, timeout=remaining,
                model_call=result.model_calls,
                final=result.model_calls == MAX_MODEL_CALLS or result.tool_requests == MAX_TOOL_CALLS,
            ), remaining)
            requested = sum(part.function_call is not None for part in content.parts or [])
            result.tool_requests += requested  # Even malformed or unknown requests consume budget.
            if requested and result.model_calls == MAX_MODEL_CALLS:
                raise ModelFailure('model_budget_exhausted')
            if result.tool_requests > MAX_TOOL_CALLS:
                raise ModelFailure('tool_budget_exhausted')
            calls = function_calls(content)
            # Keep the original SDK Content intact: IDs, thought signatures, and
            # part boundaries must survive the next generate_content request.
            state.conversation.append(content)
            if not calls:
                finish(content, result)
                return
            ids = [call.id for call in calls if call.id is not None]
            if len(ids) != len(set(ids)) or any(call_id in state.call_ids for call_id in ids):
                raise ModelFailure('invalid_model_output')
            state.call_ids.update(ids)
            responses = []
            for call in calls:  # Deliberately sequential, never gather tool calls.
                remaining = state.quotes.remaining()
                if remaining <= 0:
                    raise asyncio.TimeoutError
                payload = await asyncio.wait_for(self._tool(state, call), remaining)
                responses.append(types.Part(function_response=types.FunctionResponse(
                    id=call.id, name=call.name, response=payload,
                )))
            # GenerateContent's Content contract permits only user/model roles.
            state.conversation.append(types.Content(role='user', parts=responses))
        raise ModelFailure('model_budget_exhausted')

    async def _tool(self, state: _State, call: types.FunctionCall) -> dict:
        if call.name == 'get_historical_metrics':
            return await self._historical_tool(state, call)
        if call.name != 'get_quotes':
            state.result.tool_outcomes.append(ToolOutcome(tool='unknown', code='unknown_tool'))
            return {'error': {'code': 'unknown_tool',
                              'message': 'Only get_quotes and get_historical_metrics are allowed.'}}
        try:
            request = QuotesInput.model_validate(call.args)
        except ValidationError:
            state.result.tool_outcomes.append(ToolOutcome(tool='get_quotes', code='invalid_tool_arguments'))
            return {'error': {'code': 'invalid_tool_arguments',
                              'message': 'Use only symbols: 1–3 unique AAPL, MSFT, NVDA symbols.'}}
        outcome = ToolOutcome(tool='get_quotes', symbols=request.symbols, code='research_timeout')
        state.result.tool_outcomes.append(outcome)
        state.result.quotes = await state.quotes.collect(request.symbols)
        quotes = state.result.quotes
        outcome.code = 'unavailable' if not quotes.evidence else 'partial' if quotes.errors else 'ok'
        return {
            'result': quotes.model_dump(mode='json'),
            'candidate_findings': [item.model_dump(include=set(Finding.model_fields))
                                   for item in candidates(quotes)],
        }

    async def _historical_tool(self, state: _State, call: types.FunctionCall) -> dict:
        try:
            args = dict(call.args) if isinstance(call.args, dict) else {}
            for name in ('start_date', 'end_date'):
                value = args.get(name)
                if not isinstance(value, str) or re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value) is None:
                    raise ValueError('Explicit ISO date required.')
                args[name] = date.fromisoformat(value)
            request = HistoricalResearchInput.model_validate(args)
        except (ValueError, TypeError):
            state.result.historical_tool_outcomes.append(HistoricalToolOutcome(code='invalid_tool_arguments'))
            return {'error': {'code': 'invalid_tool_arguments', 'message':
                             'Use only symbols (1–3 unique AAPL, MSFT, NVDA), start_date and end_date '
                             '(YYYY-MM-DD), ordered and at most two calendar years.'}}
        outcome = HistoricalToolOutcome(symbols=request.symbols, start_date=request.start_date,
                                        end_date=request.end_date, code='research_timeout')
        state.result.historical_tool_outcomes.append(outcome)
        missing = [symbol for symbol in request.symbols
                   if (symbol, request.start_date, request.end_date) not in state.history]
        if missing:
            # The synchronous local calculation runs outside the event loop so
            # the existing total deadline/cancellation remains responsive. A
            # cancelled worker can finish locally, but never changes agent state.
            try:
                collected = await asyncio.to_thread(get_historical_metrics, HistoricalResearchInput(
                    symbols=missing, start_date=request.start_date, end_date=request.end_date,
                ))
            except Exception:
                outcome.code = 'unavailable'
                raise
            for item in collected.evidence:
                item = item.model_copy(update={'id': f'hm{len(state.history) + 1}'})
                state.history[(item.provenance.symbol, request.start_date, request.end_date)] = item
                state.result.historical_evidence.append(item)
        evidence = tuple(state.history[(symbol, request.start_date, request.end_date)]
                         for symbol in request.symbols)
        outcome.code = ('unavailable' if all(item.provenance.status == 'empty' for item in evidence)
                        else 'partial' if any(item.provenance.coverage != 'within_fixture'
                                              or item.provenance.status == 'empty' for item in evidence)
                        else 'ok')
        return {'result': HistoricalResearchResult(request=request, evidence=evidence).model_dump(mode='json')}
