"""Internal manual research loop. No endpoint, implicit configuration, or live setup."""

import asyncio
import re
from dataclasses import dataclass, field
from typing import Literal

from google.genai import types
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from app.gemini_client import GeminiClient
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


class AgentResult(BaseModel):
    question: str
    quotes: QuotesResult | None = None
    explanation: Explanation
    model_calls: int = 0
    tool_requests: int = 0
    tool_outcomes: list[ToolOutcome] = Field(default_factory=list)


def agent_outcome(code: str, status='unavailable') -> Explanation:
    messages = {
        'tool_budget_exhausted': 'The requested tool batch exceeds the remaining tool budget.',
        'model_budget_exhausted': 'The model-call budget was exhausted before a final answer.',
        'clarify_question': 'Ask about reported quotes, daily ranges, or percentage changes '
                            'for Apple, Microsoft, or Nvidia.',
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


def candidates(quotes: QuotesResult | None) -> list[RenderedFinding]:
    if quotes is None or quotes.errors or len({e.quote.latest_trading_day for e in quotes.evidence}) > 1:
        return []
    result = []
    for intent in ('range', 'difference', 'ranking'):
        for item in allowed_findings(quotes, intent):
            if item not in result:
                result.append(item)
    return result


def final_explanation(content: types.Content, quotes: QuotesResult | None) -> Explanation:
    text = ''.join(part.text or '' for part in content.parts or [] if not part.thought)
    if len(text) > 16_000:
        raise ModelFailure('invalid_model_output')
    try:
        reply = ModelReply.model_validate_json(text)
    except ValidationError:
        raise ModelFailure('invalid_model_output') from None
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
        if re.search(r'\b(histor\w*|momentum|volatil\w*|forecast\w*|predict\w*|'
                     r'tomorrow|future|valuation|buy|sell)\b', request.question, re.IGNORECASE):
            result.explanation = agent_outcome('unsupported_question', 'unsupported')
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
                result.explanation = final_explanation(content, result.quotes)
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
        if call.name != 'get_quotes':
            state.result.tool_outcomes.append(ToolOutcome(tool='unknown', code='unknown_tool'))
            return {'error': {'code': 'unknown_tool', 'message': 'Only get_quotes is allowed.'}}
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
