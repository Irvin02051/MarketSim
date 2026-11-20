"""Synthetic discovery/history fixtures; no live requests or real credentials."""
import asyncio
import unittest
from datetime import date
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from pydantic import ValidationError
from test_real_history import payload
from test_stock_search import body, row

from app.main import app
from app.market_data import TTL, MarketData, ProviderBudget, QuoteError
from app.real_history import (
    CACHE_CAPACITY,
    INFLIGHT_CAPACITY,
    HistoricalService,
    HistoryError,
    HistoryRequest,
    RealHistoryResult,
)
from app.real_history_metrics import calculate_real_history_metrics
from app.stock_search import CAPACITY, StockSearch
from app.stock_search import TTL as SEARCH_TTL

START, END = date(2026, 10, 23), date(2026, 10, 28)
KEY = 'synthetic-discovery-key'


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict('os.environ', {'STOCK_SEARCH_ENABLED': 'true', 'REAL_HISTORY_ENABLED': 'true',
                                           'MARKET_DATA_PROVIDER': 'demo', 'RESEARCH_ENABLED': 'false',
                                           'ALPHA_VANTAGE_API_KEY': KEY}, clear=True)
        self.env.start(); self.addCleanup(self.env.stop)
        self.calls = []
        self.history_symbol = None
        async def transport(transport, req):
            self.calls.append(dict(req.url.params))
            if req.url.params['function'] == 'SYMBOL_SEARCH':
                return httpx.Response(200, content=body(row('NEW.A'), row('FUND', **{'3. type': 'ETF'})))
            return httpx.Response(200, json=payload(self.history_symbol or req.url.params['symbol']))
        self.mock = patch('httpx.AsyncHTTPTransport.handle_async_request', transport)
        self.mock.start(); self.addCleanup(self.mock.stop)
        self.client = TestClient(app); self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def search(self):
        response = self.client.get('/api/stocks/search', params={'q': 'Synthetic'})
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual([m['symbol'] for m in result['matches']], ['NEW.A'])
        return result['selection_ref']

    def history(self, ref, **changes):
        params = {'selection_ref': ref, 'symbol': 'NEW.A', 'start_date': START.isoformat(), 'end_date': END.isoformat()}
        params.update(changes)
        return self.client.get('/api/stocks/discovered/history', params=params)

    def test_discovery_then_history_cache_and_original_boundaries(self):
        ref = self.search()
        first = self.history(ref)
        self.assertEqual(first.status_code, 200, first.text)
        result = first.json()
        self.assertEqual((result['symbol'], result['currency'], result['source'], result['adjustment_basis']),
                         ('NEW.A', 'USD', 'alpha_vantage', 'unadjusted'))
        self.assertIsNone(result['bars'][0]['volume'])
        self.assertFalse(result['cache_hit'])
        again = self.history(ref).json()
        self.assertTrue(again['cache_hit'])
        self.assertEqual(again['bars'], result['bars'])
        self.assertEqual(again['fetched_at'], result['fetched_at'])
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[1]['symbol'], 'NEW.A')
        self.assertEqual(len(app.state.market_data.budget.attempts), 2)
        with self.assertRaises(ValidationError):
            RealHistoryResult.model_validate_json(first.text)
        for route in ['/api/stocks/NEW.A/quote', '/api/stocks/NEW.A/history',
                      '/api/stocks/NEW.A/history/provider', '/api/stocks/NEW.A/history/provider/metrics']:
            self.assertIn(self.client.get(route, params={'start_date': str(START), 'end_date': str(END)}).status_code, (400, 404, 422))
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.client.get('/api/stocks/AAPL/history', params={'start_date': '2025-01-01', 'end_date': '2025-01-03'}).json()['source'], 'demo')
        self.assertEqual(self.client.get('/health').status_code, 200)

    def test_invalid_evidence_and_client_metadata_never_fetch(self):
        ref = self.search()
        for value, changes, status in [('', {}, 409), ('forged', {}, 409), (ref, {'symbol': 'FUND'}, 409),
                                      (ref, {'symbol': 'new.a'}, 409), (ref, {'currency': 'USD'}, 422),
                                      (ref, {'region': 'United States'}, 422), (ref, {'name': 'Synthetic'}, 422),
                                      (ref, {'start_date': '20261023'}, 422), (ref, {'end_date': '2027-10-28'}, 422),
                                      (ref, {'start_date': '2026-10-29'}, 422)]:
            self.assertEqual(self.history(value, **changes).status_code, status)
        self.assertEqual(self.client.get('/api/stocks/discovered/history').status_code, 422)
        self.assertEqual(self.client.get('/api/stocks/discovered/history?selection_ref=x&selection_ref=y&symbol=NEW.A&start_date=2026-10-23&end_date=2026-10-28').status_code, 422)
        self.assertEqual(len(self.calls), 1)
        app.state.stock_search.clock = lambda: float('inf')
        self.assertEqual(self.history(ref).status_code, 409)
        self.assertEqual(len(self.calls), 1)

    def test_configuration_failure_mismatch_and_bounds(self):
        ref = self.search()
        app.state.real_history_enabled = False
        self.assertEqual(self.history(ref).status_code, 503)
        app.state.real_history_enabled = True
        app.state.stock_search.enabled = False
        self.assertEqual(self.history(ref).status_code, 503)
        app.state.stock_search.enabled = True
        app.state.historical_data.api_key = ''
        self.assertEqual(self.history(ref).status_code, 503)
        self.assertEqual(len(self.calls), 1)
        app.state.historical_data.api_key = KEY
        self.history_symbol = 'OTHER'
        failed = self.history(ref)
        self.assertEqual(failed.status_code, 502)
        self.assertNotIn(KEY, failed.text)
        self.history_symbol = None
        unavailable = self.history(ref, start_date='2026-10-22')
        self.assertEqual(unavailable.status_code, 422)
        self.assertEqual(unavailable.json()['available_range'], {'start': str(START), 'end': str(END)})
        self.assertEqual(self.history(ref, start_date='2026-10-24', end_date='2026-10-25').json()['status'], 'empty')


class ResourceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now, self.calls = 0, []
        async def transport(req):
            self.calls.append(req)
            if req.url.params['function'] == 'SYMBOL_SEARCH':
                return httpx.Response(200, content=body(row(req.url.params['keywords'])))
            return httpx.Response(200, json=payload(req.url.params['symbol']))
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
        self.budget = ProviderBudget(lambda: self.now)
        self.search = StockSearch(self.client, budget=self.budget, enabled=True, api_key=KEY, clock=lambda: self.now)
        self.history = HistoricalService(self.client, budget=self.budget, mode='alpha_vantage', api_key=KEY, clock=lambda: self.now)

    async def asyncTearDown(self):
        await self.search.close(); await self.history.close(); await self.client.aclose()

    async def selected(self, symbol):
        result = await self.search.search(symbol)
        return result, self.search.resolve(result.selection_ref, symbol)

    async def test_reference_expiry_eviction_and_restart(self):
        result, selected = await self.selected('NEW-A')
        self.assertEqual(selected.symbol, 'NEW-A')
        self.assertEqual((await self.search.search('NEW-A')).selection_ref, result.selection_ref)
        self.now = SEARCH_TTL
        with self.assertRaises(QuoteError):
            self.search.resolve(result.selection_ref, 'NEW-A')
        fresh, _ = await self.selected('NEW-A')
        self.assertNotEqual(fresh.selection_ref, result.selection_ref)
        # Exercise the real capacity with time progressing beyond the shared budget window.
        for i in range(CAPACITY):
            self.now += 86401
            await self.selected(f'S{i}')
        self.assertEqual(len(self.search.cache), CAPACITY)
        with self.assertRaises(QuoteError):
            self.search.resolve(fresh.selection_ref, 'NEW-A')
        restart = StockSearch(self.client, budget=self.budget, enabled=True, api_key=KEY)
        with self.assertRaises(QuoteError):
            restart.resolve(fresh.selection_ref, 'NEW-A')
        await restart.close()

    async def test_unexpired_selection_eviction_and_shared_original_snapshot(self):
        with patch('app.stock_search.CAPACITY', 2):
            first, _ = await self.selected('FIRST')
            await self.selected('SECOND')
            await self.selected('THIRD')
            self.assertEqual(self.now, 0)
            with self.assertRaises(QuoteError) as evicted:
                self.search.resolve(first.selection_ref, 'FIRST')
            self.assertEqual(evicted.exception.status, 409)
        _, selection = await self.selected('AAPL')
        discovered = await self.history.get_discovered_history(selection, START, END)
        calls = len(self.calls)
        original = await self.history.get_history(HistoryRequest(symbol='AAPL', start_date=START, end_date=END))
        self.assertIsInstance(original, RealHistoryResult)
        self.assertTrue(original.cache_hit)
        self.assertEqual(original.fetched_at, discovered.fetched_at)
        self.assertEqual(original.bars, discovered.bars)
        self.assertEqual(len(self.calls), calls)

    async def test_history_bounds_cache_expiry_and_metrics_boundary(self):
        _, selection = await self.selected('NEW/A')
        first = await self.history.get_discovered_history(selection, START, END)
        with self.assertRaises(TypeError):
            calculate_real_history_metrics(first)
        with self.assertRaises(ValidationError):
            HistoryRequest(symbol='NEW/A', start_date=START, end_date=END)
        self.assertTrue((await self.history.get_discovered_history(selection, START, END)).cache_hit)
        self.now = TTL
        self.assertFalse((await self.history.get_discovered_history(selection, START, END)).cache_hit)
        for i in range(CACHE_CAPACITY):
            self.now += 86401
            _, next_selection = await self.selected(f'S{i}')
            await self.history.get_discovered_history(next_selection, START, END)
        self.assertEqual(len(self.history.cache), CACHE_CAPACITY)
        self.assertNotIn('NEW/A', self.history.cache)

    async def test_coalescing_inflight_limit_cancellation_and_shutdown(self):
        selections = [(await self.selected(f'S{i}'))[1] for i in range(4)]
        entered, release = asyncio.Event(), asyncio.Event()
        original = self.history._read
        async def read(symbol):
            entered.set(); await release.wait()
            return await original(symbol)
        with patch.object(self.history, '_read', read):
            first = asyncio.create_task(self.history.get_discovered_history(selections[0], START, END))
            await entered.wait()
            duplicate = asyncio.create_task(self.history.get_discovered_history(selections[0], START, END))
            other = [asyncio.create_task(self.history.get_discovered_history(s, START, END)) for s in selections[1:3]]
            await asyncio.sleep(0)
            self.assertEqual(len(self.history.inflight), INFLIGHT_CAPACITY)
            with self.assertRaises(HistoryError) as busy:
                await self.history.get_discovered_history(selections[3], START, END)
            self.assertEqual(busy.exception.status, 503)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            release.set()
            results = await asyncio.gather(duplicate, *other)
            self.assertEqual(results[0].symbol, 'S0')
            self.assertEqual(len(self.budget.attempts), 7)  # Four searches, three histories.
            release.clear(); entered.clear()
            pending = asyncio.create_task(self.history.get_discovered_history(selections[3], START, END))
            await entered.wait(); await self.history.close()
            with self.assertRaises(asyncio.CancelledError):
                await pending
            self.assertEqual(self.history.inflight, {})
            self.assertEqual(self.history.cache, {})

    async def test_shared_budget_and_failed_attempts(self):
        _, selection = await self.selected('NEW')
        with patch.object(self.history, '_read', side_effect=httpx.ConnectError(KEY)), self.assertRaises(HistoryError) as failed:
            await self.history.get_discovered_history(selection, START, END)
        self.assertEqual(failed.exception.status, 502)
        self.assertEqual(len(self.budget.attempts), 2)
        self.budget.attempts.extend([self.now]*18)
        quote = MarketData(self.client, provider='alpha_vantage', api_key=KEY, budget=self.budget)
        for call in [lambda: self.history.get_discovered_history(selection, START, END),
                     lambda: self.search.search('OTHER'), lambda: quote.get_quote('AAPL')]:
            with self.assertRaises(QuoteError) as limited:
                await call()
            self.assertEqual(limited.exception.status, 429)
        self.assertEqual(len(self.calls), 1)
        await quote.close()
