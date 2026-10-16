"""Internal, deterministic fictional history. No network, environment, or cache."""

from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.market_data import QuoteError, normalize_symbol

FIXTURE_START = date(2024, 1, 1)
FIXTURE_END = date(2025, 12, 31)


class HistoryModel(BaseModel):
    model_config = ConfigDict(
        extra='forbid', strict=True, frozen=True, allow_inf_nan=False,
        revalidate_instances='always',
    )


class DateRange(HistoryModel):
    start: date
    end: date

    @model_validator(mode='after')
    def ordered(self) -> 'DateRange':
        if self.start > self.end:
            raise ValueError('Start date must not follow end date.')
        return self


class HistoricalInput(HistoryModel):
    symbol: str
    start_date: date
    end_date: date
    interval: Literal['daily'] = 'daily'

    @field_validator('symbol')
    @classmethod
    def supported_symbol(cls, value: str) -> str:
        try:
            return normalize_symbol(value)
        except QuoteError as error:
            raise ValueError(error.detail) from None

    @model_validator(mode='after')
    def bounded_range(self) -> 'HistoricalInput':
        if self.start_date > self.end_date:
            raise ValueError('Start date must not follow end date.')
        # Inclusive interval ends before its two-year anniversary. Clamp Feb 29.
        year = self.start_date.year + 2
        if year <= 9999:
            anniversary = self.start_date.replace(
                year=year, day=min(self.start_date.day, monthrange(year, self.start_date.month)[1]),
            )
            if self.end_date >= anniversary:
                raise ValueError('Requested range must not exceed two calendar years.')
        return self


class DailyBar(HistoryModel):
    date: date
    open: float = Field(gt=0)
    high: float = Field(gt=0)
    low: float = Field(gt=0)
    close: float = Field(gt=0)
    volume: int | None = Field(default=None, ge=0)

    @model_validator(mode='after')
    def valid_ohlc(self) -> 'DailyBar':
        if not self.low <= self.open <= self.high or not self.low <= self.close <= self.high:
            raise ValueError('Open and close must fall within low and high.')
        return self


class HistoricalResult(HistoryModel):
    symbol: Literal['AAPL', 'MSFT', 'NVDA']
    currency: Literal['USD'] = 'USD'
    source: Literal['demo'] = 'demo'
    data_kind: Literal['fictional'] = 'fictional'
    label: Literal['FICTIONAL DEMO DATA — not market observations.'] = (
        'FICTIONAL DEMO DATA — not market observations.'
    )
    interval: Literal['daily'] = 'daily'
    adjustment_basis: Literal['unknown'] = 'unknown'
    requested_range: DateRange
    returned_range: DateRange | None
    fixture_range: DateRange = DateRange(start=FIXTURE_START, end=FIXTURE_END)
    coverage: Literal['within_fixture', 'partial_overlap', 'outside_fixture']
    observation_calendar: Literal['synthetic_weekdays'] = 'synthetic_weekdays'
    status: Literal['ok', 'empty']
    fetched_at: datetime
    bars: tuple[DailyBar, ...]
    limitations: tuple[str, ...] = (
        'Synthetic weekday observations, not actual trading dates or an exchange schedule.',
        'No exchange-calendar completeness; weekends and dates outside fixture coverage are absent.',
        'Adjustment basis is unknown; corporate actions are not modeled.',
        'Separate fixtures: these values do not reconcile with standalone demo quotes.',
        'Missing volume stays null. Fetch time is not market-data freshness.',
    )

    @model_validator(mode='after')
    def valid_observations(self) -> 'HistoricalResult':
        if self.fetched_at.utcoffset() is None:
            raise ValueError('Fetch timestamp must be timezone-aware.')
        if self.fixture_range != DateRange(start=FIXTURE_START, end=FIXTURE_END):
            raise ValueError('Incorrect fixture coverage.')
        if self.coverage != _coverage(self.requested_range):
            raise ValueError('Coverage must describe the requested range.')
        previous = None
        for bar in self.bars:
            if not self.requested_range.start <= bar.date <= self.requested_range.end:
                raise ValueError('Bar date is outside the requested range.')
            if not FIXTURE_START <= bar.date <= FIXTURE_END or bar.date.weekday() >= 5:
                raise ValueError('Bar date is outside synthetic weekday coverage.')
            if previous is not None and bar.date <= previous:
                raise ValueError('Bar dates must be unique and strictly increasing.')
            previous = bar.date
        expected = DateRange(start=self.bars[0].date, end=self.bars[-1].date) if self.bars else None
        if self.returned_range != expected or self.status != ('ok' if self.bars else 'empty'):
            raise ValueError('Returned range and status must describe the actual bars.')
        return self


def _coverage(requested: DateRange) -> str:
    if requested.end < FIXTURE_START or requested.start > FIXTURE_END:
        return 'outside_fixture'
    if FIXTURE_START <= requested.start and requested.end <= FIXTURE_END:
        return 'within_fixture'
    return 'partial_overlap'


def get_history(request: HistoricalInput | dict[str, object]) -> HistoricalResult:
    """Validate first, then filter fixed fixtures inclusively without filling gaps.

    Python callers supply date objects; model_validate_json accepts ISO dates.
    Integer cents make each generated price deterministic without accumulated
    floating-point arithmetic. Indexing always starts at the fixed fixture origin.
    """
    validated = HistoricalInput.model_validate(request)
    requested = DateRange(start=validated.start_date, end=validated.end_date)
    base = {'AAPL': 18000, 'MSFT': 35000, 'NVDA': 9000}[validated.symbol]
    bars = []
    day, index = FIXTURE_START, 0
    while day <= FIXTURE_END:
        if day.weekday() < 5:
            if requested.start <= day <= requested.end:
                opening = base + index * 3 + (index % 11 - 5) * 7
                closing = opening + (index % 7 - 3) * 9
                bars.append(DailyBar(
                    date=day, open=opening / 100, close=closing / 100,
                    high=(max(opening, closing) + 100) / 100,
                    low=(min(opening, closing) - 100) / 100,
                    volume=None if index % 17 == 0 else 100000 + index * 101,
                ))
            index += 1
        day += timedelta(days=1)
    return HistoricalResult(
        symbol=validated.symbol, requested_range=requested,
        returned_range=DateRange(start=bars[0].date, end=bars[-1].date) if bars else None,
        coverage=_coverage(requested), status='ok' if bars else 'empty',
        fetched_at=datetime.now(timezone.utc), bars=tuple(bars),
    )
