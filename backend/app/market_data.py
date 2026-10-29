"""Bounded, process-local quote service. No live calls in demo mode."""

import asyncio
import os
import re
import time
from collections import deque
from datetime import date, datetime, timezone
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, model_validator

SYMBOLS = ('AAPL', 'MSFT', 'NVDA')
TTL = 6 * 60 * 60
WINDOW = 24 * 60 * 60
# Self-authored fictional values, not copied from market data.
DEMO = {
    'AAPL': (205.0, 5.0, 2.5, 208.0, 198.0, 100000),
    'MSFT': (396.0, -4.0, -1.0, 405.0, 390.0, 80000),
    'NVDA': (110.0, 10.0, 10.0, 112.0, 99.0, 120000),
}


class QuoteError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


class Quote(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, frozen=True)
    symbol: Literal['AAPL', 'MSFT', 'NVDA']
    currency: Literal['USD'] = 'USD'
    price: float = Field(gt=0)
    change: float
    change_percent: float
    high: float = Field(gt=0)
    low: float = Field(gt=0)
    volume: int = Field(ge=0, strict=True)
    latest_trading_day: date
    source: Literal['demo', 'alpha_vantage']
    data_kind: Literal['fictional', 'end_of_day']
    fetched_at: datetime
    cache_hit: bool = False

    @model_validator(mode='after')
    def validate_dates_and_range(self):
        if (self.source, self.data_kind) not in (
            ('demo', 'fictional'), ('alpha_vantage', 'end_of_day'),
        ):
            raise ValueError('Quote source and data kind must agree')
        if self.fetched_at.tzinfo is None:
            raise ValueError('Fetch timestamp must be timezone-aware')
        if self.latest_trading_day > self.fetched_at.date():
            raise ValueError('Trading date cannot be in the future')
        if not self.low <= self.price <= self.high:
            raise ValueError('Invalid price range')
        return self


def normalize_symbol(symbol: str) -> str:
    if not re.fullmatch(r'[A-Za-z]{1,5}', symbol):
        raise QuoteError(400, 'Symbol must contain 1–5 ASCII letters.')
    symbol = symbol.upper()
    if symbol not in SYMBOLS:
        raise QuoteError(404, 'Supported symbols: AAPL, MSFT, NVDA.')
    return symbol


def parse_quote(payload: object, symbol: str, fetched_at: datetime) -> Quote:
    if not isinstance(payload, dict):
        raise QuoteError(502, 'Provider returned invalid quote data.')
    for key in ('Note', 'Information', 'Error Message'):
        if key in payload:
            message = str(payload[key]).lower()
            quota = any(term in message for term in (
                'rate limit', 'call frequency', 'calls per', 'requests per',
                'api quota', 'quota exceeded',
            ))
            if quota:
                raise QuoteError(429, 'Provider request quota reached.')
            raise QuoteError(502, 'Provider could not supply a quote.')
    raw = payload.get('Global Quote')
    if not isinstance(raw, dict) or not raw:
        raise QuoteError(502, 'Provider quote is missing.')
    try:
        if raw['01. symbol'] != symbol:
            raise ValueError('Mismatched symbol')
        percent = raw['10. change percent']
        volume = raw['06. volume']
        day = raw['07. latest trading day']
        if not isinstance(percent, str) or not percent.endswith('%'):
            raise ValueError('Missing percentage suffix')
        if not isinstance(volume, str) or not re.fullmatch(r'[0-9]+', volume):
            raise ValueError('Invalid volume')
        if not isinstance(day, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
            raise ValueError('Invalid date')
        def number(key):
            value = raw[key]
            if not isinstance(value, str):
                raise TypeError('Expected provider numeric string')
            return float(value)
        return Quote(
            symbol=symbol, price=number('05. price'), change=number('09. change'),
            change_percent=float(percent[:-1]), high=number('03. high'),
            low=number('04. low'), volume=int(volume), latest_trading_day=date.fromisoformat(day),
            source='alpha_vantage', data_kind='end_of_day', fetched_at=fetched_at,
        )
    except (KeyError, ValueError, TypeError, OverflowError):
        raise QuoteError(502, 'Provider returned invalid quote data.') from None


class MarketData:
    def __init__(self, client: httpx.AsyncClient, *, provider=None, api_key=None,
                 clock=time.monotonic, utcnow=lambda: datetime.now(timezone.utc)):
        self.client = client
        self.provider = os.environ.get('MARKET_DATA_PROVIDER', 'demo') if provider is None else provider
        self.api_key = os.environ.get('ALPHA_VANTAGE_API_KEY', '') if api_key is None else api_key
        self.clock = clock
        self.utcnow = utcnow
        self.cache: dict[str, tuple[float, Quote]] = {}
        self.inflight: dict[str, asyncio.Task] = {}
        self.attempts: deque[float] = deque()

    async def get_quote(self, symbol: str) -> Quote:
        symbol = normalize_symbol(symbol)
        cached = self.cache.get(symbol)
        if cached and self.clock() < cached[0]:
            return cached[1].model_copy(update={'cache_hit': True})
        task = self.inflight.get(symbol)
        if task is None:
            task = asyncio.create_task(self._fetch(symbol))
            self.inflight[symbol] = task
            task.add_done_callback(lambda done: self._completed(symbol, done))
        # One disconnected caller must not cancel a shared provider request.
        return await asyncio.shield(task)

    def _completed(self, symbol, task):
        if self.inflight.get(symbol) is task:
            del self.inflight[symbol]
        if not task.cancelled():
            task.exception()  # Retrieve failures even if all callers disconnected.

    async def close(self):
        tasks = list(self.inflight.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _fetch(self, symbol: str) -> Quote:
        self.cache.pop(symbol, None)
        if self.provider == 'demo':
            price, change, percent, high, low, volume = DEMO[symbol]
            quote = Quote(symbol=symbol, price=price, change=change, change_percent=percent,
                          high=high, low=low, volume=volume, latest_trading_day=date(2026, 1, 2),
                          source='demo', data_kind='fictional', fetched_at=self.utcnow())
        elif self.provider == 'alpha_vantage':
            if not self.api_key.strip():
                raise QuoteError(503, 'Alpha Vantage API key is not configured.')
            now = self.clock()
            while self.attempts and self.attempts[0] <= now - WINDOW:
                self.attempts.popleft()
            if len(self.attempts) >= 20:
                raise QuoteError(429, 'Local daily provider attempt budget exhausted.')
            self.attempts.append(now)  # Reserve before any await; failed calls count too.
            try:
                response = await self.client.get(
                    'https://www.alphavantage.co/query',
                    params={'function': 'GLOBAL_QUOTE', 'symbol': symbol, 'apikey': self.api_key},
                )
            except httpx.TimeoutException:
                raise QuoteError(504, 'Provider request timed out.') from None
            except httpx.RequestError:
                raise QuoteError(502, 'Provider connection failed.') from None
            if response.status_code == 429:
                raise QuoteError(429, 'Provider request quota reached.')
            if not response.is_success:
                raise QuoteError(502, 'Provider HTTP request failed.')
            try:
                payload = response.json()
            except (ValueError, UnicodeError):
                raise QuoteError(502, 'Provider returned invalid JSON.') from None
            quote = parse_quote(payload, symbol, self.utcnow())
        else:
            raise QuoteError(503, 'Market data provider must be demo or alpha_vantage.')
        self.cache[symbol] = (self.clock() + TTL, quote)
        return quote
