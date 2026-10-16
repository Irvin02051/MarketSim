import unittest
from datetime import date, datetime

from pydantic import ValidationError

from app.historical_data import DailyBar, HistoricalInput, HistoricalResult, get_history


class HistoricalDataTests(unittest.TestCase):
    def request(self, **overrides):
        return {'symbol': 'AAPL', 'start_date': date(2024, 1, 1),
                'end_date': date(2024, 1, 5), **overrides}

    def test_supported_symbols_and_normalization(self):
        for symbol, opening in [('aapl', 179.65), ('msft', 349.65), ('nvda', 89.65)]:
            with self.subTest(symbol=symbol):
                result = get_history(self.request(symbol=symbol))
                self.assertEqual(result.symbol, symbol.upper())
                self.assertEqual(result.bars[0].open, opening)

    def test_invalid_requests(self):
        for override in [
            {'symbol': 'TSLA'}, {'symbol': ' AAPL'}, {'symbol': True},
            {'symbol': ''}, {'symbol': 'ＡＡＰＬ'}, {'interval': 'weekly'},
            {'extra': 1}, {'start_date': date(2024, 1, 6)},
            {'start_date': True}, {'end_date': datetime(2024, 1, 5)},
            {'end_date': date(2026, 1, 1)},
        ]:
            with self.subTest(override=override), self.assertRaises(ValidationError):
                get_history(self.request(**override))
        with self.assertRaises(ValidationError):
            get_history({'symbol': 'AAPL'})

    def test_two_calendar_year_boundary_and_iso_json(self):
        request = HistoricalInput.model_validate_json(
            '{"symbol":"AAPL","start_date":"2024-01-01","end_date":"2025-12-31"}',
        )
        self.assertEqual(len(get_history(request).bars), 523)
        get_history(self.request(start_date=date(2024, 2, 29), end_date=date(2026, 2, 27)))
        with self.assertRaises(ValidationError):
            get_history(self.request(start_date=date(2024, 2, 29), end_date=date(2026, 2, 28)))

    def test_deterministic_values_and_subrange_consistency(self):
        first = get_history(self.request())
        second = get_history(self.request())
        self.assertEqual(first.bars, second.bars)
        self.assertEqual(first.bars[0].model_dump(), {
            'date': date(2024, 1, 1), 'open': 179.65, 'high': 180.65,
            'low': 178.38, 'close': 179.38, 'volume': None,
        })
        self.assertEqual(first.bars[1].volume, 100101)
        subset = get_history(self.request(start_date=date(2024, 1, 2), end_date=date(2024, 1, 3)))
        self.assertEqual(subset.bars, first.bars[1:3])
        self.assertEqual(subset.returned_range.start, date(2024, 1, 2))
        self.assertEqual(subset.returned_range.end, date(2024, 1, 3))

    def test_empty_weekend_and_outside_intervals(self):
        for start, end, coverage in [
            (date(2024, 1, 6), date(2024, 1, 7), 'within_fixture'),
            (date(2023, 1, 1), date(2023, 12, 31), 'outside_fixture'),
            (date(2026, 1, 1), date(2026, 1, 2), 'outside_fixture'),
        ]:
            with self.subTest(start=start):
                result = get_history(self.request(start_date=start, end_date=end))
                self.assertEqual(result.status, 'empty')
                self.assertEqual(result.coverage, coverage)
                self.assertEqual(result.bars, ())
                self.assertIsNone(result.returned_range)

    def test_partial_coverage_and_no_gap_filling(self):
        for start, end, first, last in [
            (date(2023, 12, 30), date(2024, 1, 2), date(2024, 1, 1), date(2024, 1, 2)),
            (date(2025, 12, 30), date(2026, 1, 2), date(2025, 12, 30), date(2025, 12, 31)),
        ]:
            result = get_history(self.request(start_date=start, end_date=end))
            self.assertEqual(result.coverage, 'partial_overlap')
            self.assertEqual([bar.date for bar in result.bars], [first, last])
            self.assertEqual(result.requested_range.start, start)
            self.assertEqual(result.requested_range.end, end)
        result = get_history(self.request(end_date=date(2024, 1, 8)))
        self.assertEqual(len(result.bars), 6)
        self.assertTrue(all(bar.date.weekday() < 5 for bar in result.bars))

    def test_provenance_and_labels(self):
        result = get_history(self.request())
        self.assertEqual((result.source, result.data_kind, result.adjustment_basis),
                         ('demo', 'fictional', 'unknown'))
        self.assertIn('FICTIONAL', result.label)
        self.assertEqual(result.observation_calendar, 'synthetic_weekdays')
        self.assertEqual(result.fixture_range.start, date(2024, 1, 1))
        self.assertEqual(result.fixture_range.end, date(2025, 12, 31))
        self.assertIsNotNone(result.fetched_at.utcoffset())
        self.assertTrue(any('do not reconcile' in item for item in result.limitations))
        self.assertTrue(any('not actual trading dates' in item for item in result.limitations))

    def test_reject_invalid_prices_and_ohlc(self):
        bar = get_history(self.request()).bars[0].model_dump()
        for field in ['open', 'high', 'low', 'close']:
            for value in [True, False, 0, -1, float('nan'), float('inf'), -float('inf'), '180']:
                with self.subTest(field=field, value=value), self.assertRaises(ValidationError):
                    DailyBar.model_validate({**bar, field: value})
        for override in [{'open': 181.0}, {'close': 178.0}, {'low': 181.0}, {'high': 178.0}]:
            with self.subTest(override=override), self.assertRaises(ValidationError):
                DailyBar.model_validate({**bar, **override})

    def test_volume_is_optional_strict_nonnegative_integer(self):
        bar = get_history(self.request()).bars[0].model_dump()
        for value in [None, 0, 123]:
            self.assertEqual(DailyBar.model_validate({**bar, 'volume': value}).volume, value)
        for value in [True, False, -1, 1.5, 1.0, '100', float('nan')]:
            with self.subTest(value=value), self.assertRaises(ValidationError):
                DailyBar.model_validate({**bar, 'volume': value})

    def test_reject_duplicate_out_of_order_and_out_of_range_bars(self):
        result = get_history(self.request()).model_dump()
        bars = result['bars']
        for invalid in [(bars[0], *bars), tuple(reversed(bars)),
                        ({**bars[0], 'date': date(2023, 12, 29)}, *bars[1:])]:
            with self.subTest(bars=invalid), self.assertRaises(ValidationError):
                HistoricalResult.model_validate({**result, 'bars': invalid})

    def test_reject_inconsistent_metadata(self):
        result = get_history(self.request()).model_dump()
        for override in [
            {'returned_range': None}, {'status': 'empty'}, {'coverage': 'outside_fixture'},
            {'fetched_at': datetime(2024, 1, 1)}, {'source': 'live'},
            {'data_kind': 'real'}, {'adjustment_basis': 'adjusted'},
            {'fixture_range': {'start': date(2023, 1, 1), 'end': date(2025, 12, 31)}},
        ]:
            with self.subTest(override=override), self.assertRaises(ValidationError):
                HistoricalResult.model_validate({**result, **override})


if __name__ == '__main__':
    unittest.main()
