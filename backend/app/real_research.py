"""Opt-in planning then backend execution; provider evidence never returns to a model."""

import asyncio
from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import ValidationError

from app.gemini_client import GeminiClient
from app.historical_data import DateRange, HistoryModel
from app.real_history import (
    HistoricalService,
    HistoryError,
    HistoryRequest,
    RealHistoryResult,
)
from app.real_history_metrics import RealHistoryMetrics, calculate_real_history_metrics
from app.real_research_plan import (
    RawMetricKey,
    RealResearchInput,
    RealResearchPlan,
    Symbol,
    instruction_dates,
    validate_plan,
)
from app.research_explanation import ModelFailure

MESSAGES = {
    'disabled': 'Real research planning is disabled.',
    'unconfigured': 'Real research dependencies are unavailable or not configured for real history.',
    'invalid_instruction': 'Supply a research instruction of 1–1000 characters, without pasted datasets or extra fields.',
    'explicit_dates_required': 'Provide exactly two explicit YYYY-MM-DD dates in start/end order.',
    'clarify_instruction': 'Clarify the supported stocks and raw descriptive metric requested.',
    'unsupported_request': 'Only supported raw descriptive reports and raw price-change comparisons are available.',
    'model_refusal': 'The planner declined this request.',
    'model_truncated': 'The planner did not return a complete plan.',
    'model_quota': 'The planner quota is unavailable; no automatic retry was made.',
    'model_unavailable': 'The planner is unavailable.',
    'invalid_model_output': 'The planner returned an invalid plan; no history was retrieved.',
    'research_timeout': 'The research deadline expired; retained evidence may be incomplete.',
    'research_failed': 'Research execution failed; retained evidence may be incomplete.',
    'answered': 'Requested raw descriptions were calculated and rendered by the backend.',
    'partial': 'Some requested descriptions are unavailable; successful evidence is retained.',
    'unavailable': 'No requested finding is available; inspect evidence availability and safe errors.',
}
PROVIDER_MESSAGES = {
    422: 'Requested history range is unavailable.', 429: 'Provider budget or quota exhausted.',
    502: 'Provider could not supply valid history.', 503: 'History service is unavailable.',
    504: 'History request timed out.',
}


class RealEvidence(HistoryModel):
    id: str
    metrics: RealHistoryMetrics


class RealResearchError(HistoryModel):
    symbol: Symbol
    status: int
    message: str
    available_range: DateRange | None = None


class RealFinding(HistoryModel):
    evidence_ids: tuple[str, ...]
    metric: RawMetricKey
    relation: Literal['reported', 'higher', 'lower', 'equal']
    statement: str
    statement_origin: Literal['backend'] = 'backend'


class RealResearchResult(HistoryModel):
    plan: RealResearchPlan | None = None
    status: Literal['answered', 'partial', 'unavailable', 'clarification', 'unsupported'] = 'unavailable'
    code: str
    message: str
    evidence: tuple[RealEvidence, ...] = ()
    errors: tuple[RealResearchError, ...] = ()
    findings: tuple[RealFinding, ...] = ()
    model_calls: int = 0
    history_retrievals: int = 0
    limitations: tuple[str, ...] = (
        'Gemini planned the instruction before retrieval; it did not inspect or explain provider results.',
        'Raw descriptions are not predictions, trading signals, total return or shareholder performance.',
        'Corporate actions and exchange-calendar completeness remain unchecked.',
        'Raw-return variability is not annualized or a reliable investment-risk measure.',
    )
    omitted: tuple[str, ...] = ()


def render_findings(plan: RealResearchPlan, evidence: list[RealEvidence]) -> tuple[list[RealFinding], list[str]]:
    """Render only authoritative serialized values. No model-written relation/prose."""
    by_symbol = {item.metrics.symbol: item for item in evidence}
    findings, omitted = [], []
    labels = {'raw_price_change': 'raw closing-price change', 'raw_sma_20': 'raw SMA20',
              'raw_sma_50': 'raw SMA50', 'raw_return_sample_stddev_20': 'raw-return sample standard deviation'}
    for intent in plan.intents:
        groups = [[symbol] for symbol in plan.symbols] if intent.kind == 'report' else [plan.symbols]
        for symbols in groups:
            items = [by_symbol[symbol] for symbol in symbols if symbol in by_symbol]
            if len(items) != len(symbols):
                omitted.append(f'{intent.kind} {intent.metric}: requested evidence unavailable.')
                continue
            metrics = [getattr(item.metrics, intent.metric) for item in items]
            if any(item.status != 'available' or item.value is None or item.window is None for item in metrics):
                omitted.append(f'{intent.kind} {intent.metric}: insufficient observations.')
                continue
            first = metrics[0]
            if len(items) == 2:
                fields = ('source', 'data_kind', 'currency', 'interval', 'adjustment_basis')
                second = metrics[1]
                if (first.window != second.window or first.unit != second.unit
                        or first.observation_count != second.observation_count
                        or first.required_observations != second.required_observations
                        or any(getattr(items[0].metrics, field) != getattr(items[1].metrics, field) for field in fields)):
                    omitted.append(f'compare {intent.metric}: incompatible actual windows, counts, units or provenance.')
                    continue
            values = [metric.model_dump(mode='json')['value'] for metric in metrics]
            relation = 'reported'
            if len(items) == 1:
                statement = f'{symbols[0]}: {values[0]} {first.unit}.'
            else:
                a, b = (Decimal(value) for value in values)
                relation = 'higher' if a > b else 'lower' if a < b else 'equal'
                word = {'higher': 'higher than', 'lower': 'lower than', 'equal': 'equal to'}[relation]
                statement = f'{symbols[0]} ({values[0]} {first.unit}) is {word} {symbols[1]} ({values[1]} {first.unit}).'
            statement = (f'Alpha Vantage end-of-day, unadjusted {labels[intent.metric]}, '
                         f'{first.window.start} through {first.window.end}, '
                         f'{first.observation_count} observations: {statement} '
                         'Corporate actions unchecked; descriptive only, not forecasts or trading signals.')
            if intent.metric == 'raw_price_change':
                statement += ' Raw price change is not total return or shareholder performance.'
            elif intent.metric == 'raw_return_sample_stddev_20':
                statement += ' Not annualized or a reliable investment-risk measure.'
            else:
                statement += ' Nominal means can mix split price scales and do not establish investment performance.'
            findings.append(RealFinding(evidence_ids=tuple(item.id for item in items), metric=intent.metric,
                                        relation=relation, statement=statement))
    return findings, omitted


