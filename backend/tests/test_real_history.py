import asyncio
import json
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from pydantic import ValidationError
from test_market_data import payload as quote_payload

from app.historical_data import HistoricalResult
from app.historical_metrics import calculate_historical_metrics
from app.historical_research import get_historical_metrics
from app.main import app
from app.market_data import TTL, WINDOW, MarketData, ProviderBudget, QuoteError
from app.real_history import (
    MAX_BODY_BYTES,
    HistoricalService,
    HistoryError,
    HistoryRequest,
    parse_snapshot,
)

NOW = datetime(2026, 10, 29, tzinfo=timezone.utc)
KEY = 'synthetic-secret-not-a-real-key'


def payload(symbol='AAPL'):
    # Self-authored, unordered observations with gaps, not a captured response.
    return {'Meta Data': {'2. Symbol': symbol, '5. Time Zone': 'US/Eastern'},
            'Time Series (Daily)': {
                day: {'1. open': '100', '2. high': '110', '3. low': '90',
                      '4. close': close, '5. volume': volume}
                for day, close, volume in [('2026-10-28', '101', '42'),
                                           ('2026-10-23', '100', None),
                                           ('2026-10-26', '102', '0')]
            }}


def request(symbol='AAPL', start=date(2026, 10, 23), end=date(2026, 10, 28), **extra):
    return {'symbol': symbol, 'start_date': start, 'end_date': end, **extra}


class HistoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now, self.fetched, self.requests = 0, NOW, []
        self.handler = lambda req: httpx.Response(200, json=payload(req.url.params['symbol']))

        async def transport(req):
            self.requests.append(req)
            result = self.handler(req)
            return await result if asyncio.iscoroutine(result) else result

        self.client = httpx.AsyncClient(transport=httpx.MockTransport(transport), follow_redirects=True)
        self.budget = ProviderBudget(lambda: self.now)
        self.service = HistoricalService(self.client, budget=self.budget, mode='alpha_vantage',
                                         api_key=KEY, clock=lambda: self.now, utcnow=lambda: self.fetched)

    async def asyncTearDown(self):
        await self.service.close()
        await self.client.aclose()

    async def test_validation_before_fetch(self):
        for item in [request('TSLA'), request(' AAPL'), request(True), request(interval='weekly'),
                     request(extra=1), request(start=date(2026, 10, 29)),
                     request(start=date(2026, 1, 1), end=date(2026, 4, 1)),
                     request(start='2026-10-23'), {}, request(start=True)]:
            with self.subTest(item=item), self.assertRaises(ValidationError):
                await self.service.get_history(item)
        self.assertEqual(self.requests, [])
        self.assertEqual(len(self.budget.attempts), 0)
        valid = HistoryRequest.model_validate_json(
            '{"symbol":"aapl","start_date":"2026-01-01","end_date":"2026-03-31"}',
        )
        self.assertEqual(valid.symbol, 'AAPL')

    async def test_request_filtering_provenance_and_metrics_boundary(self):
        result = await self.service.get_history(request('aapl', start=date(2026, 10, 26)))
        req = self.requests[0]
        self.assertEqual(str(req.url).split('?')[0], 'https://www.alphavantage.co/query')
        self.assertEqual(dict(req.url.params), {'function': 'TIME_SERIES_DAILY', 'symbol': 'AAPL',
                                              'outputsize': 'compact', 'datatype': 'json', 'apikey': KEY})
        self.assertEqual([b.date for b in result.bars], [date(2026, 10, 26), date(2026, 10, 28)])
        self.assertEqual(result.returned_range.start, date(2026, 10, 26))
        self.assertEqual(result.available_range.start, date(2026, 10, 23))
        self.assertEqual((result.source, result.data_kind, result.adjustment_basis),
                         ('alpha_vantage', 'end_of_day', 'unadjusted'))
        self.assertEqual(result.provider_timezone, 'US/Eastern')
        self.assertEqual(result.fetched_at, NOW)
        self.assertEqual(result.coverage, 'within_snapshot_bounds')
        self.assertNotIn('fixture_range', result.model_dump())
        self.assertNotIn(KEY, result.model_dump_json())
        with self.assertRaises(TypeError):
            calculate_historical_metrics(result)
        with self.assertRaises(ValidationError):
            HistoricalResult.model_validate(result.model_dump())
        with self.assertRaises(ValidationError):
            type(result).model_validate({**result.model_dump(), 'returned_range': None})

    async def test_empty_gaps_and_unavailable_ranges(self):
        for start, end in [(date(2026, 10, 24), date(2026, 10, 25)),
                           (date(2026, 10, 27), date(2026, 10, 27))]:
            result = await self.service.get_history(request(start=start, end=end))
            self.assertEqual((result.status, result.bars, result.returned_range), ('empty', (), None))
        for start, end in [(date(2026, 10, 22), date(2026, 10, 28)),
                           (date(2026, 10, 23), date(2026, 10, 29)),
                           (date(2026, 9, 1), date(2026, 9, 2))]:
            with self.assertRaises(HistoryError) as caught:
                await self.service.get_history(request(start=start, end=end))
            self.assertEqual(caught.exception.status, 422)
            self.assertEqual(caught.exception.available_range.end, date(2026, 10, 28))
        self.assertEqual(len(self.requests), 1)

    async def test_demo_ignores_quote_configuration(self):
        with patch.dict('os.environ', {'MARKET_DATA_PROVIDER': 'alpha_vantage', 'ALPHA_VANTAGE_API_KEY': KEY}):
            demo = HistoricalService(self.client, budget=self.budget)
        try:
            result = await demo.get_history(request(start=date(2025, 1, 1), end=date(2025, 1, 5)))
            self.assertEqual((result.source, result.data_kind), ('demo', 'fictional'))
            self.assertEqual(self.requests, [])
            self.assertEqual(len(self.budget.attempts), 0)
        finally:
            await demo.close()

    async def test_cache_expiry_timestamp_and_no_accumulation(self):
        for symbol in ['AAPL', 'MSFT', 'NVDA']:
            await self.service.get_history(request(symbol))
        self.assertEqual(len(self.service.cache), 3)
        self.fetched = NOW + timedelta(hours=1)
        cached = await self.service.get_history(request())
        self.assertTrue(cached.cache_hit)
        self.assertEqual(cached.fetched_at, NOW)
        self.assertEqual(len(self.requests), 3)
        new = payload(); del new['Time Series (Daily)']['2026-10-23']
        self.handler = lambda req: httpx.Response(200, json=new)
        self.now = TTL
        with self.assertRaises(HistoryError) as caught:
            await self.service.get_history(request())
        self.assertEqual(caught.exception.available_range.start, date(2026, 10, 26))
        latest = await self.service.get_history(request(start=date(2026, 10, 26)))
        self.assertEqual(latest.fetched_at, self.fetched)
        self.assertEqual(len(self.requests), 4)
        self.now += TTL
        self.handler = lambda req: httpx.Response(500)
        with self.assertRaises(HistoryError):
            await self.service.get_history(request(start=date(2026, 10, 26)))
        self.assertNotIn('AAPL', self.service.cache)

    async def test_concurrent_subranges_and_cancelled_waiter(self):
        started, release = asyncio.Event(), asyncio.Event()

        async def delayed(req):
            started.set(); await release.wait()
            return httpx.Response(200, json=payload())

        self.handler = delayed
        first = asyncio.create_task(self.service.get_history(request()))
        await started.wait()
        second = asyncio.create_task(self.service.get_history(request(start=date(2026, 10, 26))))
        third = asyncio.create_task(self.service.get_history(request()))
        await asyncio.sleep(0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        release.set()
        results = await asyncio.gather(second, third)
        self.assertEqual([len(r.bars) for r in results], [2, 3])
        self.assertTrue(all(not r.cache_hit for r in results))
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(len(self.budget.attempts), 1)

    async def test_shutdown_cancels_fetch_and_closes_stream(self):
        entered, closed = asyncio.Event(), asyncio.Event()

        class WaitingStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                entered.set(); await asyncio.Event().wait()
                yield b''

            async def aclose(self):
                closed.set()

        self.handler = lambda req: httpx.Response(200, stream=WaitingStream())
        task = asyncio.create_task(self.service.get_history(request()))
        await entered.wait(); await self.service.close()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(closed.is_set())
        self.assertEqual(self.service.inflight, {})
        self.assertEqual(self.service.cache, {})
        with self.assertRaises(HistoryError):
            await self.service.get_history(request())

    async def test_shared_failure_and_abandoned_waiter_cleanup(self):
        started, release = asyncio.Event(), asyncio.Event()

        async def delayed(req):
            started.set()
            await release.wait()
            return httpx.Response(500, text=KEY)

        self.handler = delayed
        first = asyncio.create_task(self.service.get_history(request()))
        await started.wait()
        second = asyncio.create_task(self.service.get_history(request(start=date(2026, 10, 26))))
        await asyncio.sleep(0)
        release.set()
        results = await asyncio.gather(first, second, return_exceptions=True)
        self.assertTrue(all(isinstance(result, HistoryError) and result.status == 502 for result in results))
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.service.cache, {})
        started.clear(); release.clear()
        abandoned = asyncio.create_task(self.service.get_history(request()))
        await started.wait()
        abandoned.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await abandoned
        fetch = self.service.inflight['AAPL']
        release.set()
        await asyncio.gather(fetch, return_exceptions=True)
        await asyncio.sleep(0)
        self.assertEqual(self.service.inflight, {})

    async def test_shared_budget_failures_cache_and_reset(self):
        quote = MarketData(self.client, provider='alpha_vantage', api_key=KEY, budget=self.budget,
                           clock=lambda: self.now, utcnow=lambda: NOW)
        try:
            self.handler = lambda req: httpx.Response(200, json=quote_payload()) if (
                req.url.params['function'] == 'GLOBAL_QUOTE'
            ) else httpx.Response(200, json=payload())
            await quote.get_quote('AAPL'); await self.service.get_history(request())
            self.assertEqual(len(self.budget.attempts), 2)
            self.handler = lambda req: httpx.Response(500, text=KEY)
            for _ in range(18):
                with self.assertRaises(HistoryError):
                    await self.service.get_history(request('MSFT'))
            self.assertTrue((await quote.get_quote('AAPL')).cache_hit)
            self.assertTrue((await self.service.get_history(request())).cache_hit)
            for operation in [quote.get_quote('NVDA'), self.service.get_history(request('NVDA'))]:
                with self.assertRaises(QuoteError) as caught:
                    await operation
                self.assertEqual(caught.exception.status, 429)
            self.assertEqual(len(self.requests), 20)
            self.now = WINDOW
            with self.assertRaises(HistoryError) as caught:
                await self.service.get_history(request('MSFT'))
            self.assertEqual(caught.exception.status, 502)
            self.assertEqual(len(self.budget.attempts), 1)
        finally:
            await quote.close()

    async def test_safe_errors_no_retry_or_fallback(self):
        cases = [(httpx.Response(status, text=KEY), expected) for status, expected in
                 [(429, 429), (403, 502), (500, 502), (302, 502)]]
        cases += [(httpx.Response(200, content=b'not-json ' + KEY.encode()), 502),
                  (httpx.Response(200, json={'Information': 'Premium ' + KEY}), 502),
                  (httpx.Response(200, json={'Note': '25 requests per day ' + KEY}), 429)]
        for response, status in cases:
            self.handler = lambda req, response=response: response
            with self.assertRaises(HistoryError) as caught:
                await self.service.get_history(request())
            self.assertEqual(caught.exception.status, status)
            self.assertNotIn(KEY, str(caught.exception))
            self.assertEqual(self.service.cache, {})
        self.assertEqual(len(self.requests), len(cases))
        for error, status in [(httpx.ConnectError(KEY), 502), (httpx.ReadTimeout(KEY), 504)]:
            def fail(req, error=error):
                raise error
            self.handler = fail
            with self.assertRaises(HistoryError) as caught:
                await self.service.get_history(request())
            self.assertEqual(caught.exception.status, status)
            self.assertNotIn(KEY, str(caught.exception))
        self.service.api_key = ''
        before = len(self.requests)
        with self.assertRaises(HistoryError) as caught:
            await self.service.get_history(request())
        self.assertEqual(caught.exception.status, 503)
        self.service.mode = 'invalid'
        with self.assertRaises(HistoryError):
            await self.service.get_history(request())
        self.assertEqual(len(self.requests), before)

    async def test_total_deadline_headers_body_and_size_limit(self):
        for phase in ['headers', 'body', 'size']:
            closed = asyncio.Event()

            class Stream(httpx.AsyncByteStream):
                async def __aiter__(self, phase=phase):
                    if phase == 'body':
                        yield b'{'
                        await asyncio.Event().wait()
                    else:
                        yield b' ' * MAX_BODY_BYTES
                        yield b'!'

                async def aclose(self, closed=closed):
                    closed.set()

            async def handler(req, phase=phase, stream_type=Stream):
                if phase == 'headers':
                    await asyncio.Event().wait()
                return httpx.Response(200, stream=stream_type())

            self.handler = handler
            self.service.deadline = 0.01
            with self.subTest(phase=phase), self.assertRaises(HistoryError) as caught:
                await self.service.get_history(request())
            self.assertEqual(caught.exception.status, 502 if phase == 'size' else 504)
            self.assertEqual(self.service.cache, {})
            if phase != 'headers':
                self.assertTrue(closed.is_set())


