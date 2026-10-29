import unittest
from datetime import date, datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, call

import httpx
from pydantic import ValidationError
from test_market_data import payload

from app.market_data import MarketData, Quote, QuoteError
from app.research import QuotesInput, get_quotes


def quote(symbol='AAPL', **changes):
    fields = {
        'symbol': symbol, 'price': 205.0, 'change': 5.0, 'change_percent': 2.5,
        'high': 208.0, 'low': 198.0, 'volume': 100000,
        'latest_trading_day': date(2026, 1, 2), 'source': 'demo', 'data_kind': 'fictional',
        'fetched_at': datetime(2026, 10, 14, tzinfo=timezone.utc), 'cache_hit': True,
    }
    fields.update(changes)
    return Quote(**fields)


class ResearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_inputs_never_fetch(self):
        for request in [
            {}, {'symbols': []}, {'symbols': ['AAPL', 'MSFT', 'NVDA', 'AAPL']},
            {'symbols': ['AAPL', 'aapl']}, {'symbols': ['AAPL', 'TSLA']},
            {'symbols': ['AAPL', 'A1']}, {'symbols': ['AAPL', ' MSFT']},
            {'symbols': ['AAPL', 1]}, {'symbols': 'AAPL'},
            {'symbols': ['AAPL'], 'url': 'https://example.com'},
        ]:
            with self.subTest(request=request):
                service = AsyncMock(spec=MarketData)
                with self.assertRaises(ValidationError):
                    await get_quotes(service, request)
                service.get_quote.assert_not_called()

    async def test_mutated_input_is_revalidated(self):
        request = QuotesInput(symbols=['AAPL'])
        request.symbols.append('TSLA')
        service = AsyncMock(spec=MarketData)
        with self.assertRaises(ValidationError):
            await get_quotes(service, request)
        service.get_quote.assert_not_called()

    async def test_metadata_labels_and_single_fetch(self):
        original = quote()
        service = AsyncMock(spec=MarketData)
        service.get_quote.return_value = original
        result = await get_quotes(service, {'symbols': ['aapl']})
        service.get_quote.assert_awaited_once_with('AAPL')
        self.assertEqual(result.requested_symbols, ['AAPL'])
        self.assertIs(result.evidence[0].quote, original)
        self.assertEqual(result.evidence[0].quote.model_dump(), original.model_dump())
        self.assertTrue(result.evidence[0].fictional)
        self.assertEqual(result.data_mode, 'fictional')
        self.assertIn('FICTIONAL', result.label)
        self.assertIsNone(result.calculations.difference)
        self.assertIsNone(result.calculations.ranking)

    async def test_decimal_ranges_and_ordered_difference(self):
        service = AsyncMock(spec=MarketData)
        service.get_quote.side_effect = [quote(price=0.2, high=0.3, low=0.1),
                                         quote('MSFT', change_percent=-1.0)]
        result = await get_quotes(service, {'symbols': ['AAPL', 'MSFT']})
        self.assertEqual(service.get_quote.await_args_list, [call('AAPL'), call('MSFT')])
        self.assertEqual([e.id for e in result.evidence], ['q1', 'q2'])
        self.assertEqual(result.calculations.origin, 'backend')
        self.assertEqual(result.calculations.ranges[0].value, Decimal('0.2'))
        self.assertEqual(result.calculations.ranges[0].currency, 'USD')
        self.assertEqual(result.calculations.difference.value, Decimal('3.5'))
        self.assertEqual(result.calculations.difference.unit, 'percentage_points')
        self.assertEqual(result.calculations.difference.evidence_ids, ('q1', 'q2'))
        self.assertEqual(result.model_dump(mode='json')['calculations']['ranges'][0]['value'], '0.2')
        service.get_quote.side_effect = [quote('MSFT', change_percent=-1), quote()]
        reverse = await get_quotes(service, {'symbols': ['MSFT', 'AAPL']})
        self.assertEqual(reverse.calculations.difference.value, Decimal('-3.5'))
        self.assertEqual(reverse.calculations.ranking[0].evidence_ids, ['q2'])

    async def test_negative_ranking_and_explicit_ties(self):
        service = AsyncMock(spec=MarketData)
        service.get_quote.side_effect = [quote(change_percent=-5),
                                         quote('MSFT', change_percent=-1),
                                         quote('NVDA', change_percent=-1)]
        result = await get_quotes(service, {'symbols': ['AAPL', 'MSFT', 'NVDA']})
        self.assertEqual(service.get_quote.await_count, 3)
        top, bottom = result.calculations.ranking
        self.assertEqual((top.rank, top.evidence_ids, top.tied), (1, ['q2', 'q3'], True))
        self.assertEqual(top.change_percent, Decimal(-1))
        self.assertEqual((bottom.rank, bottom.evidence_ids, bottom.tied), (2, ['q1'], False))
        self.assertIsNone(result.calculations.difference)

    async def test_two_way_tie(self):
        service = AsyncMock(spec=MarketData)
        service.get_quote.side_effect = [quote(), quote('MSFT')]
        result = await get_quotes(service, {'symbols': ['AAPL', 'MSFT']})
        self.assertEqual(result.calculations.difference.value, Decimal(0))
        self.assertEqual(len(result.calculations.ranking), 1)
        self.assertTrue(result.calculations.ranking[0].tied)

    async def test_partial_failure_retains_evidence_and_ranges(self):
        service = AsyncMock(spec=MarketData)
        service.get_quote.side_effect = [QuoteError(502, 'private provider detail'), quote('MSFT')]
        result = await get_quotes(service, {'symbols': ['AAPL', 'MSFT']})
        self.assertEqual(service.get_quote.await_args_list, [call('AAPL'), call('MSFT')])
        self.assertEqual(result.evidence[0].quote.symbol, 'MSFT')
        self.assertEqual(len(result.calculations.ranges), 1)
        self.assertEqual(result.errors[0].symbol, 'AAPL')
        self.assertEqual(result.errors[0].status, 502)
        self.assertNotIn('private provider detail', result.model_dump_json())
        self.assertIsNone(result.calculations.difference)
        self.assertIsNone(result.calculations.ranking)
        self.assertTrue(any('not all' in reason for reason in result.limitations))

    async def test_all_failures_and_safe_error_mapping(self):
        for status in [400, 404, 429, 502, 503, 504, 500]:
            with self.subTest(status=status):
                service = AsyncMock(spec=MarketData)
                service.get_quote.side_effect = QuoteError(status, 'private provider detail')
                result = await get_quotes(service, {'symbols': ['AAPL', 'NVDA']})
                self.assertEqual(service.get_quote.await_count, 2)
                self.assertEqual(result.data_mode, 'unavailable')
                self.assertEqual(result.evidence, [])
                self.assertEqual(result.calculations.ranges, [])
                self.assertEqual(len(result.errors), 2)
                self.assertIsNone(result.calculations.ranking)
                self.assertIsNone(result.calculations.difference)
                self.assertNotIn('private provider detail', result.model_dump_json())

    async def test_mismatched_dates_suppress_comparisons(self):
        service = AsyncMock(spec=MarketData)
        service.get_quote.side_effect = [quote(), quote('MSFT', latest_trading_day=date(2026, 1, 3))]
        result = await get_quotes(service, {'symbols': ['AAPL', 'MSFT']})
        self.assertEqual(len(result.evidence), 2)
        self.assertEqual(len(result.calculations.ranges), 2)
        self.assertIsNone(result.calculations.difference)
        self.assertIsNone(result.calculations.ranking)
        self.assertTrue(any('trading dates differ' in reason for reason in result.limitations))

    async def test_provider_and_mixed_provenance(self):
        service = AsyncMock(spec=MarketData)
        provider = quote(source='alpha_vantage', data_kind='end_of_day')
        service.get_quote.return_value = provider
        result = await get_quotes(service, {'symbols': ['AAPL']})
        self.assertEqual(result.data_mode, 'provider_backed')
        self.assertFalse(result.evidence[0].fictional)
        self.assertIn('not verified', result.label)
        service.get_quote.side_effect = [provider, quote('MSFT')]
        result = await get_quotes(service, {'symbols': ['AAPL', 'MSFT']})
        self.assertEqual(result.data_mode, 'mixed')
        self.assertIn('FICTIONAL', result.label)
        self.assertTrue(result.evidence[1].fictional)

    async def test_unexpected_errors_propagate(self):
        service = AsyncMock(spec=MarketData)
        service.get_quote.side_effect = RuntimeError('internal failure')
        with self.assertRaises(RuntimeError):
            await get_quotes(service, {'symbols': ['AAPL']})

    async def test_existing_demo_service_reuses_cache_without_network(self):
        def no_network(request):
            self.fail('Demo service attempted a provider request')

        async with httpx.AsyncClient(transport=httpx.MockTransport(no_network)) as client:
            service = MarketData(client, provider='demo')
            try:
                first = await get_quotes(service, {'symbols': ['AAPL', 'MSFT', 'NVDA']})
                second = await get_quotes(service, {'symbols': ['AAPL', 'MSFT', 'NVDA']})
                self.assertTrue(all(not item.quote.cache_hit for item in first.evidence))
                self.assertTrue(all(item.quote.cache_hit for item in second.evidence))
                self.assertEqual(len(service.attempts), 0)
                self.assertEqual([r.value for r in first.calculations.ranges],
                                 [Decimal(10), Decimal(15), Decimal(13)])
                self.assertEqual(first.calculations.ranking[0].evidence_ids, ['q3'])
            finally:
                await service.close()

    async def test_provider_old_date_and_cached_evidence_keep_original_metadata(self):
        calls = []

        def transport(request):
            calls.append(request)
            data = payload()
            data['Global Quote']['07. latest trading day'] = '2025-01-02'
            return httpx.Response(200, json=data)

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            fetched = datetime(2026, 10, 27, tzinfo=timezone.utc)
            service = MarketData(client, provider='alpha_vantage', api_key='synthetic',
                                 utcnow=lambda: fetched)
            try:
                first = await get_quotes(service, {'symbols': ['AAPL']})
                fetched = datetime(2026, 10, 28, tzinfo=timezone.utc)
                second = await get_quotes(service, {'symbols': ['AAPL']})
                self.assertEqual(len(calls), 1)
                for result, cached in [(first, False), (second, True)]:
                    evidence = result.model_dump(mode='json')['evidence'][0]
                    self.assertEqual(result.data_mode, 'provider_backed')
                    self.assertFalse(evidence['fictional'])
                    self.assertEqual(evidence['quote']['source'], 'alpha_vantage')
                    self.assertEqual(evidence['quote']['data_kind'], 'end_of_day')
                    self.assertEqual(evidence['quote']['latest_trading_day'], '2025-01-02')
                    self.assertEqual(evidence['quote']['fetched_at'], '2026-10-27T00:00:00Z')
                    self.assertEqual(evidence['quote']['cache_hit'], cached)
                    self.assertIn('Fetch time does not establish market-data freshness.', result.limitations)
                    self.assertIn('not verified', result.label)
            finally:
                await service.close()
