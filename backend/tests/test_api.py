import io
import logging
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from app.main import app
from app.market_data import MarketData


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict('os.environ', {'MARKET_DATA_PROVIDER': 'demo'}, clear=True)
        self.environment.start()
        self.client = TestClient(app)
        self.client.__enter__()
        self.service = app.state.market_data

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.environment.stop()
        self.assertTrue(self.service.client.is_closed)

    def test_health_cors_and_schema(self):
        for origin in ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5174']:
            response = self.client.get('/health', headers={'Origin': origin})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {'status': 'ok', 'service': 'marketsim-api'})
            expected = None if origin.endswith('5174') else origin
            self.assertEqual(response.headers.get('access-control-allow-origin'), expected)
            self.assertNotIn('access-control-allow-credentials', response.headers)
        response = self.client.options('/api/stocks/AAPL/quote', headers={
            'Origin': 'http://localhost:5173', 'Access-Control-Request-Method': 'GET',
        })
        self.assertEqual(response.headers['access-control-allow-methods'], 'GET')
        self.assertEqual(self.client.get('/docs').status_code, 200)
        self.assertIn('/api/stocks/{symbol}/quote', self.client.get('/openapi.json').json()['paths'])

    def test_demo_route_and_validation(self):
        response = self.client.get('/api/stocks/aapl/quote')
        self.assertEqual(response.status_code, 200)
        quote = response.json()
        self.assertEqual(quote['symbol'], 'AAPL')
        self.assertEqual(quote['data_kind'], 'fictional')
        self.assertEqual(quote['source'], 'demo')
        self.assertFalse(quote['cache_hit'])
        cached = self.client.get('/api/stocks/AAPL/quote').json()
        self.assertTrue(cached['cache_hit'])
        self.assertEqual(cached['fetched_at'], quote['fetched_at'])
        self.assertEqual(self.client.get('/api/stocks/A1/quote').status_code, 400)
        self.assertEqual(self.client.get('/api/stocks/TSLA/quote').status_code, 404)

    def test_configuration_and_safe_errors(self):
        self.service.provider = 'alpha_vantage'
        self.service.api_key = ''
        response = self.client.get('/api/stocks/AAPL/quote')
        self.assertEqual(response.status_code, 503)
        self.assertIn('not configured', response.json()['detail'])
        sentinel = 'SENTINEL_PRIVATE_KEY'
        output = io.StringIO()
        handler = logging.StreamHandler(output)
        root = logging.getLogger()
        root.addHandler(handler)
        try:
            for status, body in [(200, {'Information': sentinel}), (500, {'error': sentinel})]:
                upstream = httpx.AsyncClient(transport=httpx.MockTransport(
                    lambda request, status=status, body=body: httpx.Response(status, json=body)))
                service = MarketData(upstream, provider='alpha_vantage', api_key=sentinel)
                app.state.market_data = service
                response = self.client.get('/api/stocks/AAPL/quote')
                self.assertEqual(response.status_code, 502)
                self.assertNotIn(sentinel, response.text)
                self.client.portal.call(upstream.aclose)
            self.assertNotIn(sentinel, output.getvalue())
        finally:
            root.removeHandler(handler)