class RealResearch:
    def __init__(self, model: GeminiClient | None, service: HistoricalService | None, *,
                 enabled: bool = False, deadline: float = 30.0):
        if not 0 < deadline <= 30:
            raise ValueError('Deadline must be positive and at most 30 seconds.')
        self.model, self.service, self.enabled, self.deadline = model, service, enabled, deadline

    async def run(self, request: RealResearchInput | dict) -> RealResearchResult:
        # All state is request-local; no model conversation survives planning.
        state = {'model_calls': 0, 'history_retrievals': 0, 'plan': None}
        evidence: list[RealEvidence] = []
        errors: list[RealResearchError] = []

        def outcome(code, status='unavailable', findings=(), omitted=()):
            return RealResearchResult(code=code, message=MESSAGES[code], status=status,
                                      evidence=tuple(evidence), errors=tuple(errors),
                                      findings=tuple(findings), omitted=tuple(omitted), **state)
        try:
            request = RealResearchInput.model_validate(request)
        except (ValidationError, TypeError):
            return outcome('invalid_instruction')
        if self.enabled is not True:
            return outcome('disabled')
        if (self.model is None or self.service is None or self.service.mode != 'alpha_vantage'
                or self.service.closed or not self.service.api_key.strip()
                or self.service.client.is_closed or self.model.http_client.is_closed):
            return outcome('unconfigured')
        if instruction_dates(request.question) is None:
            return outcome('explicit_dates_required', 'clarification')
        ends = asyncio.get_running_loop().time() + self.deadline

        def remaining():
            seconds = ends - asyncio.get_running_loop().time()
            if seconds <= 0:
                raise asyncio.TimeoutError
            return seconds

        async def execute():
            state['model_calls'] = 1
            plan = await asyncio.wait_for(self.model.plan_real_research(request, timeout=min(20.0, remaining())),
                                          min(20.0, remaining()))
            try:
                plan = validate_plan(plan, request)
            except (ValueError, TypeError):
                raise ModelFailure('invalid_model_output') from None
            state['plan'] = plan
            if plan.status != 'planned':
                return outcome(plan.reason, plan.status)
            # Model phase has ended permanently. No error/telemetry is sent back.
            for index, symbol in enumerate(plan.symbols, start=1):
                query = HistoryRequest(symbol=symbol, start_date=date.fromisoformat(plan.start_date),
                                       end_date=date.fromisoformat(plan.end_date))
                remaining()
                state['history_retrievals'] += 1
                try:
                    history = await asyncio.wait_for(self.service.get_history(query), remaining())
                except HistoryError as error:
                    errors.append(RealResearchError(
                        symbol=symbol, status=error.status if error.status in PROVIDER_MESSAGES else 502,
                        message=PROVIDER_MESSAGES.get(error.status, PROVIDER_MESSAGES[502]),
                        available_range=error.available_range,
                    ))
                    continue
                if not isinstance(history, RealHistoryResult):
                    raise TypeError('Real history required')
                history = RealHistoryResult.model_validate(history)
                if history.symbol != symbol or history.requested_range != DateRange(start=query.start_date, end=query.end_date):
                    raise ValueError('Evidence does not match plan')
                calculated = calculate_real_history_metrics(history)
                remaining()
                evidence.append(RealEvidence(id=f'rh{index}', metrics=calculated))
            findings, omitted = render_findings(plan, evidence)
            remaining()
            status = 'partial' if findings and (errors or omitted) else 'answered' if findings else 'unavailable'
            return outcome(status, status, findings, omitted)
        try:
            return await asyncio.wait_for(execute(), self.deadline)
        except asyncio.TimeoutError:
            return outcome('research_timeout', 'partial' if evidence else 'unavailable')
        except ModelFailure as error:
            code = error.code if error.code in {
                'model_refusal', 'model_truncated', 'model_quota', 'model_unavailable',
                'invalid_model_output', 'research_timeout',
            } else 'model_unavailable'
            return outcome(code)
        except Exception:  # noqa: BLE001 -- unexpected defects remain execution failures, never input errors.
            return outcome('research_failed', 'partial' if evidence else 'unavailable')
