import io
import logging
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

from app.gemini_client import GeminiClient
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


class ResearchApiTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict('os.environ', {'MARKET_DATA_PROVIDER': 'demo'}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.network = patch('httpx.AsyncHTTPTransport.handle_async_request',
                             side_effect=AssertionError('External network forbidden'))
        self.network.start()
        self.addCleanup(self.network.stop)

    def test_disabled_and_missing_key_leave_existing_routes_working(self):
        for enabled in ['false', 'true']:
            with patch.dict('os.environ', {'RESEARCH_ENABLED': enabled}), TestClient(app) as client:
                response = client.post('/api/research', json={
                    'question': 'Compare their reported percentage changes.',
                    'symbols': ['AAPL', 'MSFT'],
                })
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json()['explanation']['code'], 'research_unavailable')
                self.assertEqual(client.get('/health').status_code, 200)
                self.assertEqual(client.get('/api/stocks/AAPL/quote').status_code, 200)
                self.assertIn('/api/research', client.get('/openapi.json').json()['paths'])

    def test_invalid_input_does_not_call_services(self):
        with TestClient(app) as client, patch.object(
            app.state.market_data, 'get_quote', new_callable=AsyncMock,
        ) as quotes:
            for body in [
                {'question': ' ', 'symbols': ['AAPL']},
                {'question': 'x', 'symbols': ['AAPL', 'TSLA']},
                {'question': 'x', 'symbols': ['AAPL', 'aapl']},
                {'question': 'x', 'symbols': ['AAPL'], 'tools': []},
            ]:
                self.assertEqual(client.post('/api/research', json=body).status_code, 422)
            quotes.assert_not_called()

    def test_sdk_end_to_end_success_quota_and_cleanup(self):
        calls = []
        clients = []
        quota = False

        async def handle(request):
            calls.append(request)
            if quota:
                return httpx.Response(429, json={'error': {'code': 429, 'message': 'SECRET'}})
            return httpx.Response(200, json={'candidates': [{
                'finishReason': 'STOP', 'content': {'role': 'model', 'parts': [{'text':
                    '{"status":"answered","findings":[{"kind":"difference",'
                    '"evidence_ids":["q1","q2"],"calculation_ref":"calculations.difference",'
                    '"relation":"higher"}]}',
                }]},
            }]})

        def factory():
            model = GeminiClient('FAKE_TEST_KEY',
                                 http_client=httpx.AsyncClient(transport=httpx.MockTransport(handle)))
            clients.append(model)
            return model

        with patch('app.main.configured_client', side_effect=factory), TestClient(app) as client:
            body = {'question': '  Compare their reported percentage changes.  ',
                    'symbols': ['aapl', 'MSFT']}
            response = client.post('/api/research', json=body)
            self.assertEqual(response.status_code, 200)
            result = response.json()
            self.assertEqual(result['question'], body['question'].strip())
            self.assertEqual(result['quotes']['data_mode'], 'fictional')
            self.assertEqual(result['quotes']['calculations']['difference']['value'], '3.5')
            self.assertEqual(result['explanation']['status'], 'answered')
            self.assertEqual(len(calls), 1)
            quota = True
            response = client.post('/api/research', json=body)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['explanation']['code'], 'model_quota')
            self.assertEqual(len(response.json()['quotes']['evidence']), 2)
            self.assertNotIn('SECRET', response.text)
            self.assertEqual(len(calls), 2)
            self.assertFalse(app.state.research.active.locked())
        self.assertTrue(clients[0].http_client.is_closed)

    def test_busy_response_has_stable_status(self):
        with TestClient(app) as client:
            app.state.research.model = AsyncMock(spec=GeminiClient)
            app.state.research.active.acquire()
            try:
                response = client.post('/api/research', json={
                    'question': 'Compare their reported percentage changes.', 'symbols': ['AAPL'],
                })
                self.assertEqual(response.status_code, 429)
                self.assertEqual(response.json()['explanation']['code'], 'research_busy')
                app.state.research.model.generate.assert_not_called()
            finally:
                app.state.research.active.release()
