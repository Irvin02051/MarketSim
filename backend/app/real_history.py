"""Internal compact daily retrieval. Never used by existing routes or agent tools."""

import asyncio
import json
import logging
import os
import re
import time
from datetime import date, datetime, timezone
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from pydantic import model_validator

from app.historical_data import (
    DailyBar,
    DateRange,
    HistoricalInput,
    HistoricalResult,
    HistoryModel,
    get_history,
)
from app.market_data import (
    NOTICE_RULE_IDS,
    SYMBOLS,
    TTL,
    ProviderBudget,
    QuoteError,
    notice_quota_rule,
)

logger = logging.getLogger(__name__)
FAILURE_CATEGORIES = frozenset({
    'local_budget_exhausted', 'upstream_http_429',
    'upstream_notice_quota_match', 'upstream_notice_other',
})


def _log_failure(category, symbol, *, upstream_status=None, local_attempt_count=None, rule=None):
    """Fixed diagnostic metadata only, including when the parser is called directly."""
    if category not in FAILURE_CATEGORIES:
        return
    safe_symbol = symbol if isinstance(symbol, str) and symbol in SYMBOLS else None
    status = upstream_status if type(upstream_status) is int and 100 <= upstream_status <= 599 else None
    count = local_attempt_count if type(local_attempt_count) is int and 0 <= local_attempt_count <= 20 else None
    safe_rule = rule if rule in NOTICE_RULE_IDS else None
    logger.warning('Real history failure category=%s symbol=%s upstream_status=%s local_attempt_count=%s rule=%s',
                   category, safe_symbol, status, count, safe_rule)


FETCH_DEADLINE = 10.0
MAX_BODY_BYTES = 256 * 1024
LIMITATIONS = (
    'Raw, unadjusted observations; splits and dividends are not handled or detected.',
    ('Unadjusted history is excluded from the fictional-history metrics and '
     'Gemini research pipeline. Separate raw-price descriptive statistics are '
     'available on explicit request.'),
    'Compact snapshot only; within-snapshot coverage does not establish exchange-calendar completeness.',
    'Missing dates are not filled; missing volume remains null.',
    'Retrieval time and provider metadata do not establish freshness or final session completion.',
)


class HistoryError(QuoteError):
    def __init__(self, status: int, detail: str, *, available_range: DateRange | None = None):
        super().__init__(status, detail)
        self.available_range = available_range


class HistoryRequest(HistoricalInput):
    @model_validator(mode='after')
    def short_range(self):
        if (self.end_date - self.start_date).days >= 90:
            raise ValueError('Requested range must contain at most 90 calendar days.')
        return self


class RealHistoryResult(HistoryModel):
    symbol: Literal['AAPL', 'MSFT', 'NVDA']
    currency: Literal['USD'] = 'USD'
    source: Literal['alpha_vantage'] = 'alpha_vantage'
    data_kind: Literal['end_of_day'] = 'end_of_day'
    adjustment_basis: Literal['unadjusted'] = 'unadjusted'
    interval: Literal['daily'] = 'daily'
    requested_range: DateRange
    available_range: DateRange
    returned_range: DateRange | None
    coverage: Literal['within_snapshot_bounds'] = 'within_snapshot_bounds'
    status: Literal['ok', 'empty']
    fetched_at: datetime
    cache_hit: bool
    provider_timezone: str | None
    bars: tuple[DailyBar, ...]
    limitations: tuple[str, ...] = LIMITATIONS

    @model_validator(mode='after')
    def consistent(self):
        if self.fetched_at.utcoffset() is None:
            raise ValueError('Retrieval timestamp must be timezone-aware.')
        if not (self.available_range.start <= self.requested_range.start
                <= self.requested_range.end <= self.available_range.end):
            raise ValueError('Request must be within snapshot bounds.')
        if (self.requested_range.end - self.requested_range.start).days >= 90:
            raise ValueError('Request exceeds 90 calendar days.')
        if len(self.bars) > 100:
            raise ValueError('Too many compact observations.')
        previous = None
        for bar in self.bars:
            if not self.requested_range.start <= bar.date <= self.requested_range.end:
                raise ValueError('Observation outside requested range.')
            if previous is not None and bar.date <= previous:
                raise ValueError('Observation dates must be unique and ascending.')
            previous = bar.date
        actual = DateRange(start=self.bars[0].date, end=self.bars[-1].date) if self.bars else None
        if self.returned_range != actual or self.status != ('ok' if self.bars else 'empty'):
            raise ValueError('Returned range/status must describe observations.')
        if self.provider_timezone is not None and validated_timezone(self.provider_timezone) is None:
            raise ValueError('Invalid provider timezone.')
        return self


