"""Compact internal historical evidence; no HTTP or model-tool registration."""

from datetime import date, datetime
from typing import Literal

from pydantic import model_validator

from app.historical_data import DateRange, HistoricalInput, HistoryModel, get_history
from app.historical_metrics import HistoricalMetric, calculate_historical_metrics
from app.research import QuotesInput, SymbolError


class HistoricalResearchInput(QuotesInput):
    start_date: date
    end_date: date

    @model_validator(mode='after')
    def valid_history_requests(self) -> 'HistoricalResearchInput':
        # Reuse the actual history contract, including leap-year range bounds.
        for symbol in self.symbols:
            HistoricalInput(symbol=symbol, start_date=self.start_date, end_date=self.end_date)
        return self


class HistoricalProvenance(HistoryModel):
    symbol: Literal['AAPL', 'MSFT', 'NVDA']
    currency: Literal['USD']
    source: Literal['demo']
    data_kind: Literal['fictional']
    label: str
    adjustment_basis: Literal['unknown']
    interval: Literal['daily']
    observation_calendar: Literal['synthetic_weekdays']
    requested_range: DateRange
    returned_range: DateRange | None
    fixture_range: DateRange
    coverage: Literal['within_fixture', 'partial_overlap', 'outside_fixture']
    status: Literal['ok', 'empty']
    fetched_at: datetime


class HistoricalMetricEvidence(HistoryModel):
    id: str
    origin: Literal['backend'] = 'backend'
    provenance: HistoricalProvenance
    price_change: HistoricalMetric
    sma_20: HistoricalMetric
    sma_50: HistoricalMetric
    adjacent_return_volatility_20: HistoricalMetric
    volatility_return_count: int
    limitations: tuple[str, ...]


class HistoricalResearchResult(HistoryModel):
    request: HistoricalResearchInput
    evidence: tuple[HistoricalMetricEvidence, ...]
    # No expected runtime failures exist in the validated local fixture service.
    errors: tuple[SymbolError, ...] = ()
    data_mode: Literal['fictional'] = 'fictional'
    label: Literal['FICTIONAL DEMO DATA — not actual market performance.'] = (
        'FICTIONAL DEMO DATA — not actual market performance.'
    )
    limitations: tuple[str, ...] = (
        'No cross-stock comparisons or rankings are performed.',
        ('Later comparisons must check matching actual metric windows, units, adjustment basis '
         'and availability, not only requested dates.'),
    )


def get_historical_metrics(
    request: HistoricalResearchInput | dict[str, object],
) -> HistoricalResearchResult:
    """Validate the whole request before any retrieval, then collect once per symbol.

    Python callers supply date objects; model_validate_json accepts ISO dates.
    ValidationError for invalid input propagates before work begins. The existing
    demo service has no expected runtime domain exception after validation; errors
    in retrieval, calculation or projection propagate rather than becoming partial
    success. A future provider must define its domain failures before mapping them.
    """
    validated = HistoricalResearchInput.model_validate(request)
    requests = [HistoricalInput(symbol=symbol, start_date=validated.start_date,
                                end_date=validated.end_date) for symbol in validated.symbols]
    evidence = []
    for index, item in enumerate(requests, start=1):
        full = calculate_historical_metrics(get_history(item))
        history = full.history
        if history.symbol != item.symbol or history.requested_range != DateRange(
            start=item.start_date, end=item.end_date,
        ):
            raise ValueError('Historical service returned evidence for a different request.')
        # Project an explicit field allowlist; raw observations never enter tool output.
        provenance = HistoricalProvenance.model_validate(history.model_dump(exclude={'bars', 'limitations'}))
        evidence.append(HistoricalMetricEvidence(
            id=f'hm{index}', origin=full.origin, provenance=provenance,
            price_change=full.price_change, sma_20=full.sma_20, sma_50=full.sma_50,
            adjacent_return_volatility_20=full.adjacent_return_volatility_20,
            volatility_return_count=full.volatility_return_count, limitations=full.limitations,
        ))
    return HistoricalResearchResult(request=validated, evidence=tuple(evidence))
