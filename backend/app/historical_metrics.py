"""Pure descriptive calculations over supplied history, never forecasts."""

from decimal import ROUND_HALF_EVEN, Context, Decimal, localcontext
from itertools import pairwise
from typing import Literal

from pydantic import model_validator

from app.historical_data import DateRange, HistoricalResult, HistoryModel

OUTPUT_QUANTUM = Decimal('0.000001')
# Positive binary64 closes convert to decimals in [5e-324, 1.7976931348623157e308].
# Their largest ratio is < 3.6e631; percentages need at most 634 integer digits.
# Six fractional digits plus 40 guard digits protect intermediate arithmetic.
# Squaring increases the exponent, not the significant-digit requirement for
# the final square root. This is a conservative budget, not a minimality proof.
CALCULATION_PRECISION = 634 + 6 + 40


class HistoricalMetric(HistoryModel):
    status: Literal['available', 'unavailable']
    value: Decimal | None
    unit: Literal['USD', 'percent']
    window: DateRange | None
    observation_count: int
    required_observations: int
    reason: str | None = None

    @model_validator(mode='after')
    def finite_value(self) -> 'HistoricalMetric':
        if self.value is not None and not self.value.is_finite():
            raise ValueError('Calculated values must be finite.')
        return self


class HistoricalMetrics(HistoryModel):
    origin: Literal['backend'] = 'backend'
    # Keep all original provenance, coverage, timestamps and observations together.
    history: HistoricalResult
    price_change: HistoricalMetric
    sma_20: HistoricalMetric
    sma_50: HistoricalMetric
    adjacent_return_volatility_20: HistoricalMetric
    volatility_return_count: int
    limitations: tuple[str, ...]


def calculate_historical_metrics(history: HistoricalResult) -> HistoricalMetrics:
    """Calculate on validated input only; no retrieval, date filling, or mutation.

    Decimal(str(close)), a 680-significant-digit local context, and no intermediate
    quantization are used. Final values round half-even to six decimal places and
    serialize as strings. Unavailable metrics have null values/windows; their
    observation_count reports the available closes (not a completed window).
    """
    if not isinstance(history, HistoricalResult):
        raise TypeError('Expected a validated HistoricalResult.')
    history = HistoricalResult.model_validate(history)
    bars = history.bars
    closes = [Decimal(str(bar.close)) for bar in bars]

    def metric(required: int, unit: Literal['USD', 'percent'], value: Decimal | None,
               count: int) -> HistoricalMetric:
        if len(bars) < required:
            return HistoricalMetric(
                status='unavailable', value=None, unit=unit, window=None,
                observation_count=len(bars), required_observations=required,
                reason=f'Requires {required} observations; received {len(bars)}.',
            )
        rounded = value.quantize(OUTPUT_QUANTUM, rounding=ROUND_HALF_EVEN)
        if rounded.is_zero():
            rounded = rounded.copy_abs()
        return HistoricalMetric(
            status='available', value=rounded, unit=unit,
            window=DateRange(start=bars[-count].date, end=bars[-1].date),
            observation_count=count, required_observations=required,
        )

    with localcontext(Context(prec=CALCULATION_PRECISION, rounding=ROUND_HALF_EVEN)):
        price_change = metric(2, 'percent', (closes[-1] / closes[0] - 1) * 100
                              if len(closes) >= 2 else None, len(closes))
        sma_20 = metric(20, 'USD', sum(closes[-20:]) / Decimal(20)
                       if len(closes) >= 20 else None, 20)
        sma_50 = metric(50, 'USD', sum(closes[-50:]) / Decimal(50)
                       if len(closes) >= 50 else None, 50)
        volatility = None
        if len(closes) >= 21:
            window = closes[-21:]
            returns = [current / previous - 1 for previous, current in pairwise(window)]
            mean = sum(returns) / Decimal(20)
            variance = sum((value - mean) ** 2 for value in returns) / Decimal(19)
            volatility = variance.sqrt() * 100
        return_volatility = metric(21, 'percent', volatility, 21)

    limitations = history.limitations + (
        'Descriptive backend calculations over supplied observations, not forecasts or trading signals.',
        'Price change is not dividend-inclusive total return.',
        ('Unknown adjustment basis and unmodeled corporate actions limit interpretation; '
         'future real-provider data requires adjustment checks before use.'),
        ('Adjacent-observation return volatility uses 20 returns from 21 closes, sample denominator 19; '
         'it is not annualized. Calendar gaps are not filled or treated as zero returns.'),
    )
    if history.coverage != 'within_fixture':
        limitations += ('Requested range is not fully covered by fixtures; metrics use only supplied observations.',)
    return HistoricalMetrics(
        history=history, price_change=price_change, sma_20=sma_20, sma_50=sma_50,
        adjacent_return_volatility_20=return_volatility,
        volatility_return_count=20 if volatility is not None else 0, limitations=limitations,
    )
