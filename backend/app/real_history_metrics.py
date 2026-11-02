"""Pure raw-price descriptions, separate from the fictional research pipeline."""

from datetime import datetime
from typing import Literal

from app.historical_data import DateRange, HistoryModel
from app.historical_metrics import HistoricalMetric, _calculate_metrics
from app.real_history import RealHistoryResult

CALCULATION_LIMITATIONS = (
    'Descriptive backend calculations over supplied observations, not forecasts or trading signals.',
    'Raw closing-price change is not total return or shareholder performance.',
    'Raw moving averages can mix pre-split and post-split price scales.',
    'Raw-return variability is not a reliable investment-risk measure and is not annualized.',
    'Splits and dividends are not handled, checked, inferred, or corrected.',
    'Snapshot coverage does not establish exchange-calendar completeness; actual metric windows may differ.',
    'Missing dates are not filled or treated as zero returns; no additional observations are retrieved.',
    ('Source limitations describe retrieval and the existing fictional-only metrics pipeline; '
     'this separate raw calculator does not change that boundary.'),
)


class RealHistoryMetrics(HistoryModel):
    origin: Literal['backend'] = 'backend'
    calculation_basis: Literal['raw_closing_prices'] = 'raw_closing_prices'
    symbol: Literal['AAPL', 'MSFT', 'NVDA']
    currency: Literal['USD']
    source: Literal['alpha_vantage']
    data_kind: Literal['end_of_day']
    adjustment_basis: Literal['unadjusted']
    interval: Literal['daily']
    requested_range: DateRange
    available_range: DateRange
    returned_range: DateRange | None
    fetched_at: datetime
    cache_hit: bool
    provider_timezone: str | None
    coverage: Literal['within_snapshot_bounds']
    status: Literal['ok', 'empty']
    observation_count: int
    calendar_completeness: Literal['not_verified'] = 'not_verified'
    corporate_actions_checked: Literal[False] = False
    raw_price_change: HistoricalMetric
    raw_sma_20: HistoricalMetric
    raw_sma_50: HistoricalMetric
    raw_return_sample_stddev_20: HistoricalMetric
    return_count: int
    source_limitations: tuple[str, ...]
    calculation_limitations: tuple[str, ...] = CALCULATION_LIMITATIONS


def calculate_real_history_metrics(history: RealHistoryResult) -> RealHistoryMetrics:
    """Revalidate even constructed/mutated instances; never retrieve or mutate data.

    Shared arithmetic uses Decimal(str(close)), an isolated 680-digit context,
    unrounded intermediates and six-decimal half-even outputs. It cannot recover
    provider-string precision already lost during conversion to float.
    """
    if not isinstance(history, RealHistoryResult):
        raise TypeError('Expected a validated RealHistoryResult.')
    history = RealHistoryResult.model_validate(history)
    calculated = _calculate_metrics(history.bars)
    return RealHistoryMetrics(
        symbol=history.symbol, currency=history.currency, source=history.source,
        data_kind=history.data_kind, adjustment_basis=history.adjustment_basis,
        interval=history.interval, requested_range=history.requested_range,
        available_range=history.available_range, returned_range=history.returned_range,
        fetched_at=history.fetched_at, cache_hit=history.cache_hit,
        provider_timezone=history.provider_timezone, coverage=history.coverage,
        status=history.status, observation_count=len(history.bars),
        raw_price_change=calculated.price_change, raw_sma_20=calculated.sma_20,
        raw_sma_50=calculated.sma_50, raw_return_sample_stddev_20=calculated.return_stddev,
        return_count=calculated.return_count, source_limitations=history.limitations,
    )
