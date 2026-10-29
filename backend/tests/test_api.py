import asyncio
import io
import json
import logging
import unittest
from datetime import date, datetime
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient
from google.genai import types

from app.gemini_client import GeminiClient
from app.historical_data import get_history
from app.main import app
from app.market_data import MarketData
from app.research_explanation import ModelFailure


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
        self.assertEqual(response.headers['access-control-allow-methods'], 'GET, POST, DELETE')
        self.assertEqual(self.client.get('/docs').status_code, 200)
        self.assertIn('/api/stocks/{symbol}/quote', self.client.get('/openapi.json').json()['paths'])

    def test_research_preflight_keeps_explicit_origins_and_headers(self):
        for origin in ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5174']:
            response = self.client.options('/api/research/agent', headers={
                'Origin': origin, 'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'content-type',
            })
            allowed = not origin.endswith('5174')
            self.assertEqual(response.status_code, 200 if allowed else 400)
            self.assertEqual(response.headers.get('access-control-allow-origin'), origin if allowed else None)
            self.assertNotIn('access-control-allow-credentials', response.headers)
            self.assertIn('content-type', response.headers['access-control-allow-headers'].lower())
        for method, header in [('PATCH', 'content-type'), ('POST', 'x-unapproved-header')]:
            response = self.client.options('/api/research/agent', headers={
                'Origin': 'http://localhost:5173', 'Access-Control-Request-Method': method,
                'Access-Control-Request-Headers': header,
            })
            self.assertEqual(response.status_code, 400)

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


class HistoryApiTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict('os.environ', {
            'MARKET_DATA_PROVIDER': 'alpha_vantage', 'RESEARCH_ENABLED': 'false',
        }, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        for transport, method in [('AsyncHTTPTransport', 'handle_async_request'),
                                  ('HTTPTransport', 'handle_request')]:
            guard = patch(f'httpx.{transport}.{method}',
                          side_effect=AssertionError('External network forbidden'))
            mocked = guard.start()
            self.addCleanup(guard.stop)
            self.addCleanup(mocked.assert_not_called)
        self.client = TestClient(app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def test_filtered_response_preserves_service_contract(self):
        with patch('app.main.get_history', wraps=get_history) as history, patch.object(
            app.state.market_data, 'get_quote', new_callable=AsyncMock,
        ) as quotes:
            response = self.client.get('/api/stocks/aapl/history', params={
                'start_date': '2024-01-01', 'end_date': '2024-01-03',
            })
            self.assertEqual(response.status_code, 200)
            history.assert_called_once()
            validated = history.call_args.args[0]
            self.assertEqual(validated.symbol, 'AAPL')
            self.assertEqual(validated.start_date, date(2024, 1, 1))
            expected = get_history(validated).model_dump(mode='json')
            actual = response.json()
            self.assertIsNotNone(datetime.fromisoformat(actual.pop('fetched_at')).utcoffset())
            expected.pop('fetched_at')
            self.assertEqual(actual, expected)
            self.assertEqual([bar['date'] for bar in actual['bars']],
                             ['2024-01-01', '2024-01-02', '2024-01-03'])
            self.assertIsNone(actual['bars'][0]['volume'])
            self.assertEqual(actual['source'], 'demo')
            self.assertEqual(actual['adjustment_basis'], 'unknown')
            self.assertIn('FICTIONAL', actual['label'])
            self.assertIsNone(app.state.research.model)
            self.assertEqual(app.state.market_data.provider, 'alpha_vantage')
            quotes.assert_not_called()
        for symbol in ['msft', 'nvda']:
            response = self.client.get(f'/api/stocks/{symbol}/history', params={
                'start_date': '2025-01-01', 'end_date': '2025-01-01',
            })
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['symbol'], symbol.upper())

    def test_invalid_queries_do_not_retrieve_history(self):
        valid = {'start_date': '2025-01-01', 'end_date': '2025-01-03'}
        queries = [{}, {'start_date': valid['start_date']}, {'end_date': valid['end_date']},
                   {**valid, 'end_date': '2024-12-31'},
                   {**valid, 'end_date': '2027-01-01'},
                   {**valid, 'interval': 'daily'}, {**valid, 'unexpected': 'PRIVATE_SENTINEL'},
                   [('start_date', valid['start_date']), ('start_date', valid['start_date']),
                    ('end_date', valid['end_date'])]]
        for name in valid:
            for value in ['', '2025-1-01', '20250101', '2025-02-29', '2025-13-01',
                          '2025-01-01T00:00:00Z', '1735689600', ' 2025-01-01', '0000-01-01']:
                queries.append({**valid, name: value})
        with patch('app.main.get_history') as history:
            for query in queries:
                with self.subTest(query=query):
                    response = self.client.get('/api/stocks/AAPL/history', params=query)
                    self.assertEqual(response.status_code, 422)
                    self.assertIn('detail', response.json())
                    self.assertNotIn('PRIVATE_SENTINEL', response.text)
            for symbol in ['TSLA', 'A1', 'PRIVATE_SENTINEL']:
                response = self.client.get(f'/api/stocks/{symbol}/history', params=valid)
                self.assertEqual(response.status_code, 422)
                self.assertNotIn('PRIVATE_SENTINEL', response.text)
            history.assert_not_called()

    def test_empty_and_partial_results_are_successful(self):
        for start, end, coverage, dates in [
            ('2025-01-04', '2025-01-05', 'within_fixture', []),
            ('2026-01-01', '2026-01-03', 'outside_fixture', []),
            ('2023-12-29', '2024-01-02', 'partial_overlap', ['2024-01-01', '2024-01-02']),
        ]:
            with self.subTest(start=start):
                response = self.client.get('/api/stocks/AAPL/history', params={
                    'start_date': start, 'end_date': end,
                })
                self.assertEqual(response.status_code, 200)
                result = response.json()
                self.assertEqual(result['requested_range'], {'start': start, 'end': end})
                self.assertEqual(result['coverage'], coverage)
                self.assertEqual(result['status'], 'ok' if dates else 'empty')
                self.assertEqual([bar['date'] for bar in result['bars']], dates)
                self.assertEqual(result['returned_range'],
                                 {'start': dates[0], 'end': dates[-1]} if dates else None)
                self.assertEqual(result['data_kind'], 'fictional')
                self.assertTrue(result['limitations'])

    def test_openapi_documents_required_dates_and_typed_result(self):
        route = self.client.get('/openapi.json').json()['paths']['/api/stocks/{symbol}/history']['get']
        parameters = {item['name']: item for item in route['parameters']}
        for name in ['start_date', 'end_date']:
            self.assertTrue(parameters[name]['required'])
            self.assertEqual(parameters[name]['in'], 'query')
            self.assertIn('pattern', parameters[name]['schema'])
        self.assertEqual(route['responses']['200']['content']['application/json']['schema'],
                         {'$ref': '#/components/schemas/HistoricalResult'})
        self.assertIn('422', route['responses'])


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


class AgentApiTests(unittest.TestCase):
    question = 'Compare Apple and Microsoft’s reported percentage changes.'

    def setUp(self):
        self.environment = patch.dict('os.environ', {'MARKET_DATA_PROVIDER': 'demo'}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        for transport, method in [('AsyncHTTPTransport', 'handle_async_request'),
                                  ('HTTPTransport', 'handle_request')]:
            guard = patch(f'httpx.{transport}.{method}',
                          side_effect=AssertionError('External network forbidden'))
            mocked = guard.start()
            self.addCleanup(guard.stop)
            self.addCleanup(mocked.assert_not_called)

    def test_configuration_rejected_without_agent_or_quote_calls(self):
        for configuration in [
            {'RESEARCH_ENABLED': 'false', 'GEMINI_API_KEY': 'FAKE_TEST_KEY'},
            {'RESEARCH_ENABLED': 'true'},
            {'RESEARCH_ENABLED': 'true', 'GEMINI_API_KEY': 'FAKE_TEST_KEY', 'GEMINI_MODEL': ''},
        ]:
            with patch.dict('os.environ', configuration), TestClient(app) as client, patch.object(
                app.state.research_agent, 'run', new_callable=AsyncMock,
            ) as run, patch.object(app.state.market_data, 'get_quote', new_callable=AsyncMock) as quotes:
                response = client.post('/api/research/agent', json={'question': self.question})
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json()['explanation']['code'], 'research_unavailable')
                self.assertEqual(response.json()['model_calls'], 0)
                run.assert_not_called()
                quotes.assert_not_called()

    def test_request_validation_precedes_agent(self):
        with TestClient(app) as client, patch.object(
            app.state.research_agent, 'run', new_callable=AsyncMock,
        ) as run:
            for body in [{}, {'question': None}, {'question': 1}, {'question': []},
                         {'question': ''}, {'question': ' \n '}, {'question': 'x' * 1001},
                         {'question': self.question, 'symbols': ['AAPL']},
                         {'question': self.question, 'extra': True}]:
                with self.subTest(body=body):
                    self.assertEqual(client.post('/api/research/agent', json=body).status_code, 422)
            self.assertEqual(client.post('/api/research/agent', content='{',
                                         headers={'Content-Type': 'application/json'}).status_code, 422)
            run.assert_not_called()

    def test_success_uses_shared_client_and_serializes_agent_evidence(self):
        model = AsyncMock(spec=GeminiClient)
        model.agent_turn.side_effect = [
            types.Content(role='model', parts=[types.Part.from_function_call(
                name='get_quotes', args={'symbols': ['AAPL', 'MSFT']},
            )]),
            types.Content(role='model', parts=[types.Part.from_text(text=json.dumps({
                'status': 'answered', 'findings': [{
                    'kind': 'difference', 'evidence_ids': ['q1', 'q2'],
                    'calculation_ref': 'calculations.difference', 'relation': 'higher',
                }],
            }))]),
        ]
        with patch('app.main.configured_client', return_value=model), TestClient(app) as client:
            self.assertIs(app.state.research.model, app.state.research_agent.model)
            response = client.post('/api/research/agent', json={'question': f'  {self.question}  '})
            self.assertEqual(response.status_code, 200)
            result = response.json()
            self.assertEqual(result['question'], self.question)
            self.assertEqual(result['explanation']['status'], 'answered')
            self.assertEqual(result['quotes']['data_mode'], 'fictional')
            self.assertIn('FICTIONAL', result['quotes']['label'])
            self.assertEqual(result['quotes']['calculations']['difference']['value'], '3.5')
            self.assertEqual((result['model_calls'], result['tool_requests']), (2, 1))
            self.assertEqual(result['tool_outcomes'][0]['code'], 'ok')
            self.assertFalse(app.state.research.active.locked())
            schema = client.get('/openapi.json').json()['paths']['/api/research/agent']['post']
            for status in ['200', '429', '503']:
                self.assertEqual(schema['responses'][status]['content']['application/json']['schema'],
                                 {'$ref': '#/components/schemas/AgentResult'})
            self.assertIn('422', schema['responses'])
        model.close.assert_awaited_once()

    def test_historical_response_is_additive_typed_and_independent_of_quotes(self):
        model = AsyncMock(spec=GeminiClient)
        question = 'Compare AAPL and MSFT price change from 2025-01-01 to 2025-03-31.'
        model.agent_turn.side_effect = [
            types.Content(role='model', parts=[types.Part.from_function_call(
                name='get_historical_metrics', args={'symbols': ['AAPL', 'MSFT'],
                                                   'start_date': '2025-01-01', 'end_date': '2025-03-31'},
            )]),
            types.Content(role='model', parts=[types.Part.from_text(text=json.dumps({
                'status': 'answered', 'findings': [], 'historical_findings': [{
                    'metric': 'price_change', 'evidence_ids': ['hm1', 'hm2'], 'relation': 'higher',
                }],
            }))]),
        ]
        with patch('app.main.configured_client', return_value=model), TestClient(app) as client, patch.object(
            app.state.market_data, 'get_quote', new_callable=AsyncMock,
        ) as quotes:
            response = client.post('/api/research/agent', json={'question': question})
            self.assertEqual(response.status_code, 200)
            result = response.json()
            self.assertEqual(result['status'], 'answered')
            self.assertIsNone(result['quotes'])
            self.assertEqual(result['explanation']['code'], 'historical_answer_available')
            self.assertEqual(result['explanation']['findings'], [])
            self.assertEqual(result['tool_outcomes'], [])
            self.assertEqual(result['historical_tool_outcomes'][0]['tool'], 'get_historical_metrics')
            self.assertEqual(result['historical_tool_outcomes'][0]['start_date'], '2025-01-01')
            evidence = result['historical_evidence']
            self.assertEqual([e['id'] for e in evidence], ['hm1', 'hm2'])
            self.assertIsInstance(evidence[0]['price_change']['value'], str)
            self.assertEqual(evidence[0]['provenance']['data_kind'], 'fictional')
            self.assertEqual(evidence[0]['provenance']['adjustment_basis'], 'unknown')
            self.assertEqual(result['historical_findings'][0]['evidence_ids'], ['hm1', 'hm2'])
            self.assertNotIn('"bars"', response.text)
            self.assertFalse(app.state.research.active.locked())
            quotes.assert_not_called()
            schemas = client.get('/openapi.json').json()['components']['schemas']
            fields = schemas['AgentResult']['properties']
            self.assertEqual(fields['historical_findings']['items'],
                             {'$ref': '#/components/schemas/RenderedHistoricalFinding'})
            self.assertTrue(fields['status']['readOnly'])

    def test_safe_failure_and_timeout_release_slot(self):
        model = AsyncMock(spec=GeminiClient)
        with patch('app.main.configured_client', return_value=model), TestClient(app) as client:
            for failure, code in [(RuntimeError('PRIVATE_PROVIDER_DETAIL'), 'research_failed'),
                                  (ModelFailure('model_quota'), 'model_quota'),
                                  (asyncio.TimeoutError('PRIVATE_PROVIDER_DETAIL'), 'research_timeout')]:
                model.agent_turn.side_effect = failure
                response = client.post('/api/research/agent', json={'question': self.question})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()['explanation']['code'], code)
                self.assertNotIn('PRIVATE_PROVIDER_DETAIL', response.text)
                self.assertFalse(app.state.research.active.locked())

    def test_shared_admission_and_cancellation_in_both_directions(self):
        model = AsyncMock(spec=GeminiClient)
        with patch('app.main.configured_client', return_value=model), TestClient(app) as client:
            async def exercise():
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                             base_url='http://test') as http:
                    for active_path, method, rejected_path in [
                        ('/api/research/agent', 'agent_turn', '/api/research'),
                        ('/api/research', 'generate', '/api/research/agent'),
                    ]:
                        started = asyncio.Event()

                        async def pending(*args, started=started, **kwargs):
                            started.set()
                            await asyncio.Event().wait()

                        getattr(model, method).side_effect = pending
                        bodies = {
                            '/api/research/agent': {'question': self.question},
                            '/api/research': {'question': 'Compare their reported percentage changes.',
                                              'symbols': ['AAPL', 'MSFT']},
                        }
                        task = asyncio.create_task(http.post(active_path, json=bodies[active_path]))
                        try:
                            await asyncio.wait_for(started.wait(), 2)
                            calls_before = (model.agent_turn.await_count, model.generate.await_count)
                            response = await http.post(rejected_path, json=bodies[rejected_path])
                            self.assertEqual(response.status_code, 429)
                            self.assertEqual(response.json()['explanation']['code'], 'research_busy')
                            self.assertIsNone(response.json()['quotes'])
                            self.assertEqual((model.agent_turn.await_count, model.generate.await_count),
                                             calls_before)
                        finally:
                            task.cancel()
                            with self.assertRaises(asyncio.CancelledError):
                                await task
                        self.assertFalse(app.state.research.active.locked())
                    # A real agent deadline also frees the shared slot.
                    app.state.research_agent.deadline = 0.01
                    response = await http.post('/api/research/agent', json={'question': self.question})
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json()['explanation']['code'], 'research_timeout')
                    self.assertFalse(app.state.research.active.locked())
            client.portal.call(exercise)


class IdentityApiTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict('os.environ', {'MARKET_DATA_PROVIDER': 'demo',
                                'RESEARCH_ENABLED': 'false'}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        for transport, method in [('AsyncHTTPTransport', 'handle_async_request'),
                                  ('HTTPTransport', 'handle_request')]:
            guard = patch(f'httpx.{transport}.{method}', side_effect=AssertionError('Network forbidden'))
            mocked = guard.start()
            self.addCleanup(guard.stop)
            self.addCleanup(mocked.assert_not_called)
        self.client = TestClient(app)
        self.client.__enter__()
        self.auth_client = app.state.identity.client
        self.addCleanup(self.check_closed)
        self.addCleanup(self.client.__exit__, None, None, None)

    def check_closed(self):
        self.assertTrue(self.auth_client.is_closed)

    def test_missing_and_malformed_credentials_before_configuration(self):
        for headers in [{}, {'Authorization': 'Basic x'}, {'Authorization': 'Bearer x,y'},
                        [('Authorization', 'Bearer a'), ('authorization', 'Bearer b')],
                        {'Authorization': 'Bearer ' + 'a' * 8192}]:
            response = self.client.get('/api/me', headers=headers)
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.headers['www-authenticate'], 'Bearer')
            self.assertEqual(response.headers['cache-control'], 'no-store')
        response = self.client.get('/api/me?access_token=TEST', headers={'Cookie': 'access_token=TEST'})
        self.assertEqual(response.status_code, 401)
        response = self.client.request('GET', '/api/me', json={'access_token': 'TEST'})
        self.assertEqual(response.status_code, 401)

    def test_missing_configuration_and_public_routes(self):
        response = self.client.get('/api/me', headers={'Authorization': 'Bearer TEST'})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertEqual(self.client.get('/health').status_code, 200)
        self.assertEqual(self.client.get('/api/stocks/AAPL/quote').status_code, 200)
        self.assertEqual(self.client.get('/api/stocks/AAPL/history', params={
            'start_date': '2025-01-01', 'end_date': '2025-01-03',
        }).status_code, 200)
        self.assertEqual(self.client.post('/api/research', json={
            'question': 'Compare', 'symbols': ['AAPL'],
        }).status_code, 503)
        self.assertEqual(self.client.post('/api/research/agent', json={'question': 'Compare'}).status_code, 503)

    def test_mocked_identity_status_contract_and_secrecy(self):
        from app.auth import IdentityVerifier

        output = io.StringIO()
        handler = logging.StreamHandler(output)
        logging.getLogger().addHandler(handler)
        self.addCleanup(logging.getLogger().removeHandler, handler)
        user = '12345678-1234-4234-8234-123456789abc'
        for upstream_status, body, status in [
            (200, {'id': user, 'email': 'PRIVATE'}, 200),
            (403, {'code': 'bad_jwt', 'msg': 'PRIVATE'}, 401),
            (200, {'id': 'PRIVATE'}, 503),
            (429, {'msg': 'PRIVATE'}, 503), (500, {'msg': 'PRIVATE'}, 503),
        ]:
            upstream = httpx.AsyncClient(transport=httpx.MockTransport(
                lambda request, code=upstream_status, payload=body: httpx.Response(code, json=payload)))
            try:
                app.state.identity = IdentityVerifier(upstream, 'https://example.supabase.co',
                                                       'sb_publishable_PRIVATE')
                response = self.client.get('/api/me', headers={'Authorization': 'bEaReR PRIVATE'})
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.headers['cache-control'], 'no-store')
                self.assertEqual(response.headers.get('www-authenticate'), 'Bearer' if status == 401 else None)
                if status == 200:
                    self.assertEqual(response.json(), {'user_id': user})
                self.assertNotIn('PRIVATE', response.text)
            finally:
                self.client.portal.call(upstream.aclose)
        self.assertNotIn('PRIVATE', output.getvalue())

    def test_authorization_preflight(self):
        for origin in ['http://localhost:5173', 'http://127.0.0.1:5173', 'https://unapproved.example']:
            response = self.client.options('/api/me', headers={
                'Origin': origin, 'Access-Control-Request-Method': 'GET',
                'Access-Control-Request-Headers': 'Authorization',
            })
            allowed = origin.startswith('http:')
            self.assertEqual(response.status_code, 200 if allowed else 400)
            self.assertEqual(response.headers.get('access-control-allow-origin'), origin if allowed else None)
            self.assertIn('authorization', response.headers['access-control-allow-headers'].lower())
            self.assertNotIn('access-control-allow-credentials', response.headers)


