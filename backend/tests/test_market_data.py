import asyncio
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import httpx
from pydantic import ValidationError

from app.market_data import (
    TTL,
    WINDOW,
    MarketData,
    ProviderBudget,
    Quote,
    QuoteError,
    parse_quote,
)

NOW = datetime(2026, 10, 10, tzinfo=timezone.utc)
KEY = 'sentinel-secret-key'


def payload(symbol='AAPL'):
    # Self-authored parser fixture, not a captured provider response.
    return {'Global Quote': {
        '01. symbol': symbol, '03. high': '210', '04. low': '195',
        '05. price': '205', '06. volume': '1000', '07. latest trading day': '2026-10-09',
        '09. change': '5', '10. change percent': '2.5%',
    }}


class MarketDataTests(unittest.IsolatedAsyncioTestCase):
    def test_injected_budget_preserves_rolling_boundary(self):
        now = 0
        budget = ProviderBudget(lambda: now)
        for _ in range(20):
            budget.reserve()
        now = WINDOW - 1
        with self.assertRaises(QuoteError) as caught:
            budget.reserve()
        self.assertEqual(caught.exception.status, 429)
        now = WINDOW
        budget.reserve()
        self.assertEqual(list(budget.attempts), [WINDOW])

    async def asyncSetUp(self):
        self.now = 0.0
        self.calls = 0
        self.handler = lambda request: httpx.Response(200, json=payload(request.url.params['symbol']))

        async def transport(request):
            self.calls += 1
            self.assertEqual(request.url.host, 'www.alphavantage.co')
            self.assertEqual(request.url.path, '/query')
            self.assertEqual(request.url.params['function'], 'GLOBAL_QUOTE')
            self.assertNotIn('entitlement', request.url.params)
            result = self.handler(request)
            return await result if asyncio.iscoroutine(result) else result

        self.client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
        self.service = MarketData(self.client, provider='alpha_vantage', api_key=KEY,
                                  clock=lambda: self.now, utcnow=lambda: NOW)

    async def asyncTearDown(self):
        await self.service.close()
        await self.client.aclose()

    async def failure(self, expected):
        with self.assertRaises(QuoteError) as caught:
            await self.service.get_quote('AAPL')
        self.assertEqual(caught.exception.status, expected)
        self.assertNotIn(KEY, str(caught.exception))
        self.assertEqual(self.service.cache, {})

    async def test_default_demo_even_with_key(self):
        with patch.dict('os.environ', {'ALPHA_VANTAGE_API_KEY': KEY}, clear=True):
            service = MarketData(self.client, utcnow=lambda: NOW)
        for symbol in ('aapl', 'MSFT', 'NVDA'):
            quote = await service.get_quote(symbol)
            self.assertEqual(quote.source, 'demo')
            self.assertEqual(quote.data_kind, 'fictional')
        self.assertEqual(self.calls, 0)
        self.assertEqual(len(service.cache), 3)

    async def test_symbols_and_configuration(self):
        for symbol, status in [('A1', 400), (' AAPL', 400), ('ÄAPL', 400), ('', 400),
                               ('TOOLONG', 400), ('TSLA', 404)]:
            with self.assertRaises(QuoteError) as caught:
                await self.service.get_quote(symbol)
            self.assertEqual(caught.exception.status, status)
        self.service.api_key = ' '
        await self.failure(503)
        self.service.provider = 'unknown'
        await self.failure(503)
        self.assertEqual(self.calls, 0)
        self.assertEqual(len(self.service.attempts), 0)

    async def test_parse_and_cache_expiry(self):
        first = await self.service.get_quote('aapl')
        self.assertEqual(first.change_percent, 2.5)
        self.assertEqual(first.volume, 1000)
        self.assertEqual(first.currency, 'USD')
        self.assertEqual(first.data_kind, 'end_of_day')
        self.assertNotEqual(first.latest_trading_day, first.fetched_at.date())
        self.assertFalse(first.cache_hit)
        # Retrieval time advances, but a cached quote keeps all original metadata.
        self.service.utcnow = lambda: datetime(2026, 10, 11, tzinfo=timezone.utc)
        self.now = TTL - 1
        cached = await self.service.get_quote('AAPL')
        self.assertTrue(cached.cache_hit)
        self.assertEqual(cached.fetched_at, first.fetched_at)
        self.assertEqual(cached.model_dump(exclude={'cache_hit'}), first.model_dump(exclude={'cache_hit'}))
        self.assertEqual(self.calls, 1)
        self.assertEqual(len(self.service.attempts), 1)
        self.now = TTL
        self.assertFalse((await self.service.get_quote('AAPL')).cache_hit)
        self.assertEqual(self.calls, 2)

    def test_provenance_pairs(self):
        fields = parse_quote(payload(), 'AAPL', NOW).model_dump()
        for source, kind in [('demo', 'fictional'), ('alpha_vantage', 'end_of_day')]:
            Quote(**{**fields, 'source': source, 'data_kind': kind})
        for source, kind in [('demo', 'end_of_day'), ('alpha_vantage', 'fictional')]:
            with self.subTest(source=source), self.assertRaises(ValidationError):
                Quote(**{**fields, 'source': source, 'data_kind': kind})

    async def test_concurrent_requests_share_success_and_failure(self):
        for fail in (False, True):
            self.service.cache.clear()
            started, release = asyncio.Event(), asyncio.Event()

            async def delayed(request, started=started, release=release, fail=fail):
                started.set()
                await release.wait()
                return httpx.Response(500 if fail else 200, json=payload())

            self.handler = delayed
            before = self.calls
            tasks = [asyncio.create_task(self.service.get_quote('AAPL')) for _ in range(10)]
            await started.wait()
            await asyncio.sleep(0)
            release.set()
            results = await asyncio.gather(*tasks, return_exceptions=True)
            self.assertEqual(self.calls - before, 1)
            if fail:
                self.assertTrue(all(isinstance(result, QuoteError) for result in results))
            else:
                self.assertTrue(all(result.price == 205 for result in results))

    async def test_cancelled_caller_does_not_cancel_shared_call(self):
        started, release = asyncio.Event(), asyncio.Event()

        async def delayed(request):
            started.set()
            await release.wait()
            return httpx.Response(200, json=payload())

        self.handler = delayed
        first = asyncio.create_task(self.service.get_quote('AAPL'))
        await started.wait()
        second = asyncio.create_task(self.service.get_quote('AAPL'))
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        release.set()
        self.assertEqual((await second).price, 205)
        self.assertEqual(self.calls, 1)

    async def test_failure_budget_and_rolling_reset(self):
        self.handler = lambda request: httpx.Response(500, text=KEY)
        for _ in range(20):
            await self.failure(502)
        await self.failure(429)
        self.assertEqual(self.calls, 20)
        self.now = WINDOW - 1
        await self.failure(429)
        self.now = WINDOW
        await self.failure(502)
        self.assertEqual(self.calls, 21)

    async def test_cache_hit_works_when_budget_exhausted(self):
        await self.service.get_quote('AAPL')
        self.service.attempts.extend([self.now] * 19)
        self.assertTrue((await self.service.get_quote('AAPL')).cache_hit)
        with self.assertRaises(QuoteError):
            await self.service.get_quote('MSFT')
        self.assertEqual(self.calls, 1)

    async def test_expired_quote_not_returned_on_failure(self):
        await self.service.get_quote('AAPL')
        self.now = TTL
        self.handler = lambda request: httpx.Response(500)
        await self.failure(502)
        await self.failure(502)
        self.assertEqual(self.calls, 3)

    async def test_provider_errors(self):
        cases = [
            (httpx.Response(429, text=KEY), 429),
            (httpx.Response(403, text=KEY), 502),
            (httpx.Response(302, headers={'Location': 'https://example.com'}), 502),
            (httpx.Response(200, text='invalid ' + KEY), 502),
            (httpx.Response(200, json={'Global Quote': {}}), 502),
            (httpx.Response(200, json={'Note': 'API call frequency: 25 requests per day ' + KEY}), 429),
            (httpx.Response(200, json={'Information': 'Rate limit reached ' + KEY}), 429),
            (httpx.Response(200, json={'Information': 'Premium endpoint ' + KEY}), 502),
            (httpx.Response(200, json={'Error Message': KEY}), 502),
        ]
        for response, status in cases:
            self.handler = lambda request, response=response: response
            await self.failure(status)
        for error, status in [(httpx.ReadTimeout(KEY), 504), (httpx.ConnectError(KEY), 502)]:
            def fail(request, error=error):
                raise error
            self.handler = fail
            await self.failure(status)
        self.assertEqual(len(self.service.attempts), len(cases) + 2)

    def test_invalid_fields(self):
        for field, value in [
            ('01. symbol', 'MSFT'), ('05. price', 'nan'), ('05. price', 'inf'),
            ('05. price', '0'), ('05. price', True), ('09. change', '-inf'),
            ('10. change percent', 'nan%'), ('10. change percent', '2.5'),
            ('03. high', '190'), ('04. low', '-1'), ('06. volume', '-1'),
            ('06. volume', '1.5'), ('06. volume', True),
            ('07. latest trading day', '2026-02-30'),
            ('07. latest trading day', '2099-01-01'),
        ]:
            with self.subTest(field=field, value=value):
                data = payload()
                data['Global Quote'][field] = value
                with self.assertRaises(QuoteError):
                    parse_quote(data, 'AAPL', NOW)
        for data in [None, [], {}, {'Global Quote': {'01. symbol': 'AAPL'}}]:
            with self.assertRaises(QuoteError):
                parse_quote(data, 'AAPL', NOW)
