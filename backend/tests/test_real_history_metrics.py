"""Self-authored prices only; these tests do not retrieve market observations."""

import json
import math
import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_UP, Decimal, Inexact, localcontext
from unittest.mock import patch

from pydantic import ValidationError

from app.historical_data import DailyBar, DateRange, HistoricalInput, get_history
from app.historical_metrics import calculate_historical_metrics
from app.real_history import RealHistoryResult
from app.real_history_metrics import calculate_real_history_metrics


def history(prices, *, dates=None):
    dates = dates if dates is not None else [date(2026, 1, 2) + timedelta(days=i)
                                            for i in range(len(prices))]
    return RealHistoryResult(
        symbol='AAPL', requested_range=DateRange(start=date(2026, 1, 1), end=date(2026, 3, 30)),
        available_range=DateRange(start=date(2025, 12, 1), end=date(2026, 4, 1)),
        returned_range=DateRange(start=dates[0], end=dates[-1]) if dates else None,
        status='ok' if prices else 'empty', fetched_at=datetime(2026, 4, 2, tzinfo=timezone.utc),
        cache_hit=True, provider_timezone='America/New_York',
        bars=tuple(DailyBar(date=day, open=float(price), high=float(price),
                            low=float(price), close=float(price), volume=None)
                   for day, price in zip(dates, prices)),
    )


