import json
import math
import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_UP, Decimal, Inexact, InvalidOperation, localcontext
from unittest.mock import patch

from app.historical_data import DailyBar, DateRange, HistoricalResult
from app.historical_metrics import calculate_historical_metrics


def history(prices, *, dates=None, partial=False):
    if dates is None:
        dates = []
        day = date(2024, 1, 1)
        while len(dates) < len(prices):
            if day.weekday() < 5:
                dates.append(day)
            day += timedelta(days=1)
    returned = DateRange(start=dates[0], end=dates[-1]) if dates else None
    return HistoricalResult(
        symbol='AAPL', requested_range=DateRange(
            start=date(2023, 12, 31) if partial else date(2024, 1, 1),
            end=dates[-1] if dates else date(2024, 1, 1),
        ), returned_range=returned, coverage='partial_overlap' if partial else 'within_fixture',
        status='ok' if prices else 'empty', fetched_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        bars=tuple(DailyBar(date=day, open=float(price), high=float(price),
                            low=float(price), close=float(price)) for day, price in zip(dates, prices)),
    )


class HistoricalMetricsTests(unittest.TestCase):
    def test_known_positive_negative_and_zero_change(self):
        for prices, expected in [([100, 125], '25.000000'), ([100, 75], '-25.000000'),
                                 ([100, 100], '0.000000')]:
            with self.subTest(prices=prices):
                source = history(prices)
                metric = calculate_historical_metrics(source).price_change
                self.assertEqual(metric.value, Decimal(expected))
                self.assertEqual(metric.unit, 'percent')
                self.assertEqual(metric.window, source.returned_range)
                self.assertEqual(metric.observation_count, 2)

    def test_moving_average_exact_boundaries(self):
        for count, field in [(20, 'sma_20'), (50, 'sma_50')]:
            with self.subTest(count=count):
                short = getattr(calculate_historical_metrics(history(list(range(1, count)))), field)
                self.assertEqual(short.status, 'unavailable')
                self.assertIsNone(short.value)
                source = history(list(range(1, count + 1)))
                metric = getattr(calculate_historical_metrics(source), field)
                # Mean of 1..n is (n+1)/2, independent of implementation.
                self.assertEqual(metric.value, Decimal(count + 1) / 2)
                self.assertEqual(metric.observation_count, count)
                self.assertEqual(metric.required_observations, count)
                self.assertEqual(metric.window, source.returned_range)
                self.assertEqual(metric.unit, 'USD')

    def test_only_latest_closes_contribute_to_averages(self):
        source = history([10000] + list(range(1, 51)))
        result = calculate_historical_metrics(source)
        self.assertEqual(result.sma_20.value, Decimal('40.5'))  # Mean of 31..50.
        self.assertEqual(result.sma_50.value, Decimal('25.5'))  # Mean of 1..50.
        self.assertEqual(result.sma_20.window.start, source.bars[-20].date)
        self.assertEqual(result.sma_50.window.start, source.bars[1].date)
        self.assertEqual(result.price_change.observation_count, 51)
        self.assertEqual(result.price_change.value, Decimal('-99.5'))

    def test_varying_return_sample_standard_deviation_and_latest_window(self):
        # Alternating 0% and 100% returns: mean=0.5, sum squared deviations=5.
        # Sample variance is 5/19, not population variance 5/20.
        prices = [1]
        for _ in range(10):
            prices.extend([prices[-1], prices[-1] * 2])
        source = history([1000000] + prices)
        result = calculate_historical_metrics(source)
        metric = result.adjacent_return_volatility_20
        self.assertEqual(metric.value, Decimal('51.298918'))
        self.assertAlmostEqual(float(metric.value), math.sqrt(5 / 19) * 100, places=6)
        self.assertEqual(metric.unit, 'percent')
        self.assertEqual(metric.observation_count, 21)
        self.assertEqual(result.volatility_return_count, 20)
        self.assertEqual(metric.window.start, source.bars[1].date)
        self.assertEqual(metric.window.end, source.bars[-1].date)

    def test_constant_prices_give_available_zero_volatility(self):
        result = calculate_historical_metrics(history([123.45] * 21))
        self.assertEqual(result.adjacent_return_volatility_20.status, 'available')
        self.assertEqual(result.adjacent_return_volatility_20.value, Decimal('0.000000'))
        self.assertEqual(result.sma_20.value, Decimal('123.450000'))
        self.assertIsNone(result.adjacent_return_volatility_20.reason)

    def test_repeating_returns_are_not_rounded_before_variance(self):
        # Ten returns of 4/3 and ten of -4/7. Each deviation has magnitude 20/21,
        # so exact sample variance = 20 * (20/21)^2 / 19 = 8000/8379.
        result = calculate_historical_metrics(history([3, 7] * 10 + [3]))
        expected = Decimal(f'{math.sqrt(8000 / 8379) * 100:.6f}')
        self.assertEqual(result.adjacent_return_volatility_20.value, expected)

    def test_insufficient_history_for_each_metric_including_empty_and_single(self):
        requirements = {'price_change': 2, 'sma_20': 20, 'sma_50': 50,
                        'adjacent_return_volatility_20': 21}
        for count in [0, 1, 19, 20, 21, 49, 50]:
            result = calculate_historical_metrics(history([100] * count))
            for field, required in requirements.items():
                with self.subTest(count=count, field=field):
                    metric = getattr(result, field)
                    self.assertEqual(metric.status, 'available' if count >= required else 'unavailable')
                    if count < required:
                        self.assertIsNone(metric.value)
                        self.assertIsNone(metric.window)
                        self.assertEqual(metric.observation_count, count)
                        self.assertEqual(metric.reason, f'Requires {required} observations; received {count}.')
            self.assertEqual(result.volatility_return_count, 20 if count >= 21 else 0)

    def test_calendar_gaps_are_not_filled(self):
        # 21 observations a week apart are still only 20 adjacent returns.
        dates = [date(2024, 1, 1) + timedelta(weeks=i) for i in range(21)]
        source = history([100] * 20 + [200], dates=dates)
        result = calculate_historical_metrics(source)
        # One return=1, nineteen=0: sample variance=0.05.
        self.assertEqual(result.adjacent_return_volatility_20.value, Decimal('22.360680'))
        self.assertEqual(result.sma_20.value, Decimal(105))
        self.assertEqual(result.adjacent_return_volatility_20.window, source.returned_range)
        self.assertEqual(len(result.history.bars), 21)

    def test_provenance_partial_coverage_and_purity(self):
        source = history([100] * 50, partial=True)
        before = source.model_dump_json()
        result = calculate_historical_metrics(source)
        self.assertEqual(result.history.model_dump_json(), before)
        self.assertEqual(source.model_dump_json(), before)
        self.assertEqual(result.origin, 'backend')
        self.assertEqual(result.history.coverage, 'partial_overlap')
        self.assertEqual(result.history.source, 'demo')
        self.assertEqual(result.history.data_kind, 'fictional')
        self.assertEqual(result.history.adjustment_basis, 'unknown')
        self.assertIn('FICTIONAL', result.history.label)
        self.assertEqual(result.limitations[:len(source.limitations)], source.limitations)
        self.assertTrue(any('not fully covered' in item for item in result.limitations))
        self.assertTrue(any('not dividend-inclusive' in item for item in result.limitations))
        self.assertEqual(result.price_change.window.start, date(2024, 1, 1))

    def test_rounding_and_stable_decimal_string_serialization(self):
        result = calculate_historical_metrics(history([3, 4]))
        self.assertEqual(json.loads(result.model_dump_json())['price_change']['value'], '33.333333')
        # Exact decimal ties at the seventh place round half-even.
        for price, expected in [(1.2345665, '1.234566'), (1.2345675, '1.234568')]:
            result = calculate_historical_metrics(history([price] * 20))
            self.assertEqual(result.model_dump(mode='json')['sma_20']['value'], expected)
        source = history([100, 110, 99] * 17)
        normal = calculate_historical_metrics(source).model_dump_json()
        with localcontext() as context:
            context.prec = 3
            context.rounding = ROUND_UP
            context.traps[Inexact] = True
            self.assertEqual(calculate_historical_metrics(source).model_dump_json(), normal)

    def test_extreme_finite_prices_still_produce_finite_outputs(self):
        source = history([5e-324, sys.float_info.max] * 11)
        result = calculate_historical_metrics(source)
        for field in ['price_change', 'sma_20', 'adjacent_return_volatility_20']:
            self.assertTrue(getattr(result, field).value.is_finite())
        # Exact integer arithmetic independently establishes the percentage:
        # max_decimal / min_decimal = 35953862697246314 * 10**615.
        expected_integer = (35953862697246314 * 10**615 - 1) * 100
        self.assertEqual(str(result.price_change.value), f'{expected_integer}.000000')
        for precision in [28, 50]:
            with patch('app.historical_metrics.CALCULATION_PRECISION', precision), self.assertRaises(InvalidOperation):
                calculate_historical_metrics(source)
        # Guard against finite but inaccurate outputs, not only exceptions.
        for prices in [[5e-324, sys.float_info.max] * 11,
                       [sys.float_info.max, 5e-324] * 11,
                       [1.0] * 20 + [sys.float_info.max],
                       [3, 7] * 10 + [3]]:
            source = history(prices)
            actual = calculate_historical_metrics(source).model_dump_json()
            with patch('app.historical_metrics.CALCULATION_PRECISION', 2800):
                self.assertEqual(actual, calculate_historical_metrics(source).model_dump_json())

    def test_tiny_observations_can_change_a_six_decimal_rounding_tie(self):
        # Mean = 0.0000005 + 19*5e-324/20: strictly above the half-even tie.
        source = history([0.00001] + [5e-324] * 19)
        self.assertEqual(calculate_historical_metrics(source).sma_20.value, Decimal('0.000001'))
        with patch('app.historical_metrics.CALCULATION_PRECISION', 50):
            self.assertEqual(calculate_historical_metrics(source).sma_20.value, Decimal('0.000000'))

    def test_requires_validated_history_model(self):
        with self.assertRaises(TypeError):
            calculate_historical_metrics({'bars': []})


if __name__ == '__main__':
    unittest.main()
