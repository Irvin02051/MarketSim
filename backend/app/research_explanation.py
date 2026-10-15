"""Bounded explanation selection; all statements and quantities are backend-owned."""

import asyncio
from threading import Lock
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.market_data import MarketData, Quote, QuoteError
from app.research import QuotesInput, QuotesResult, get_quotes

if TYPE_CHECKING:
    from app.gemini_client import GeminiClient


class ResearchInput(QuotesInput):
    question: str = Field(min_length=1, max_length=1000)

    @field_validator('question', mode='before')
    @classmethod
    def trim_question(cls, value):
        return value.strip() if isinstance(value, str) else value


class Finding(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    kind: Literal['range', 'difference', 'ranking']
    evidence_ids: list[str] = Field(min_length=1, max_length=3)
    calculation_ref: str
    relation: Literal['reported', 'higher', 'lower', 'equal', 'descending']


class ModelReply(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    status: Literal['answered', 'unsupported', 'clarification']
    findings: list[Finding] = Field(max_length=4)


class RenderedFinding(Finding):
    statement: str
    statement_origin: Literal['backend'] = 'backend'


class Explanation(BaseModel):
    status: Literal['answered', 'unsupported', 'clarification', 'unavailable']
    code: str
    message: str
    findings: list[RenderedFinding] = Field(default_factory=list)


class ResearchResult(BaseModel):
    question: str
    quotes: QuotesResult | None = None
    explanation: Explanation


MESSAGES = {
    'research_unavailable': 'Research is disabled or not configured.',
    'research_busy': 'Another research request is active; try again later.',
    'incomplete_evidence': 'Explanation omitted because not all quotes succeeded.',
    'different_dates': 'Explanation omitted because trading dates differ.',
    'model_quota': 'Model quota is exhausted; try again after quota recovery.',
    'research_timeout': 'Research exceeded its execution deadline.',
    'model_refusal': 'The model declined to produce an explanation.',
    'model_truncated': 'The model response was incomplete.',
    'invalid_model_output': 'The model response failed evidence validation.',
    'model_unavailable': 'The model service is unavailable.',
    'research_failed': 'Research could not be completed.',
    'unsupported_question': 'This request is outside the supported quote comparisons.',
    'clarify_question': 'Use: Compare their reported percentage changes; '
                        'Show their reported daily ranges; or Rank their reported percentage changes.',
    'answered': 'Model-selected findings validated and rendered from backend evidence.',
}


def explanation(code: str, status='unavailable', findings=None) -> Explanation:
    return Explanation(status=status, code=code, message=MESSAGES[code], findings=findings or [])


class ModelFailure(Exception):
    """Only fixed public codes cross the SDK boundary."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class _QuoteSnapshot:
    """Retain completed outcomes if the total deadline interrupts collection.

    Replay uses get_quotes' existing evidence/calculation rules without fetching
    any symbol again. Missing outcomes become safe timeout errors.
    """

    def __init__(self, service: MarketData):
        self.service = service
        self.outcomes: dict[str, Quote | QuoteError] = {}
        self.replay = False

    async def get_quote(self, symbol: str) -> Quote:
        if not self.replay:
            try:
                self.outcomes[symbol] = await self.service.get_quote(symbol)
            except QuoteError as error:
                self.outcomes[symbol] = error
        outcome = self.outcomes.get(symbol, QuoteError(504, 'Quote retrieval interrupted.'))
        if isinstance(outcome, QuoteError):
            raise outcome
        return outcome


def question_intent(question: str) -> str | None:
    # Deliberately bounded phrasing: unknown requests require clarification, not
    # a model's unverified assurance that a historical/advisory question is answered.
    normalized = ' '.join(question.lower().rstrip('.?!').split())
    for intent, verb, subject in (
        ('difference', 'compare', 'percentage changes'),
        ('range', 'show', 'daily ranges'),
        ('ranking', 'rank', 'percentage changes'),
    ):
        if normalized in {f'{verb} {prefix}{subject}' for prefix in (
            'their reported ', 'the reported ', 'reported ',
        )}:
            return intent
    return None


def allowed_findings(quotes: QuotesResult, intent: str) -> list[RenderedFinding]:
    """Build an allowlist from calculations, including operand order and ties."""
    names = {item.id: item.quote.symbol for item in quotes.evidence}
    calculations = quotes.calculations
    result = []
    if intent == 'range':
        for index, item in enumerate(calculations.ranges):
            result.append(RenderedFinding(
                kind='range', evidence_ids=[item.evidence_id],
                calculation_ref=f'calculations.ranges.{index}', relation='reported',
                statement=f'{names[item.evidence_id]} reported high minus low: '
                          f'{item.value} {item.currency}.',
            ))
    elif intent == 'difference' and calculations.difference is not None:
        item = calculations.difference
        first, second = item.evidence_ids
        relation = 'higher' if item.value > 0 else 'lower' if item.value < 0 else 'equal'
        result.append(RenderedFinding(
            kind='difference', evidence_ids=list(item.evidence_ids),
            calculation_ref='calculations.difference', relation=relation,
            statement=f'{names[first]} minus {names[second]} reported change: '
                      f'{item.value} percentage points.',
        ))
    if intent == 'ranking' or (intent == 'difference' and len(quotes.evidence) == 3):
        groups = calculations.ranking or []
        if groups:
            statements = [
                f"Rank {group.rank}: {', '.join(names[eid] for eid in group.evidence_ids)} "
                f"({group.change_percent}%){' — tied' if group.tied else ''}"
                for group in groups
            ]
            result.append(RenderedFinding(
                kind='ranking', evidence_ids=[eid for group in groups for eid in group.evidence_ids],
                calculation_ref='calculations.ranking', relation='descending',
                statement='Reported percentage changes, descending: ' + '; '.join(statements) + '.',
            ))
    return result


def validate_reply(reply: ModelReply, allowed: list[RenderedFinding]) -> Explanation:
    if reply.status != 'answered':
        if reply.findings:
            raise ModelFailure('invalid_model_output')
        code = 'unsupported_question' if reply.status == 'unsupported' else 'clarify_question'
        return explanation(code, reply.status)
    # Exact structural equality checks the calculation, ordered operands, relation,
    # and ranking/ties. An existing but unrelated evidence ID is insufficient.
    expected = [Finding.model_validate(item.model_dump(include=set(Finding.model_fields)))
                for item in allowed]
    if not reply.findings or len(reply.findings) != len(expected):
        raise ModelFailure('invalid_model_output')
    remaining = expected.copy()
    rendered = []
    for item in reply.findings:
        if item not in remaining:
            raise ModelFailure('invalid_model_output')
        remaining.remove(item)
        rendered.append(allowed[expected.index(item)])
    return explanation('answered', 'answered', rendered)


class ResearchExplanation:
    def __init__(self, model: 'GeminiClient | None', *, deadline: float = 30.0):
        self.model = model
        self.deadline = deadline
        # Nonblocking acquisition also prevents queuing across event loops.
        self.active = Lock()

    async def run(self, service: MarketData, request: ResearchInput | dict) -> tuple[int, ResearchResult]:
        request = ResearchInput.model_validate(request)
        result = ResearchResult(question=request.question,
                                explanation=explanation('research_unavailable'))
        if self.model is None:
            return 503, result
        if not self.active.acquire(blocking=False):
            result.explanation = explanation('research_busy')
            return 429, result
        try:
            await asyncio.wait_for(self._run(service, request, result), timeout=self.deadline)
        except (asyncio.TimeoutError, TimeoutError):
            result.explanation = explanation('research_timeout')
        except ModelFailure as error:
            result.explanation = explanation(error.code)
        except Exception:  # noqa: BLE001 -- public boundary; no raw provider exception output.
            # Never serialize SDK/provider exception text or unvalidated output.
            result.explanation = explanation('research_failed')
        finally:
            self.active.release()
        return 200, result

    async def _run(self, service: MarketData, request: ResearchInput, result: ResearchResult):
        intent = question_intent(request.question)
        if intent is None:
            result.explanation = explanation('clarify_question', 'clarification')
            return
        snapshot = _QuoteSnapshot(service)
        quote_request = QuotesInput(symbols=request.symbols)
        try:
            result.quotes = await get_quotes(snapshot, quote_request)
        except asyncio.CancelledError:
            # No network awaits during replay: preserve already fetched evidence
            # before wait_for reports its deadline (or the caller disconnects).
            snapshot.replay = True
            result.quotes = await get_quotes(snapshot, quote_request)
            raise
        quotes = result.quotes
        if quotes.errors or not quotes.evidence:
            result.explanation = explanation('incomplete_evidence')
            return
        if len({item.quote.latest_trading_day for item in quotes.evidence}) > 1:
            result.explanation = explanation('different_dates')
            return
        allowed = allowed_findings(quotes, intent)
        if not allowed:
            result.explanation = explanation('unsupported_question', 'unsupported')
            return
        reply = await self.model.generate(request.question, quotes, allowed)
        result.explanation = validate_reply(reply, allowed)