class RealHistoryMetricsTests(unittest.TestCase):
    def test_positive_negative_zero_change_and_serialization(self):
        for closes, expected in [([100, 125], '25.000000'), ([100, 75], '-25.000000'),
                                 ([100, 100], '0.000000')]:
            with self.subTest(closes=closes):
                source = history(closes)
                metric = calculate_real_history_metrics(source).raw_price_change
                self.assertEqual(json.loads(metric.model_dump_json())['value'], expected)
                self.assertEqual(metric.window, source.returned_range)
                self.assertEqual(metric.unit, 'percent')
                self.assertEqual(metric.observation_count, 2)

    def test_average_boundaries_and_latest_only(self):
        for count, field in [(20, 'raw_sma_20'), (50, 'raw_sma_50')]:
            with self.subTest(count=count):
                short = calculate_real_history_metrics(history(list(range(1, count))))
                self.assertEqual(getattr(short, field).status, 'unavailable')
                exact = calculate_real_history_metrics(history(list(range(1, count + 1))))
                self.assertEqual(getattr(exact, field).value, Decimal(count + 1) / 2)
                source = history([10000] + list(range(1, count + 1)))
                metric = getattr(calculate_real_history_metrics(source), field)
                self.assertEqual(metric.value, Decimal(count + 1) / 2)
                self.assertEqual(metric.window.start, source.bars[1].date)
                self.assertEqual(metric.window.end, source.bars[-1].date)
                self.assertEqual(metric.observation_count, count)
                self.assertEqual(metric.required_observations, count)
                self.assertEqual(metric.unit, 'USD')

    def test_sample_standard_deviation_and_latest_only(self):
        # Ten 0 and ten 1 returns: squared deviations sum to 5, sample variance 5/19.
        prices = [1]
        for _ in range(10):
            prices.extend([prices[-1], prices[-1] * 2])
        source = history([1000000] + prices)
        result = calculate_real_history_metrics(source)
        metric = result.raw_return_sample_stddev_20
        self.assertEqual(metric.value, Decimal('51.298918'))
        self.assertAlmostEqual(float(metric.value), math.sqrt(5 / 19) * 100, places=6)
        self.assertNotEqual(metric.value, Decimal(50))  # Population SD would be 50%.
        self.assertEqual(metric.window.start, source.bars[1].date)
        self.assertEqual(metric.observation_count, 21)
        self.assertEqual(metric.unit, 'percent')
        self.assertEqual(result.return_count, 20)

    def test_flat_prices_and_insufficient_counts(self):
        requirements = {'raw_price_change': 2, 'raw_sma_20': 20, 'raw_sma_50': 50,
                        'raw_return_sample_stddev_20': 21}
        for count in [0, 1, 2, 19, 20, 21, 49, 50]:
            result = calculate_real_history_metrics(history([100] * count))
            for name, required in requirements.items():
                with self.subTest(count=count, name=name):
                    metric = getattr(result, name)
                    self.assertEqual(metric.status, 'available' if count >= required else 'unavailable')
                    if count < required:
                        self.assertIsNone(metric.value)
                        self.assertIsNone(metric.window)
                        self.assertEqual(metric.observation_count, count)
                        self.assertEqual(metric.required_observations, required)
                        self.assertEqual(metric.reason, f'Requires {required} observations; received {count}.')
                    else:
                        self.assertEqual(metric.value, Decimal(100 if 'sma' in name else 0))
                        self.assertIsNone(metric.reason)
            self.assertEqual(result.return_count, 20 if count >= 21 else 0)

    def test_calendar_gaps_actual_windows(self):
        dates = [date(2026, 1, 2) + timedelta(days=4 * i) for i in range(21)]
        source = history([100] * 20 + [200], dates=dates)
        result = calculate_real_history_metrics(source)
        self.assertEqual(result.raw_return_sample_stddev_20.value, Decimal('22.360680'))
        self.assertEqual(result.raw_sma_20.value, Decimal(105))
        self.assertEqual(result.raw_return_sample_stddev_20.window, source.returned_range)
        self.assertEqual(result.raw_sma_20.window.start, dates[1])
        self.assertNotEqual(result.raw_price_change.window, source.requested_range)
        self.assertEqual(result.observation_count, 21)

    def test_synthetic_split_retains_discontinuity_not_investor_loss(self):
        # A hypothetical 2:1 split changes share counts, which this raw series does
        # not represent. These figures establish neither investor loss nor risk.
        result = calculate_real_history_metrics(history([100] * 10 + [50] * 11))
        payload = result.model_dump(mode='json')
        self.assertEqual(payload['raw_price_change']['value'], '-50.000000')
        self.assertEqual(payload['raw_sma_20']['value'], '72.500000')
        self.assertEqual(payload['raw_sma_50']['status'], 'unavailable')
        self.assertEqual(payload['raw_return_sample_stddev_20']['value'], '11.180340')
        self.assertFalse(result.corporate_actions_checked)
        self.assertTrue(any('not total return' in text for text in result.calculation_limitations))
        self.assertTrue(any('not a reliable investment-risk' in text for text in result.calculation_limitations))

    def test_provenance_compactness_determinism_and_immutability(self):
        source = history([100, 110])
        before = source.model_dump_json()
        result = calculate_real_history_metrics(source)
        for name in ['symbol', 'currency', 'source', 'data_kind', 'adjustment_basis', 'interval',
                     'requested_range', 'available_range', 'returned_range', 'fetched_at',
                     'cache_hit', 'provider_timezone', 'coverage', 'status']:
            self.assertEqual(getattr(result, name), getattr(source, name))
        self.assertEqual(result.source_limitations, source.limitations)
        self.assertEqual(result.origin, 'backend')
        self.assertEqual(result.calculation_basis, 'raw_closing_prices')
        self.assertEqual(result.calendar_completeness, 'not_verified')
        self.assertFalse(result.corporate_actions_checked)
        payload = result.model_dump(mode='json')
        self.assertNotIn('bars', payload)
        self.assertNotIn('history', payload)
        self.assertEqual(result.model_dump_json(), calculate_real_history_metrics(source).model_dump_json())
        self.assertEqual(before, source.model_dump_json())
        empty = calculate_real_history_metrics(history([]))
        self.assertIsNone(empty.returned_range)
        self.assertEqual(empty.status, 'empty')

    def test_decimal_rounding_and_ambient_context(self):
        for close, expected in [(1.2345665, '1.234566'), (1.2345675, '1.234568')]:
            result = calculate_real_history_metrics(history([close] * 20))
            self.assertEqual(result.model_dump(mode='json')['raw_sma_20']['value'], expected)
        result = calculate_real_history_metrics(history([.00001] + [5e-324] * 19))
        self.assertEqual(str(result.raw_sma_20.value), '0.000001')
        result = calculate_real_history_metrics(history([1, .999999999999]))
        self.assertEqual(str(result.raw_price_change.value), '0.000000')
        source = history([3, 7] * 10 + [3])
        expected = calculate_real_history_metrics(source).model_dump_json()
        # Exact variance is 8000/8379: no intermediate return quantization.
        self.assertEqual(calculate_real_history_metrics(source).raw_return_sample_stddev_20.value,
                         Decimal(f'{math.sqrt(8000 / 8379) * 100:.6f}'))
        with localcontext() as context:
            context.prec = 3
            context.rounding = ROUND_UP
            context.traps[Inexact] = True
            self.assertEqual(calculate_real_history_metrics(source).model_dump_json(), expected)

    def test_extreme_values_finite_and_accurate(self):
        source = history([5e-324, sys.float_info.max] * 11)
        result = calculate_real_history_metrics(source)
        expected_integer = (35953862697246314 * 10**615 - 1) * 100
        self.assertEqual(str(result.raw_price_change.value), f'{expected_integer}.000000')
        for name in ['raw_price_change', 'raw_sma_20', 'raw_return_sample_stddev_20']:
            self.assertTrue(getattr(result, name).value.is_finite())
        with patch('app.historical_metrics.CALCULATION_PRECISION', 2800):
            self.assertEqual(result.model_dump_json(), calculate_real_history_metrics(source).model_dump_json())

    def test_wrong_types_and_fictional_boundary(self):
        fictional = get_history(HistoricalInput(symbol='AAPL', start_date=date(2024, 1, 1),
                                                end_date=date(2024, 1, 3)))
        for wrong in [None, {}, history([100]).model_dump(), fictional]:
            with self.subTest(kind=type(wrong)), self.assertRaises(TypeError):
                calculate_real_history_metrics(wrong)
        with self.assertRaises(TypeError):
            calculate_historical_metrics(history([100]))

    def test_revalidates_constructed_copied_and_mutated_provenance(self):
        for field, wrong in [('source', 'demo'), ('data_kind', 'fictional'),
                             ('adjustment_basis', 'split_adjusted'), ('interval', 'weekly'),
                             ('symbol', 'GOOG'), ('currency', 'EUR')]:
            for method in ['construct', 'copy', 'mutate']:
                with self.subTest(field=field, method=method):
                    source = history([100, 110])
                    if method == 'construct':
                        values = dict(source)
                        values[field] = wrong
                        source = RealHistoryResult.model_construct(**values)
                    elif method == 'copy':
                        source = source.model_copy(update={field: wrong})
                    else:
                        object.__setattr__(source, field, wrong)
                    with self.assertRaises(ValidationError):
                        calculate_real_history_metrics(source)

    def test_revalidates_nested_bars_ranges_and_metadata(self):
        source = history([100, 110])
        updates = [
            {'bars': source.bars[::-1]}, {'bars': (source.bars[0], source.bars[0])},
            {'returned_range': None}, {'status': 'empty'},
            {'fetched_at': datetime(2026, 1, 1)}, {'provider_timezone': 'Not/AZone'},
            {'requested_range': DateRange(start=date(2026, 1, 1), end=date(2026, 4, 1))},
            {'available_range': DateRange(start=date(2026, 1, 3), end=date(2026, 4, 1))},
        ]
        for changes in updates:
            with self.subTest(fields=list(changes)), self.assertRaises(ValidationError):
                calculate_real_history_metrics(source.model_copy(update=changes))
        for field, wrong in [('close', float('nan')), ('high', 1.0), ('volume', True),
                             ('date', date(2025, 1, 1))]:
            with self.subTest(bar_field=field):
                mutated = history([100, 110])
                object.__setattr__(mutated.bars[0], field, wrong)
                with self.assertRaises(ValidationError):
                    calculate_real_history_metrics(mutated)
        mutated = history([100])
        object.__setattr__(mutated.requested_range, 'end', date(2025, 1, 1))
        with self.assertRaises(ValidationError):
            calculate_real_history_metrics(mutated)


if __name__ == '__main__':
    unittest.main()
