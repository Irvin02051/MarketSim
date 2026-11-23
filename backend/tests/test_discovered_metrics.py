"""Offline integration tests with self-authored search and price fixtures."""
import json
import unittest
from unittest.mock import patch

import test_discovered_history as fixtures
from pydantic import ValidationError
from test_discovered_history import END, START

from app.main import app
from app.real_history import DiscoveredHistoryResult, HistoryError
from app.real_history_metrics import (
    calculate_discovered_history_metrics,
    calculate_real_history_metrics,
)


class DiscoveredMetricsTests(unittest.TestCase):
    setUp = fixtures.IntegrationTests.setUp
    search = fixtures.IntegrationTests.search
    history = fixtures.IntegrationTests.history

    def metrics(self, ref, **changes):
        params = {'selection_ref': ref, 'symbol': 'NEW.A', 'start_date': str(START), 'end_date': str(END)}
        params.update(changes)
        return self.client.get('/api/stocks/discovered/history/metrics', params=params)

    def test_actual_calculator_and_shared_cached_snapshot(self):
        ref = self.search()
        history = self.history(ref).json()
        expected = calculate_discovered_history_metrics(DiscoveredHistoryResult.model_validate_json(json.dumps(history)))
        response = self.metrics(ref)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        expected_json = expected.model_dump(mode='json')
        expected_json['cache_hit'] = True
        self.assertEqual(result, expected_json)
        self.assertEqual(result['fetched_at'], history['fetched_at'])
        self.assertNotIn('bars', result)
        self.assertEqual(len(self.calls), 2)  # One search and one history; no warm-up request.
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertEqual(result['raw_price_change']['value'], '1.000000')  # (101/100 - 1)*100
        self.assertEqual(result['raw_sma_50']['status'], 'unavailable')
        schema = self.client.get('/openapi.json').json()
        self.assertIn('/api/stocks/discovered/history/metrics', schema['paths'])
        self.assertIn('DiscoveredHistoryMetrics', schema['components']['schemas'])

    def test_validation_before_retrieval_and_cached_reference_invalidation(self):
        ref = self.search()
        self.history(ref)
        for changes, code in [({'selection_ref': 'forged'}, 409), ({'symbol': 'OTHER'}, 409),
                              ({'symbol': 'new.a'}, 409), ({'currency': 'USD'}, 422),
                              ({'prices': '100'}, 422), ({'start_date': '20261023'}, 422),
                              ({'end_date': '2027-01-30'}, 422), ({'end_date': '2026-10-22'}, 422)]:
            response = self.metrics(**({'ref': ref} | changes))
            self.assertEqual(response.status_code, code)
            self.assertEqual(response.headers['cache-control'], 'no-store')
        url = '/api/stocks/discovered/history/metrics'
        self.assertEqual(self.client.get(url).status_code, 422)
        self.assertEqual(self.client.get(url, params=[('selection_ref', ref), ('symbol', 'NEW.A'),
                         ('start_date', str(START)), ('end_date', str(END)), ('symbol', 'NEW.A')]).status_code, 422)
        app.state.stock_search.clock = lambda: float('inf')
        self.assertEqual(self.metrics(ref).status_code, 409)
        self.assertEqual(len(self.calls), 2)
        app.state.stock_search.cache.clear()  # Eviction/restart invalidates even a warm history snapshot.
        self.assertEqual(self.metrics(ref).status_code, 409)
        self.assertEqual(len(self.calls), 2)

    def test_opt_ins_and_configuration_never_fetch(self):
        ref = self.search()
        app.state.real_history_enabled = False
        self.assertEqual(self.metrics(ref).status_code, 503)
        app.state.real_history_enabled = True
        app.state.stock_search.enabled = False
        self.assertEqual(self.metrics(ref).status_code, 503)
        app.state.stock_search.enabled = True
        app.state.historical_data.api_key = ''
        self.assertEqual(self.metrics(ref).status_code, 503)
        self.assertEqual(len(self.calls), 1)

    def test_empty_and_single_observation(self):
        ref = self.search()
        for start, end, count in [('2026-10-24', '2026-10-25', 0), (str(START), str(START), 1)]:
            result = self.metrics(ref, start_date=start, end_date=end).json()
            self.assertEqual(result['observation_count'], count)
            for field in ['raw_price_change', 'raw_sma_20', 'raw_sma_50', 'raw_return_sample_stddev_20']:
                self.assertEqual(result[field]['status'], 'unavailable')
                self.assertIsNone(result[field]['value'])
        self.assertEqual(len(self.calls), 2)

    def test_provenance_and_existing_boundary(self):
        ref = self.search()
        value = self.history(ref).json()
        with self.assertRaises(TypeError):
            calculate_real_history_metrics(DiscoveredHistoryResult.model_validate_json(json.dumps(value)))
        for field, bad in [('source', 'demo'), ('data_kind', 'fictional'), ('adjustment_basis', 'adjusted')]:
            corrupted = DiscoveredHistoryResult.model_validate_json(json.dumps(value)).model_copy(update={field: bad})
            with self.assertRaises(ValidationError):
                calculate_discovered_history_metrics(corrupted)
        self.history_symbol = 'OTHER'
        app.state.historical_data.cache.clear()
        self.assertEqual(self.metrics(ref).status_code, 502)

    def test_safe_service_errors_and_calculator_defects_not_user_errors(self):
        ref = self.search()
        for status in [429, 502, 503, 504]:
            with patch.object(app.state.historical_data, 'get_discovered_history',
                              side_effect=HistoryError(status, 'Safe service failure.')):
                response = self.metrics(ref)
            self.assertEqual(response.status_code, status)
            self.assertEqual(response.json(), {'detail': 'Safe service failure.'})
            self.assertEqual(response.headers['cache-control'], 'no-store')
        response = self.metrics(ref, start_date='2026-10-22')
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()['available_range'], {'start': str(START), 'end': str(END)})
        with patch('app.main.calculate_discovered_history_metrics', side_effect=RuntimeError('synthetic defect')), self.assertRaises(RuntimeError):
            self.metrics(ref)
