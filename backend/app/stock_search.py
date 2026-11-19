"""Opt-in discovery. Provisional provider schema; no downstream symbol expansion."""

import asyncio
import json
import logging
import re
import time
import unicodedata
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict

from app.market_data import QuoteError, notice_quota_rule

TTL = 900
CAPACITY = 32
MAX_BYTES = 65536
MAX_MATCHES = 20
DEADLINE = 10


def query_text(value: str) -> str:
    if not isinstance(value, str) or any(unicodedata.category(c).startswith('C') for c in value):
        raise QuoteError(422, 'Use a search of 1–80 characters without control characters.')
    value = value.strip()
    if not 1 <= len(value) <= 80:
        raise QuoteError(422, 'Use a search of 1–80 characters without control characters.')
    return value


class SearchMatch(BaseModel):
    model_config = ConfigDict(frozen=True, extra='forbid')
    symbol: str
    name: str
    instrument_type: Literal['Equity']
    region: Literal['United States']
    currency: Literal['USD']
    market_open: str
    market_close: str
    provider_timezone: str  # Provider-reported display metadata, never used for conversion.
    match_score: str


class SearchResult(BaseModel):
    model_config = ConfigDict(frozen=True, extra='forbid')
    query: str
    matches: tuple[SearchMatch, ...]
    source: Literal['alpha_vantage'] = 'alpha_vantage'
    fetched_at: datetime
    cache_hit: bool = False


FIELDS = ('1. symbol', '2. name', '3. type', '4. region', '5. marketOpen',
          '6. marketClose', '7. timezone', '8. currency', '9. matchScore')


DIAGNOSTIC_STAGES = frozenset({'body', 'json', 'root', 'matches', 'row', 'field', 'model', 'notice', 'empty'})
DIAGNOSTIC_FIELDS = ('symbol', 'name', 'instrument_type', 'region', 'market_open',
                     'market_close', 'provider_timezone', 'currency', 'match_score')
DIAGNOSTIC_RULES = frozenset({'size', 'decode', 'duplicate_key', 'object', 'fields', 'list', 'count',
                            'missing', 'unexpected', 'text', 'wrong_type', 'empty', 'over_length',
                            'surrounding_whitespace', 'control_character', 'symbol_format', 'duplicate_symbol',
                            'time_format', 'currency_format', 'score_format',
                            'typed_result', 'quota', 'other', 'no_matches', 'filtered'})


def _diagnostic(stage, field, rule):
    # Fail closed even if a future caller accidentally supplies provider-controlled strings.
    if stage not in DIAGNOSTIC_STAGES or field not in (*DIAGNOSTIC_FIELDS, 'none') or rule not in DIAGNOSTIC_RULES:
        return
    logging.getLogger(__name__).log(
        logging.INFO if stage == 'empty' else logging.WARNING,
        'Stock search diagnostic stage=%s field=%s rule=%s', stage, field, rule,
    )