class ParserTests(unittest.TestCase):
    def parse(self, data):
        return parse_snapshot(json.dumps(data).encode(), 'AAPL', NOW)

    def test_nullable_volume_and_unknown_timezone(self):
        data = payload(); del data['Time Series (Daily)']['2026-10-23']['5. volume']
        self.assertIsNone(self.parse(data).bars[0].volume)
        for value in [None, 'not/a/zone', True, {'secret': KEY}]:
            data['Meta Data']['5. Time Zone'] = value
            result = self.parse(data)
            self.assertIsNone(result.provider_timezone)
            self.assertNotIn(KEY, result.model_dump_json())

    def test_invalid_payloads_and_duplicate_date_keys(self):
        invalid = [None, [], {}, {'Meta Data': []}, payload('MSFT')]
        data = payload(); data['Meta Data'] = []; invalid.append(data)
        data = payload(); del data['Time Series (Daily)']['2026-10-28']['4. close']; invalid.append(data)
        for field in ['1. open', '2. high', '3. low', '4. close']:
            for value in [True, None, 100, 'nan', 'inf', '-1', '0']:
                data = payload(); data['Time Series (Daily)']['2026-10-28'][field] = value
                invalid.append(data)
        for value in [True, -1, 1.5, '1.5', '-1', '', 'nan']:
            data = payload(); data['Time Series (Daily)']['2026-10-28']['5. volume'] = value
            invalid.append(data)
        for change in [{'2. high': '99'}, {'3. low': '105'}]:
            data = payload(); data['Time Series (Daily)']['2026-10-28'].update(change)
            invalid.append(data)
        for day in ['2026-02-30', '2026-1-2', 'PRIVATE']:
            data = payload(); data['Time Series (Daily)'][day] = data['Time Series (Daily)'].pop('2026-10-28')
            invalid.append(data)
        data = payload(); data['Time Series (Daily)'] = {}; invalid.append(data)
        data = payload(); bar = data['Time Series (Daily)']['2026-10-28']
        data['Time Series (Daily)'] = {(date(2026, 1, 1) + timedelta(days=i)).isoformat(): bar for i in range(101)}
        invalid.append(data)
        for data in invalid:
            with self.subTest(data=data), self.assertRaises(HistoryError) as caught:
                self.parse(data)
            self.assertEqual(caught.exception.status, 502)
        body = json.dumps(payload()).replace('"2026-10-28":', '"2026-10-23":')
        with self.assertRaises(HistoryError):
            parse_snapshot(body.encode(), 'AAPL', NOW)

    def test_lifespan_shared_budget_routes_and_tools_still_fictional(self):
        with patch.dict('os.environ', {'MARKET_DATA_PROVIDER': 'alpha_vantage', 'RESEARCH_ENABLED': 'false'}), patch(
            'httpx.AsyncHTTPTransport.handle_async_request', side_effect=AssertionError('No network'),
        ) as network, TestClient(app) as client:
            self.assertIs(app.state.historical_data.budget, app.state.market_data.budget)
            self.assertEqual(app.state.historical_data.mode, 'demo')
            response = client.get('/api/stocks/AAPL/history?start_date=2025-01-01&end_date=2025-01-05')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['source'], 'demo')
            result = get_historical_metrics({'symbols': ['AAPL'], 'start_date': date(2025, 1, 1),
                                             'end_date': date(2025, 1, 5)})
            self.assertEqual(result.data_mode, 'fictional')
            network.assert_not_called()
        self.assertTrue(app.state.historical_data.closed)
