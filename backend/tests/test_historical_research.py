import json
import unittest
from datetime import date
from decimal import Decimal
from unittest.mock import call, patch

from pydantic import ValidationError

from app.historical_data import HistoricalInput, get_history
from app.historical_metrics import calculate_historical_metrics
from app.historical_research import HistoricalResearchInput, get_historical_metrics


class HistoricalResearchTests(unittest.TestCase):
    def request(self, **changes):
        return {'symbols': ['aapl', 'msft'], 'start_date': date(2025, 1, 1),
                'end_date': date(2025, 3, 31), **changes}

    def setUp(self):
        for transport, method in [('AsyncHTTPTransport', 'handle_async_request'),
                                  ('HTTPTransport', 'handle_request')]:
            guard = patch(f'httpx.{transport}.{method}', side_effect=AssertionError('No network allowed'))
            mocked = guard.start()
            self.addCleanup(guard.stop)
            self.addCleanup(mocked.assert_not_called)

    def test_normalization_ids_and_exactly_one_retrieval_each(self):
        with patch('app.historical_research.get_history', wraps=get_history) as retrieve:
            result = get_historical_metrics(self.request(symbols=['nvda', 'aapl', 'MsFt']))
            self.assertEqual(result.request.symbols, ['NVDA', 'AAPL', 'MSFT'])
            self.assertEqual([item.id for item in result.evidence], ['hm1', 'hm2', 'hm3'])
            self.assertEqual(retrieve.call_args_list, [
                call(HistoricalInput(symbol=symbol, start_date=date(2025, 1, 1), end_date=date(2025, 3, 31)))
                for symbol in ['NVDA', 'AAPL', 'MSFT']
            ])
        again = get_historical_metrics(self.request(symbols=['nvda', 'aapl', 'MsFt']))
        self.assertEqual([item.id for item in again.evidence], ['hm1', 'hm2', 'hm3'])
        self.assertEqual(again.errors, ())

    def test_entire_invalid_request_rejected_before_any_retrieval(self):
        changes = [
            {'symbols': []}, {'symbols': ['AAPL', 'MSFT', 'NVDA', 'AAPL']},
            {'symbols': ['AAPL', 'aapl']}, {'symbols': ['AAPL', 'TSLA']},
            {'symbols': ['AAPL', 1]}, {'symbols': 'AAPL'}, {'symbols': [' AAPL']},
            {'extra': True}, {'interval': 'daily'}, {'end_date': date(2024, 12, 31)},
            {'end_date': date(2027, 1, 1)}, {'start_date': True}, {'start_date': '2025-02-30'},
        ]
        with patch('app.historical_research.get_history') as retrieve, patch(
            'app.historical_research.calculate_historical_metrics',
        ) as calculate:
            for change in changes:
                with self.subTest(change=change), self.assertRaises(ValidationError):
                    get_historical_metrics(self.request(**change))
            for missing in ['symbols', 'start_date', 'end_date']:
                data = self.request()
                del data[missing]
                with self.assertRaises(ValidationError):
                    get_historical_metrics(data)
            retrieve.assert_not_called()
            calculate.assert_not_called()

    def test_iso_json_input_and_existing_calendar_bounds(self):
        validated = HistoricalResearchInput.model_validate_json(
            '{"symbols":["aapl"],"start_date":"2024-02-29","end_date":"2026-02-27"}',
        )
        self.assertEqual(get_historical_metrics(validated).request.symbols, ['AAPL'])
        for end in ['2026-02-28', '2025-02-29']:
            with self.assertRaises(ValidationError):
                HistoricalResearchInput.model_validate_json(json.dumps({
                    'symbols': ['AAPL'], 'start_date': '2024-02-29', 'end_date': end,
                }))

    def test_mutated_request_is_revalidated(self):
        request = HistoricalResearchInput(**self.request())
        request.symbols.append('TSLA')
        with patch('app.historical_research.get_history') as retrieve, self.assertRaises(ValidationError):
            get_historical_metrics(request)
        retrieve.assert_not_called()

    def test_values_windows_units_and_provenance_match_existing_services(self):
        result = get_historical_metrics(self.request())
        for item in result.evidence:
            expected = calculate_historical_metrics(get_history(HistoricalInput(
                symbol=item.provenance.symbol, start_date=result.request.start_date,
                end_date=result.request.end_date,
            )))
            for field in ['price_change', 'sma_20', 'sma_50', 'adjacent_return_volatility_20']:
                self.assertEqual(getattr(item, field), getattr(expected, field))
                self.assertIsInstance(getattr(item, field).value, Decimal)
                self.assertIsInstance(item.model_dump(mode='json')[field]['value'], str)
            self.assertEqual(item.origin, 'backend')
            self.assertEqual(item.volatility_return_count, expected.volatility_return_count)
            self.assertEqual(item.limitations, expected.limitations)
            self.assertEqual(item.provenance.requested_range, expected.history.requested_range)
            self.assertEqual(item.provenance.returned_range, expected.history.returned_range)
            self.assertEqual(item.provenance.fixture_range, expected.history.fixture_range)
            self.assertEqual(item.provenance.source, 'demo')
            self.assertEqual(item.provenance.data_kind, 'fictional')
            self.assertEqual(item.provenance.currency, 'USD')
            self.assertEqual(item.provenance.adjustment_basis, 'unknown')
            self.assertEqual(item.provenance.label, expected.history.label)
            self.assertIsNotNone(item.provenance.fetched_at.utcoffset())
        self.assertEqual(result.data_mode, 'fictional')
        self.assertIn('FICTIONAL', result.label)
        self.assertTrue(any('actual metric windows' in text for text in result.limitations))

    def test_short_empty_and_partial_history_are_evidence_not_errors(self):
        for start, end, status, coverage in [
            (date(2025, 1, 1), date(2025, 1, 1), 'ok', 'within_fixture'),
            (date(2025, 1, 4), date(2025, 1, 5), 'empty', 'within_fixture'),
            (date(2026, 1, 1), date(2026, 1, 2), 'empty', 'outside_fixture'),
            (date(2023, 12, 29), date(2024, 1, 2), 'ok', 'partial_overlap'),
        ]:
            with self.subTest(start=start):
                result = get_historical_metrics(self.request(start_date=start, end_date=end))
                self.assertEqual(len(result.evidence), 2)
                self.assertEqual(result.errors, ())
                for item in result.evidence:
                    self.assertEqual(item.provenance.status, status)
                    self.assertEqual(item.provenance.coverage, coverage)
                    self.assertEqual(item.sma_20.status, 'unavailable')
                    self.assertIsNone(item.sma_20.value)
                    self.assertIsNone(item.sma_20.window)
                    self.assertTrue(item.sma_20.reason)
                    if status == 'empty':
                        self.assertIsNone(item.provenance.returned_range)
                        self.assertIsNone(item.price_change.value)
                    if coverage != 'within_fixture':
                        self.assertTrue(any('not fully covered' in text for text in item.limitations))

    def test_output_excludes_raw_bars_and_preserves_fetch_timestamp(self):
        source = get_history(HistoricalInput(symbol='AAPL', start_date=date(2024, 1, 1),
                                            end_date=date(2025, 12, 31)))
        with patch('app.historical_research.get_history', return_value=source):
            result = get_historical_metrics(self.request(symbols=['AAPL'],
                                                         start_date=date(2024, 1, 1), end_date=date(2025, 12, 31)))
        self.assertEqual(result.evidence[0].provenance.fetched_at, source.fetched_at)
        serialized = result.model_dump_json()
        for key in ['bars', 'open', 'high', 'low', 'close', 'volume', 'history']:
            self.assertNotIn(f'"{key}":', serialized)
        self.assertLess(len(serialized), len(source.model_dump_json()))

    def test_unexpected_errors_propagate_without_partial_success(self):
        first = get_history(HistoricalInput(symbol='AAPL', start_date=date(2025, 1, 1),
                                           end_date=date(2025, 3, 31)))
        for error in [RuntimeError('internal failure'), ValueError('broken invariant')]:
            with patch('app.historical_research.get_history', side_effect=[first, error]), self.assertRaises(type(error)):
                get_historical_metrics(self.request())
        with patch('app.historical_research.calculate_historical_metrics', side_effect=RuntimeError('bug')), \
                self.assertRaises(RuntimeError):
            get_historical_metrics(self.request())

    def test_wrong_symbol_or_requested_range_cannot_become_evidence(self):
        for symbol, start in [('NVDA', date(2025, 1, 1)), ('AAPL', date(2025, 1, 2))]:
            source = get_history(HistoricalInput(symbol=symbol, start_date=start, end_date=date(2025, 3, 31)))
            with patch('app.historical_research.get_history', return_value=source), self.assertRaises(ValueError):
                get_historical_metrics(self.request())


if __name__ == '__main__':
    unittest.main()
