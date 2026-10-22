import asyncio
import io
import json
import logging
import unittest
from unittest.mock import patch
from uuid import UUID

import httpx
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.auth import IdentityVerifier, VerifiedContext
from app.main import app
from app.watchlist import WatchlistService

USER = '11111111-1111-4111-8111-111111111111'
OTHER = '22222222-2222-4222-8222-222222222222'
STAMP = '2026-10-22T12:00:00+00:00'
URL = 'https://example.supabase.co'
KEY = 'sb_publishable_SYNTHETIC'


def row(symbol='AAPL', owner=USER):
    return {'user_id': owner, 'symbol': symbol, 'created_at': STAMP}


class WatchlistApiTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict('os.environ', {'MARKET_DATA_PROVIDER': 'demo', 'RESEARCH_ENABLED': 'false'}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        for transport, method in [('AsyncHTTPTransport', 'handle_async_request'), ('HTTPTransport', 'handle_request')]:
            guard = patch(f'httpx.{transport}.{method}', side_effect=AssertionError('Live network forbidden'))
            mock = guard.start()
            self.addCleanup(guard.stop)
            self.addCleanup(mock.assert_not_called)
        self.client = TestClient(app)
        self.client.__enter__()
        self.data_client = app.state.watchlist.client
        self.auth_client = app.state.identity.client
        self.addCleanup(self.closed)
        self.addCleanup(self.client.__exit__, None, None, None)
        self.requests = []
        self.auth_calls = []
        self.upstream_status = 200
        self.upstream_body = []
        self.auth_status = 200
        self.auth_body = {'id': USER}

        def auth(request):
            self.auth_calls.append(request)
            return httpx.Response(self.auth_status, json=self.auth_body)

        def data(request):
            self.requests.append(request)
            return httpx.Response(self.upstream_status, json=self.upstream_body)

        self.mock_auth = httpx.AsyncClient(transport=httpx.MockTransport(auth))
        self.mock_data = httpx.AsyncClient(transport=httpx.MockTransport(data))
        self.addCleanup(self.client.portal.call, self.mock_auth.aclose)
        self.addCleanup(self.client.portal.call, self.mock_data.aclose)
        app.state.identity = IdentityVerifier(self.mock_auth, URL, KEY)
        app.state.watchlist = WatchlistService(self.mock_data, URL, KEY)

    def closed(self):
        self.assertTrue(self.auth_client.is_closed)
        self.assertTrue(self.data_client.is_closed)

    def call(self, method='GET', path='/api/watchlist', **kwargs):
        headers = kwargs.pop('headers', {'Authorization': 'Bearer SYNTHETIC_TOKEN'})
        response = self.client.request(method, path, headers=headers, **kwargs)
        self.assertEqual(response.headers['cache-control'], 'no-store')
        return response

    def test_empty_and_sorted_list_and_schema(self):
        self.assertEqual(self.call().json(), {'items': []})
        self.upstream_body = [row('NVDA'), row('AAPL')]
        response = self.call()
        self.assertEqual(response.status_code, 200)
        self.assertEqual([item['symbol'] for item in response.json()['items']], ['AAPL', 'NVDA'])
        self.assertEqual(set(response.json()['items'][0]), {'symbol', 'created_at'})
        self.assertEqual(len(self.auth_calls), 2)  # no verification/result cache
        request = self.requests[-1]
        self.assertEqual(request.url.path, '/rest/v1/watchlist_items')
        self.assertEqual(request.url.params['user_id'], 'eq.' + USER)
        self.assertEqual(request.url.params['order'], 'symbol.asc')
        self.assertEqual(request.url.params['select'], 'user_id,symbol,created_at')
        self.assertEqual(request.headers['authorization'], 'Bearer SYNTHETIC_TOKEN')
        self.assertEqual(request.headers['apikey'], KEY)
        self.assertNotIn('authorization', self.mock_data.headers)
        schema = self.client.get('/openapi.json').json()
        self.assertIn('/api/watchlist', schema['paths'])
        self.assertIn('201', schema['paths']['/api/watchlist']['post']['responses'])

    def test_add_normalizes_and_derives_owner_without_upsert(self):
        self.upstream_status, self.upstream_body = 201, [row()]
        response = self.call('POST', json={'symbol': ' aapl '})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()['symbol'], 'AAPL')
        self.assertEqual(response.json()['created_at'], '2026-10-22T12:00:00Z')
        request = self.requests[0]
        self.assertEqual(json.loads(request.content), {'user_id': USER, 'symbol': 'AAPL'})
        self.assertEqual(request.headers['prefer'], 'return=representation, missing=default')
        self.assertNotIn('on_conflict', request.url.params)

    def test_delete_present_and_missing(self):
        for body in [[row()], []]:
            self.upstream_body = body
            response = self.call('DELETE', '/api/watchlist/ aapl ')
            self.assertEqual(response.status_code, 204)
            self.assertEqual(response.content, b'')
            self.assertEqual(self.requests[-1].url.params['user_id'], 'eq.' + USER)
            self.assertEqual(self.requests[-1].url.params['symbol'], 'eq.AAPL')

    def test_invalid_input_never_calls_database(self):
        for body in [{}, {'symbol': None}, {'symbol': 123}, {'symbol': 'TSLA'},
                     {'symbol': 'AAPL', 'user_id': OTHER}, {'symbol': 'AAPL', 'token': 'PRIVATE'}]:
            self.assertEqual(self.call('POST', json=body).status_code, 422)
        self.assertEqual(self.call('DELETE', '/api/watchlist/TSLA').status_code, 422)
        self.assertEqual(self.requests, [])

    def test_missing_malformed_and_rejected_credentials(self):
        for headers in [{}, {'Authorization': 'Basic test'},
                        [('Authorization', 'Bearer A'), ('Authorization', 'Bearer B')]]:
            response = self.call(headers=headers)
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.headers['www-authenticate'], 'Bearer')
        self.auth_status, self.auth_body = 403, {'code': 'bad_jwt', 'msg': 'PRIVATE'}
        self.assertEqual(self.call().status_code, 401)
        self.assertEqual(self.requests, [])

    def test_missing_configuration(self):
        app.state.identity = IdentityVerifier(self.mock_auth, '', '')
        self.assertEqual(self.call().status_code, 503)
        self.assertEqual(self.auth_calls, [])
        app.state.identity = IdentityVerifier(self.mock_auth, URL, KEY)
        app.state.watchlist = WatchlistService(self.mock_data, '', '')
        self.assertEqual(self.call().status_code, 503)
        self.assertEqual(self.requests, [])

    def test_errors_are_classified_without_retry_or_details(self):
        for status, code, expected in [(409, '23505', 409), (403, '42501', 403),
            (401, 'PGRST301', 401), (401, 'PGRST302', 401), (401, 'PGRST303', 401),
            (404, '42P01', 503), (404, 'PGRST205', 503), (429, '23505', 503),
            (500, '23505', 503), (503, 'PGRST000', 503), (401, 'unknown', 503),
            (302, 'unknown', 503), (409, '23503', 503)]:
            with self.subTest(code=code, status=status):
                self.upstream_status, self.upstream_body = status, {'code': code, 'message': 'PRIVATE'}
                before = len(self.requests)
                response = self.call('POST', json={'symbol': 'AAPL'})
                self.assertEqual(response.status_code, expected)
                self.assertEqual(len(self.requests), before + 1)
                self.assertNotIn('PRIVATE', response.text)
                if expected == 401:
                    self.assertEqual(response.headers['www-authenticate'], 'Bearer')

    def test_malformed_rows_rejected(self):
        for body in [None, {}, [None], [row(owner=OTHER)], [row('aapl')], [row('TSLA')],
                     [row(), row()], [{**row(), 'created_at': None}],
                     [{**row(), 'created_at': '2026-10-22'}], [{**row(), 'user_id': 123}],
                     [{**row(), 'created_at': 'invalid'}], [row()] * 4]:
            with self.subTest(body=body):
                self.upstream_body = body
                self.assertEqual(self.call().status_code, 503)
        self.upstream_status, self.upstream_body = 201, []
        self.assertEqual(self.call('POST', json={'symbol': 'AAPL'}).status_code, 503)
        self.upstream_body = [row('MSFT')]
        self.assertEqual(self.call('POST', json={'symbol': 'AAPL'}).status_code, 503)
        self.upstream_status = 200
        self.assertEqual(self.call('DELETE', '/api/watchlist/AAPL').status_code, 503)

    def test_raw_invalid_json_transport_and_context_secrecy(self):
        output = io.StringIO()
        handler = logging.StreamHandler(output)
        logging.getLogger().addHandler(handler)
        self.addCleanup(logging.getLogger().removeHandler, handler)
        for fail in [False, True]:
            def data(request, fail=fail):
                if fail:
                    raise httpx.ReadTimeout('PRIVATE')
                return httpx.Response(200, content='PRIVATE')
            upstream = httpx.AsyncClient(transport=httpx.MockTransport(data))
            try:
                app.state.watchlist = WatchlistService(upstream, URL, KEY)
                response = self.call()
                self.assertEqual(response.status_code, 503)
                self.assertNotIn('PRIVATE', response.text)
            finally:
                self.client.portal.call(upstream.aclose)
        context = VerifiedContext(user_id=UUID(USER), token=SecretStr('PRIVATE'))
        self.assertNotIn('PRIVATE', repr(context))
        self.assertNotIn('PRIVATE', context.model_dump_json())
        self.assertNotIn('token', context.model_dump())
        self.assertNotIn('PRIVATE', output.getvalue())

    def test_delete_cors_and_public_regressions(self):
        for origin, expected in [('http://localhost:5173', 200), ('http://127.0.0.1:5173', 200),
                                 ('https://other.example', 400)]:
            response = self.client.options('/api/watchlist/AAPL', headers={
                'Origin': origin, 'Access-Control-Request-Method': 'DELETE',
                'Access-Control-Request-Headers': 'Authorization',
            })
            self.assertEqual(response.status_code, expected)
            self.assertNotIn('access-control-allow-credentials', response.headers)
        self.assertEqual(self.client.get('/health').status_code, 200)
        self.assertEqual(self.client.get('/api/stocks/AAPL/quote').status_code, 200)
        self.assertEqual(self.client.get('/api/me', headers={'Authorization': 'Bearer TEST'}).json(), {'user_id': USER})


class WatchlistAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        environment = patch.dict('os.environ', {'MARKET_DATA_PROVIDER': 'demo', 'RESEARCH_ENABLED': 'false'}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        guard = patch('httpx.AsyncHTTPTransport.handle_async_request', side_effect=AssertionError('Live network forbidden'))
        mock = guard.start()
        self.addCleanup(guard.stop)
        self.addCleanup(mock.assert_not_called)
        lifespan = app.router.lifespan_context(app)
        await lifespan.__aenter__()
        self.addAsyncCleanup(lifespan.__aexit__, None, None, None)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test')
        self.addAsyncCleanup(self.client.aclose)

    def wire(self, auth, data):
        a = httpx.AsyncClient(transport=httpx.MockTransport(auth))
        d = httpx.AsyncClient(transport=httpx.MockTransport(data))
        self.addAsyncCleanup(a.aclose)
        self.addAsyncCleanup(d.aclose)
        app.state.identity = IdentityVerifier(a, URL, KEY)
        app.state.watchlist = WatchlistService(d, URL, KEY)
        return d

    async def test_concurrent_token_and_owner_isolation(self):
        owners = {'Bearer FIRST': USER, 'Bearer SECOND': OTHER}
        ready, seen = asyncio.Event(), []

        async def data(request):
            seen.append(request)
            if len(seen) == 2:
                ready.set()
            await ready.wait()
            owner = owners[request.headers['authorization']]
            self.assertEqual(request.url.params['user_id'], 'eq.' + owner)
            return httpx.Response(200, json=[row(owner=owner)])

        d = self.wire(lambda r: httpx.Response(200, json={'id': owners[r.headers['authorization']]}), data)
        responses = await asyncio.wait_for(asyncio.gather(*[
            self.client.get('/api/watchlist', headers={'Authorization': token}) for token in owners
        ]), 1)
        self.assertTrue(all(response.status_code == 200 for response in responses))
        self.assertNotIn('authorization', d.headers)

    async def test_total_budget_includes_auth_and_body_without_write_retry(self):
        calls, closed = [], asyncio.Event()

        async def auth(request):
            await asyncio.sleep(0.03)
            return httpx.Response(200, json={'id': USER})

        class Body(httpx.AsyncByteStream):
            async def __aiter__(self):
                await asyncio.sleep(0.04)
                yield json.dumps([row()]).encode()

            async def aclose(self):
                closed.set()

        def data(request):
            calls.append(request)
            return httpx.Response(201, stream=Body())

        self.wire(auth, data)
        with patch('app.watchlist.WATCHLIST_DEADLINE', 0.06):
            response = await self.client.post('/api/watchlist', headers={'Authorization': 'Bearer TEST'},
                                              json={'symbol': 'AAPL'})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertEqual(len(calls), 1)
        self.assertTrue(closed.is_set())
        self.assertIn('may have completed', response.text)

    async def test_auth_deadline_prevents_database_request(self):
        async def auth(request):
            await asyncio.sleep(60)

        self.wire(auth, lambda request: self.fail('No database request'))
        with patch('app.watchlist.WATCHLIST_DEADLINE', 0.01):
            response = await self.client.get('/api/watchlist', headers={'Authorization': 'Bearer TEST'})
        self.assertEqual(response.status_code, 503)

    async def test_cancellation_propagates(self):
        started, cancelled = asyncio.Event(), asyncio.Event()

        async def data(request):
            started.set()
            try:
                await asyncio.sleep(60)
            finally:
                cancelled.set()

        self.wire(lambda request: httpx.Response(200, json={'id': USER}), data)
        task = asyncio.create_task(self.client.delete('/api/watchlist/AAPL', headers={'Authorization': 'Bearer TEST'}))
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(cancelled.is_set())