class Snapshot(HistoryModel):
    symbol: Literal['AAPL', 'MSFT', 'NVDA']
    bars: tuple[DailyBar, ...]
    fetched_at: datetime
    provider_timezone: str | None


def validated_timezone(value: object) -> str | None:
    if not isinstance(value, str) or len(value) > 64:
        return None
    try:
        ZoneInfo(value)
    except (ValueError, ZoneInfoNotFoundError):
        return None
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key')
        result[key] = value
    return result


def parse_snapshot(body: bytes, symbol: str, fetched_at: datetime, *,
                   upstream_status: int | None = None, local_attempt_count: int | None = None) -> Snapshot:
    """Decode duplicate-aware JSON and validate every bar before caching anything."""
    try:
        payload = json.loads(body, object_pairs_hook=unique_object)
        if not isinstance(payload, dict):
            raise TypeError('Expected object')
        for key in ('Note', 'Information', 'Error Message'):
            if key in payload:
                rule = notice_quota_rule(payload[key])
                _log_failure('upstream_notice_quota_match' if rule else 'upstream_notice_other', symbol,
                             upstream_status=upstream_status, local_attempt_count=local_attempt_count, rule=rule)
                if rule:
                    raise HistoryError(429, 'Provider request quota reached.')
                raise HistoryError(502, 'Provider could not supply daily history.')
        metadata = payload['Meta Data']
        if not isinstance(metadata, dict) or metadata.get('2. Symbol') != symbol:
            raise ValueError('Invalid symbol metadata')
        raw = payload['Time Series (Daily)']
        if not isinstance(raw, dict) or not 1 <= len(raw) <= 100:
            raise ValueError('Invalid compact snapshot')
        bars = []
        for day, values in raw.items():
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day) or not isinstance(values, dict):
                raise ValueError('Invalid observation')
            prices = {}
            for field, key in [('open', '1. open'), ('high', '2. high'),
                               ('low', '3. low'), ('close', '4. close')]:
                value = values[key]
                if not isinstance(value, str):
                    raise TypeError('Expected numeric string')
                prices[field] = float(value)
            volume = values.get('5. volume')
            if volume is not None:
                if not isinstance(volume, str) or not re.fullmatch(r'[0-9]+', volume):
                    raise ValueError('Invalid volume')
                volume = int(volume)
            bars.append(DailyBar(date=date.fromisoformat(day), volume=volume, **prices))
        if fetched_at.utcoffset() is None:
            raise ValueError('Invalid retrieval timestamp')
        return Snapshot(symbol=symbol, bars=tuple(sorted(bars, key=lambda bar: bar.date)),
                        fetched_at=fetched_at,
                        provider_timezone=validated_timezone(metadata.get('5. Time Zone')))
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
        raise HistoryError(502, 'Provider returned invalid daily history.') from None