def parse_matches(body: bytes) -> tuple[SearchMatch, ...]:
    """Validate every row before filtering; unknown structures fail closed."""
    stage, field, rule = 'json', 'none', 'decode'
    def unique(pairs):
        nonlocal rule
        result = {}
        for key, value in pairs:
            if key in result:
                rule = 'duplicate_key'
                raise ValueError('Duplicate field')
            result[key] = value
        return result
    try:
        data = json.loads(body, object_pairs_hook=unique)
        stage, rule = 'root', 'object'
        if not isinstance(data, dict):
            raise TypeError('Object required')
        notices = [data[k] for k in ('Note', 'Information', 'Error Message') if k in data]
        if notices:
            # Every notice must clearly establish quota rejection; mixed notices stay 502.
            status = 429 if all(notice_quota_rule(n) for n in notices) else 502
            _diagnostic('notice', 'none', 'quota' if status == 429 else 'other')
            raise QuoteError(status, 'Provider request quota reached.' if status == 429 else 'Search provider unavailable.')
        stage, rule = 'root', 'fields'
        if set(data) != {'bestMatches'}:
            raise ValueError('Invalid root fields')
        stage, rule = 'matches', 'list'
        if not isinstance(data['bestMatches'], list):
            raise TypeError('Invalid matches')
        rule = 'count'
        if len(data['bestMatches']) > MAX_MATCHES:
            raise ValueError('Too many matches')
        matches, seen = [], set()
        for row in data['bestMatches']:
            stage, field, rule = 'row', 'none', 'object'
            if not isinstance(row, dict):
                raise TypeError('Invalid row')
            for key, identifier in zip(FIELDS, DIAGNOSTIC_FIELDS):
                if key not in row:
                    stage, field, rule = 'field', identifier, 'missing'
                    raise ValueError('Missing field')
            rule = 'unexpected'
            if set(row) != set(FIELDS):
                raise ValueError('Unexpected fields')
            for key, identifier in zip(FIELDS, DIAGNOSTIC_FIELDS):
                stage, field, rule = 'field', identifier, 'text'
                value = row[key]
                if identifier == 'name':
                    # Check raw input before removing only ordinary ASCII edge spaces.
                    if not isinstance(value, str):
                        rule = 'wrong_type'
                    elif not value:
                        rule = 'empty'
                    elif len(value) > 200:
                        rule = 'over_length'
                    elif any(unicodedata.category(c).startswith('C') for c in value):
                        rule = 'control_character'
                    if rule != 'text':
                        raise ValueError('Invalid name metadata')
                    value = value.strip(' ')
                    if not value:
                        rule = 'empty'
                    elif value != value.strip():
                        rule = 'surrounding_whitespace'
                    if rule != 'text':
                        raise ValueError('Invalid name metadata')
                    row[key] = value
                if not isinstance(value, str) or not value or value != value.strip() or len(value) > 200 or any(
                    unicodedata.category(c).startswith('C') for c in value
                ):
                    raise ValueError('Invalid text')
            symbol, name, kind, region, opened, closed, zone, currency, score = [row[k] for k in FIELDS]
            field, rule = 'symbol', 'symbol_format'
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.\-^/]{0,31}', symbol):
                raise ValueError('Invalid symbol')
            rule = 'duplicate_symbol'
            if symbol in seen:
                raise ValueError('Duplicate symbol')
            seen.add(symbol)
            for value, identifier in ((opened, 'market_open'), (closed, 'market_close')):
                field, rule = identifier, 'time_format'
                if not re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]', value):
                    raise ValueError('Invalid time')
            field, rule = 'currency', 'currency_format'
            if not re.fullmatch(r'[A-Z]{3}', currency):
                raise ValueError('Invalid currency')
            field, rule = 'match_score', 'score_format'
            if not re.fullmatch(r'(?:0(?:\.[0-9]{1,8})?|1(?:\.0{1,8})?)', score):
                raise ValueError('Invalid score')
            if (kind, region, currency) == ('Equity', 'United States', 'USD'):
                stage, field, rule = 'model', 'none', 'typed_result'
                matches.append(SearchMatch(symbol=symbol, name=name, instrument_type=kind, region=region,
                                           currency=currency, market_open=opened, market_close=closed,
                                           provider_timezone=zone, match_score=score))
        if not matches:
            _diagnostic('empty', 'none', 'filtered' if data['bestMatches'] else 'no_matches')
        return tuple(matches)
    except (ValueError, TypeError, UnicodeError):
        _diagnostic(stage, field, rule)
        raise QuoteError(502, 'Search provider returned invalid data.') from None


class StockSearch:
    def __init__(self, client, *, budget, enabled=False, api_key='', clock=time.monotonic,
                 utcnow=lambda: datetime.now(timezone.utc)):
        self.client, self.budget, self.enabled, self.api_key = client, budget, enabled, api_key
        self.clock, self.utcnow = clock, utcnow
        self.cache = OrderedDict()
        self.inflight = {}

    async def search(self, query: str) -> SearchResult:
        query = query_text(query)
        if not self.enabled or not self.api_key.strip():
            raise QuoteError(503, 'Stock search is disabled or unavailable.')
        cached = self.cache.get(query)
        if cached and self.clock() < cached[0]:
            self.cache.move_to_end(query)
            return cached[1].model_copy(update={'cache_hit': True})
        task = self.inflight.get(query)
        if task is None:
            if len(self.inflight) >= 3:
                raise QuoteError(503, 'Stock search is busy. Try again later.')
            task = asyncio.create_task(self._bounded_fetch(query))
            self.inflight[query] = task
            task.add_done_callback(lambda done: self._completed(query, done))
        return await asyncio.shield(task)

    def _completed(self, query, task):
        if self.inflight.get(query) is task:
            del self.inflight[query]
        if not task.cancelled():
            task.exception()

    async def close(self):
        tasks = list(self.inflight.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _bounded_fetch(self, query):
        try:
            return await asyncio.wait_for(self._fetch(query), DEADLINE)
        except (asyncio.TimeoutError, httpx.TimeoutException):
            raise QuoteError(504, 'Search provider timed out.') from None
        except httpx.RequestError:
            raise QuoteError(502, 'Search provider connection failed.') from None

    async def _fetch(self, query):
        self.budget.reserve()
        async with self.client.stream('GET', 'https://www.alphavantage.co/query',
                                      params={'function': 'SYMBOL_SEARCH', 'keywords': query,
                                              'datatype': 'json', 'apikey': self.api_key},
                                      follow_redirects=False) as response:
            if response.status_code == 429:
                raise QuoteError(429, 'Provider request quota reached.')
            if response.status_code != 200:
                raise QuoteError(502, 'Search provider unavailable.')
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_BYTES:
                    _diagnostic('body', 'none', 'size')
                    raise QuoteError(502, 'Search provider returned invalid data.')
        result = SearchResult(query=query, matches=parse_matches(bytes(body)), fetched_at=self.utcnow())
        self.cache[query] = (self.clock() + TTL, result)
        self.cache.move_to_end(query)
        while len(self.cache) > CAPACITY:
            self.cache.popitem(last=False)
        return result