class ProviderHistoryApiTests(unittest.TestCase):
    path = '/api/stocks/AAPL/history/provider'

    def setUp(self):
        self.dates = {'start_date': '2026-10-23', 'end_date': '2026-10-28'}
        environment = patch.dict('os.environ', {
            'MARKET_DATA_PROVIDER': 'demo', 'RESEARCH_ENABLED': 'false',
            'REAL_HISTORY_ENABLED': 'true', 'ALPHA_VANTAGE_API_KEY': 'PRIVATE_SENTINEL',
        }, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        # All real transports are blocked; selected tests replace only the async
        # handler with MockTransport. No environment files or real services are used.
        for transport, method in [('AsyncHTTPTransport', 'handle_async_request'),
                                  ('HTTPTransport', 'handle_request')]:
            guard = patch(f'httpx.{transport}.{method}', side_effect=AssertionError('Network forbidden'))
            guard.start()
            self.addCleanup(guard.stop)

    def test_default_disabled_independent_of_key_and_quote_mode(self):
        for flag in [None, 'false', '', '1', 'TRUE', ' true ']:
            with patch.dict('os.environ', {'MARKET_DATA_PROVIDER': 'alpha_vantage'}):
                import os
                if flag is None:
                    os.environ.pop('REAL_HISTORY_ENABLED', None)
                else:
                    os.environ['REAL_HISTORY_ENABLED'] = flag
                with TestClient(app) as client, patch.object(
                    app.state.historical_data, 'get_history', new_callable=AsyncMock,
                ) as history:
                    self.assertEqual(app.state.historical_data.mode, 'demo')
                    response = client.get(self.path, params=self.dates)
                    self.assertEqual(response.status_code, 503)
                    self.assertEqual(response.json(), {'detail': 'Provider history is disabled.'})
                    history.assert_not_called()
                    self.assertEqual(client.get('/health').status_code, 200)

    def test_missing_key_does_not_break_startup_or_spend_budget(self):
        with patch.dict('os.environ', {'ALPHA_VANTAGE_API_KEY': ''}), TestClient(app) as client:
            self.assertEqual(client.get('/health').status_code, 200)
            response = client.get(self.path, params=self.dates)
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()['detail'], 'Alpha Vantage API key is not configured.')
            self.assertEqual(len(app.state.historical_data.budget.attempts), 0)
            self.assertEqual(client.get('/api/stocks/AAPL/quote').status_code, 200)

    def test_typed_result_normalization_cache_and_shared_lifecycle(self):
        from test_real_history import payload

        transport = httpx.MockTransport(lambda req: httpx.Response(200, json=payload()))
        with patch('httpx.AsyncHTTPTransport.handle_async_request',
                   side_effect=transport.handle_async_request) as upstream, TestClient(app) as client:
            service = app.state.historical_data
            self.assertIs(service.client, app.state.market_data.client)
            self.assertIs(service.budget, app.state.market_data.budget)
            first = client.get('/api/stocks/aapl/history/provider', params=self.dates)
            second = client.get(self.path, params=self.dates)
            self.assertEqual((first.status_code, second.status_code), (200, 200))
            data, cached = first.json(), second.json()
            self.assertEqual(data['symbol'], 'AAPL')
            self.assertEqual((data['source'], data['data_kind'], data['adjustment_basis']),
                             ('alpha_vantage', 'end_of_day', 'unadjusted'))
            self.assertIsNone(data['bars'][0]['volume'])
            self.assertEqual(data['returned_range'], {'start': '2026-10-23', 'end': '2026-10-28'})
            self.assertEqual(data['coverage'], 'within_snapshot_bounds')
            self.assertTrue(data['limitations'])
            self.assertFalse(data['cache_hit'])
            self.assertTrue(cached['cache_hit'])
            self.assertEqual(cached, {**data, 'cache_hit': True})
            upstream.assert_awaited_once()
            self.assertEqual(len(service.budget.attempts), 1)
            route = client.get('/openapi.json').json()['paths']['/api/stocks/{symbol}/history/provider']['get']
            self.assertEqual(route['responses']['200']['content']['application/json']['schema'],
                             {'$ref': '#/components/schemas/RealHistoryResult'})
            self.assertTrue({'422', '429', '502', '503', '504'} <= route['responses'].keys())
        self.assertTrue(service.closed)
        self.assertTrue(service.client.is_closed)

    def test_invalid_inputs_never_reach_service(self):
        invalid = [{}, {'start_date': '2026-10-23'}, {'end_date': '2026-10-28'},
                   {**self.dates, 'interval': 'daily'}, {**self.dates, 'extra': 'PRIVATE_SENTINEL'},
                   {'start_date': '2026-01-01', 'end_date': '2026-04-01'},
                   {'start_date': '2026-10-28', 'end_date': '2026-10-23'}]
        for name in self.dates:
            invalid.append([*self.dates.items(), (name, self.dates[name])])
            for value in ['', '2026-1-01', '20261023', '2026-02-30', '2026-10-23T00:00:00Z',
                          ' 2026-10-23', '0000-01-01', '2026-10-23\n']:
                invalid.append({**self.dates, name: value})
        with TestClient(app) as client, patch.object(
            app.state.historical_data, 'get_history', new_callable=AsyncMock,
        ) as history:
            for query in invalid:
                with self.subTest(query=query):
                    self.assertEqual(client.get(self.path, params=query).status_code, 422)
            for symbol in ['TSLA', 'A1', 'PRIVATE_SENTINEL']:
                response = client.get(f'/api/stocks/{symbol}/history/provider', params=self.dates)
                self.assertEqual(response.status_code, 422)
                self.assertNotIn('PRIVATE_SENTINEL', response.text)
            history.assert_not_called()

    def test_empty_and_range_unavailable(self):
        from test_real_history import payload

        transport = httpx.MockTransport(lambda req: httpx.Response(200, json=payload()))
        with patch('httpx.AsyncHTTPTransport.handle_async_request',
                   side_effect=transport.handle_async_request) as upstream, TestClient(app) as client:
            response = client.get(self.path, params={'start_date': '2026-10-24', 'end_date': '2026-10-25'})
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertEqual((data['status'], data['bars'], data['returned_range']), ('empty', [], None))
            response = client.get(self.path, params={**self.dates, 'start_date': '2026-10-01'})
            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.json(), {
                'detail': 'Requested range is unavailable in the compact snapshot.',
                'available_range': {'start': '2026-10-23', 'end': '2026-10-28'},
            })
            upstream.assert_awaited_once()

    def test_safe_provider_errors_and_budget_mapping(self):
        cases = [(httpx.Response(429, text='PRIVATE_SENTINEL'), 429),
                 (httpx.Response(500, text='PRIVATE_SENTINEL'), 502),
                 (httpx.Response(302, headers={'Location': 'https://example.invalid/PRIVATE_SENTINEL'}), 502),
                 (httpx.Response(200, json={'Note': 'quota exceeded PRIVATE_SENTINEL'}), 429),
                 (httpx.Response(200, json={'PRIVATE_SENTINEL': True}), 502),
                 (httpx.ConnectError('PRIVATE_SENTINEL'), 502),
                 (httpx.ReadTimeout('PRIVATE_SENTINEL'), 504)]
        output = io.StringIO()
        handler = logging.StreamHandler(output)
        logging.getLogger().addHandler(handler)
        self.addCleanup(logging.getLogger().removeHandler, handler)
        for result, status in cases:
            def handle(req, result=result):
                if isinstance(result, Exception):
                    raise result
                return result
            transport = httpx.MockTransport(handle)
            with patch('httpx.AsyncHTTPTransport.handle_async_request',
                       side_effect=transport.handle_async_request) as upstream, TestClient(app) as client:
                response = client.get(self.path, params=self.dates)
                self.assertEqual(response.status_code, status)
                self.assertEqual(set(response.json()), {'detail'})
                self.assertNotIn('PRIVATE_SENTINEL', response.text)
                self.assertNotIn('https://', response.text)
                upstream.assert_awaited_once()
        self.assertNotIn('PRIVATE_SENTINEL', output.getvalue())
        with TestClient(app) as client:
            for _ in range(20):
                app.state.market_data.budget.reserve()
            response = client.get(self.path, params=self.dates)
            self.assertEqual(response.status_code, 429)
            self.assertEqual(response.json()['detail'], 'Local daily provider attempt budget exhausted.')

    def test_enabled_keeps_demo_and_research_routes_unchanged(self):
        with TestClient(app) as client, patch.object(
            app.state.historical_data, 'get_history', new_callable=AsyncMock,
        ) as provider:
            response = client.get('/api/stocks/AAPL/history', params={
                'start_date': '2025-01-01', 'end_date': '2025-01-03',
            })
            expected = get_history({'symbol': 'AAPL', 'start_date': date(2025, 1, 1),
                                    'end_date': date(2025, 1, 3)}).model_dump(mode='json')
            actual = response.json()
            expected.pop('fetched_at'); actual.pop('fetched_at')
            self.assertEqual(actual, expected)
            self.assertEqual(client.get('/api/stocks/AAPL/quote').json()['source'], 'demo')
            self.assertEqual(client.post('/api/research', json={
                'question': 'Compare', 'symbols': ['AAPL'],
            }).status_code, 503)
            self.assertEqual(client.post('/api/research/agent', json={'question': 'Compare'}).status_code, 503)
            provider.assert_not_called()
