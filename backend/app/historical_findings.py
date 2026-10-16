"""Model selections only; historical numbers and statements belong to the backend."""

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.historical_research import HistoricalMetricEvidence
from app.research_explanation import ModelFailure, ModelReply

MetricKey = Literal['price_change', 'sma_20', 'sma_50', 'adjacent_return_volatility_20']


class HistoricalFinding(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    metric: MetricKey
    evidence_ids: list[str] = Field(min_length=1, max_length=2)
    relation: Literal['reported', 'higher', 'lower', 'equal']


class AgentReply(ModelReply):
    # Optional for compatibility with existing quote-only replies.
    historical_findings: list[HistoricalFinding] = Field(default_factory=list, max_length=4)


class RenderedHistoricalFinding(HistoricalFinding):
    statement: str
    statement_origin: Literal['backend'] = 'backend'


def render_historical_findings(
    findings: list[HistoricalFinding], evidence: list[HistoricalMetricEvidence],
) -> list[RenderedHistoricalFinding]:
    """Validate against retained, rounded evidence; never recalculate or accept prose."""
    by_id = {item.id: item for item in evidence}
    rendered = []
    seen = set()
    labels = {
        'price_change': 'price change (not dividend-inclusive total return)',
        'sma_20': '20-observation nominal closing-price mean',
        'sma_50': '50-observation nominal closing-price mean',
        'adjacent_return_volatility_20': 'adjacent-observation return volatility (not annualized)',
    }
    for finding in findings:
        key = (finding.metric, tuple(finding.evidence_ids), finding.relation)
        if key in seen or len(set(finding.evidence_ids)) != len(finding.evidence_ids):
            raise ModelFailure('invalid_model_output')
        seen.add(key)
        if any(ref not in by_id for ref in finding.evidence_ids):
            raise ModelFailure('invalid_model_output')
        items = [by_id[ref] for ref in finding.evidence_ids]
        metrics = [getattr(item, finding.metric) for item in items]
        if any(metric.status != 'available' or metric.value is None or metric.window is None
               or not metric.value.is_finite() for metric in metrics):
            raise ModelFailure('invalid_model_output')
        # These strings are exactly the authoritative values serialized in evidence.
        values = [metric.model_dump(mode='json')['value'] for metric in metrics]
        first = metrics[0]
        if len(items) == 1:
            if finding.relation != 'reported':
                raise ModelFailure('invalid_model_output')
            statement = f'{items[0].provenance.symbol}: {values[0]} {first.unit}.'
        else:
            left, right = items
            second = metrics[1]
            provenance_fields = ('source', 'data_kind', 'currency', 'adjustment_basis',
                                 'interval', 'observation_calendar', 'fixture_range')
            if (first.window != second.window or first.unit != second.unit
                    or first.observation_count != second.observation_count
                    or first.required_observations != second.required_observations
                    or any(getattr(left.provenance, name) != getattr(right.provenance, name)
                           for name in provenance_fields)
                    or (finding.metric == 'adjacent_return_volatility_20'
                        and left.volatility_return_count != right.volatility_return_count)):
                raise ModelFailure('invalid_model_output')
            a, b = (Decimal(value) for value in values)
            relation = 'higher' if a > b else 'lower' if a < b else 'equal'
            if finding.relation != relation:
                raise ModelFailure('invalid_model_output')
            wording = {'higher': 'higher than', 'lower': 'lower than', 'equal': 'equal to'}[relation]
            statement = (f'{left.provenance.symbol} ({values[0]} {first.unit}) is {wording} '
                         f'{right.provenance.symbol} ({values[1]} {second.unit}).')
        statement = (f'FICTIONAL DEMO DATA — {labels[finding.metric]}, '
                     f'{first.window.start} through {first.window.end}, '
                     f'{first.observation_count} observations: {statement} '
                     'Adjustment basis unknown; not actual market performance.')
        if finding.metric == 'adjacent_return_volatility_20':
            statement += ' This describes measured return variability, not overall safety.'
        elif finding.metric in ('sma_20', 'sma_50'):
            statement += ' Nominal price levels do not establish better performance.'
        if any(item.provenance.coverage != 'within_fixture' for item in items):
            statement += ' Requested coverage is incomplete; only the actual window above is used.'
        rendered.append(RenderedHistoricalFinding(**finding.model_dump(), statement=statement))
    return rendered