class HistoricalService:
    def __init__(self, client: httpx.AsyncClient, *, budget: ProviderBudget,
                 mode='demo', api_key=None, clock=time.monotonic,
                 utcnow=lambda: datetime.now(timezone.utc), deadline=FETCH_DEADLINE):
        if not 0 < deadline <= FETCH_DEADLINE:
            raise ValueError('Deadline must be positive and at most 10 seconds.')
        self.client, self.budget, self.mode = client, budget, mode
        self.api_key = os.environ.get('ALPHA_VANTAGE_API_KEY', '') if api_key is None else api_key
        self.clock, self.utcnow, self.deadline = clock, utcnow, deadline
        self.cache: dict[str, tuple[float, Snapshot]] = {}
        self.inflight: dict[str, asyncio.Task] = {}
        self.closed = False

    async def get_history(self, request: HistoryRequest | dict[str, object]) -> HistoricalResult | RealHistoryResult:
        validated = HistoryRequest.model_validate(request)
        if self.closed:
            raise HistoryError(503, 'History service is closed.')
        if self.mode == 'demo':
            return get_history(HistoricalInput(**validated.model_dump()))
        if self.mode != 'alpha_vantage':
            raise HistoryError(503, 'History mode must be demo or alpha_vantage.')
        symbol = validated.symbol
        cached = self.cache.get(symbol)
        hit = cached is not None and self.clock() < cached[0]
        if hit:
            snapshot = cached[1]
        else:
            task = self.inflight.get(symbol)
            if task is None:
                task = asyncio.create_task(self._fetch(symbol))
                self.inflight[symbol] = task
                task.add_done_callback(lambda done: self._completed(symbol, done))
            snapshot = await asyncio.shield(task)
        available = DateRange(start=snapshot.bars[0].date, end=snapshot.bars[-1].date)
        requested = DateRange(start=validated.start_date, end=validated.end_date)
        if requested.start < available.start or requested.end > available.end:
            raise HistoryError(422, 'Requested range is unavailable in the compact snapshot.',
                               available_range=available)
        bars = tuple(bar for bar in snapshot.bars if requested.start <= bar.date <= requested.end)
        return RealHistoryResult(
            symbol=symbol, requested_range=requested, available_range=available,
            returned_range=DateRange(start=bars[0].date, end=bars[-1].date) if bars else None,
            status='ok' if bars else 'empty', fetched_at=snapshot.fetched_at, cache_hit=hit,
            provider_timezone=snapshot.provider_timezone, bars=bars,
        )

    def _completed(self, symbol, task):
        if self.inflight.get(symbol) is task:
            del self.inflight[symbol]
        if not task.cancelled():
            task.exception()

    async def close(self):
        self.closed = True
        tasks = list(self.inflight.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.inflight.clear()
        self.cache.clear()

    async def _fetch(self, symbol):
        self.cache.pop(symbol, None)
        if not self.api_key.strip():
            raise HistoryError(503, 'Alpha Vantage API key is not configured.')
        try:
            self.budget.reserve()
        except QuoteError:
            _log_failure('local_budget_exhausted', symbol, local_attempt_count=len(self.budget.attempts))
            raise HistoryError(429, 'Local daily provider attempt budget exhausted.') from None
        try:
            body = await asyncio.wait_for(self._read(symbol), timeout=self.deadline)
        except (asyncio.TimeoutError, httpx.TimeoutException):
            raise HistoryError(504, 'History provider request timed out.') from None
        except httpx.RequestError:
            raise HistoryError(502, 'History provider connection failed.') from None
        snapshot = parse_snapshot(body, symbol, self.utcnow(), upstream_status=200,
                                  local_attempt_count=len(self.budget.attempts))
        self.cache[symbol] = (self.clock() + TTL, snapshot)
        return snapshot

    async def _read(self, symbol):
        async with self.client.stream('GET', 'https://www.alphavantage.co/query', params={
            'function': 'TIME_SERIES_DAILY', 'symbol': symbol, 'outputsize': 'compact',
            'datatype': 'json', 'apikey': self.api_key,
        }, follow_redirects=False) as response:
            if response.status_code == 429:
                _log_failure('upstream_http_429', symbol, upstream_status=429,
                             local_attempt_count=len(self.budget.attempts))
                raise HistoryError(429, 'Provider request quota reached.')
            if response.status_code != 200:
                raise HistoryError(502, 'History provider HTTP request failed.')
            body = bytearray()
            async for chunk in response.aiter_bytes():
                if len(body) + len(chunk) > MAX_BODY_BYTES:
                    raise HistoryError(502, 'History provider response exceeds size limit.')
                body.extend(chunk)
            return bytes(body)
