import asyncio
import unittest
from unittest.mock import patch

import httpx
from fastapi import HTTPException

from app.auth import (
    MAX_CREDENTIAL_LENGTH,
    REJECTED_CODES,
    IdentityVerifier,
    bearer_token,
)

URL = 'https://example.supabase.co'
KEY = 'sb_publishable_TEST_ONLY'
USER = '12345678-1234-4234-8234-123456789abc'


class CredentialTests(unittest.TestCase):
    def test_header_validation(self):
        for headers in [[], ['Bearer a', 'Bearer b'], [''], ['Basic abc'], ['Bearer'],
                        ['Bearer a,b'], ['Bearer a b'], ['Bearer a\n'], ['Bearer é'],
                        ['Bearer ' + 'a' * MAX_CREDENTIAL_LENGTH]]:
            with self.subTest(headers=headers), self.assertRaises(HTTPException) as error:
                bearer_token(headers)
            self.assertEqual(error.exception.status_code, 401)
        self.assertEqual(bearer_token(['bEaReR abc.def-_/+~==']), 'abc.def-_/+~==')
        self.assertEqual(len(bearer_token(['Bearer ' + 'a' * (MAX_CREDENTIAL_LENGTH - 7)])),
                         MAX_CREDENTIAL_LENGTH - 7)


class VerificationTests(unittest.IsolatedAsyncioTestCase):
    async def run_response(self, response):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: response)) as client:
            return await IdentityVerifier(client, URL, KEY).verify('TEST_TOKEN')

    async def test_success_and_no_cache(self):
        calls = []

        def handle(request):
            calls.append(request)
            self.assertEqual(str(request.url), URL + '/auth/v1/user')
            self.assertEqual(request.method, 'GET')
            self.assertEqual(request.headers['apikey'], KEY)
            self.assertEqual(request.headers['authorization'], 'Bearer TEST_TOKEN')
            return httpx.Response(200, json={'id': USER, 'email': 'not-returned@example.com'})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            verifier = IdentityVerifier(client, URL, KEY)
            for _ in range(2):
                self.assertEqual((await verifier.verify('TEST_TOKEN')).model_dump(mode='json'), {'user_id': USER})
            self.assertNotIn('authorization', client.headers)
        self.assertEqual(len(calls), 2)

    async def test_documented_rejections(self):
        for code in REJECTED_CODES:
            with self.subTest(code=code), self.assertRaises(HTTPException) as error:
                await self.run_response(httpx.Response(403, json={'code': code, 'msg': 'PRIVATE'}))
            self.assertEqual(error.exception.status_code, 401)
            self.assertNotIn('PRIVATE', str(error.exception))

    async def test_unavailable_responses(self):
        cases = [httpx.Response(200, content=b'not json'), httpx.Response(200, content=b'\xff')]
        cases += [httpx.Response(200, json=body) for body in [None, [], {}, {'id': None},
                  {'id': 123}, {'id': 'invalid'}, {'user': {'id': USER}}]]
        cases += [httpx.Response(status, json={'code': 'bad_jwt', 'msg': 'PRIVATE'})
                  for status in [301, 302, 307, 429, 500, 503]]
        cases += [httpx.Response(401, json=body) for body in [None, {}, {'code': []},
                  {'message': 'Invalid API key PRIVATE'}, {'code': 'unexpected_failure'}]]
        for response in cases:
            with self.subTest(status=response.status_code), self.assertRaises(HTTPException) as error:
                await self.run_response(response)
            self.assertEqual(error.exception.status_code, 503)
            self.assertNotIn('PRIVATE', str(error.exception))

    async def test_configuration_without_requests(self):
        def forbidden(request):
            self.fail('Unexpected request')

        async with httpx.AsyncClient(transport=httpx.MockTransport(forbidden)) as client:
            cases = [(url, KEY) for url in ['', 'http://example.supabase.co', URL + '/auth/v1',
                     URL + '?x=1', URL + '#fragment', 'https://user:pass@example.supabase.co',
                     'https://example.supabase.co.evil.com', 'https://localhost', URL + ':443',
                     ' ' + URL, URL + '\n']]
            cases += [(URL, key) for key in ['', 'sb_secret_PRIVATE', 'legacy.jwt.key', KEY + '\n']]
            for url, key in cases:
                with self.subTest(url=url), self.assertRaises(HTTPException) as error:
                    await IdentityVerifier(client, url, key).verify('TEST_TOKEN')
                self.assertEqual(error.exception.status_code, 503)

    async def test_transport_failures_are_safe(self):
        for failure in [httpx.ConnectError, httpx.ReadTimeout, httpx.RemoteProtocolError]:
            def handle(request, failure=failure):
                raise failure('PRIVATE TOKEN HEADER')

            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                with self.assertRaises(HTTPException) as error:
                    await IdentityVerifier(client, URL, KEY).verify('TEST_TOKEN')
                self.assertEqual(error.exception.status_code, 503)
                self.assertNotIn('PRIVATE', str(error.exception))

    async def test_deadline_includes_body_read_and_closes_stream(self):
        closed = asyncio.Event()

        class SlowBody(httpx.AsyncByteStream):
            async def __aiter__(self):
                await asyncio.sleep(60)
                yield b'{}'

            async def aclose(self):
                closed.set()

        async with httpx.AsyncClient(transport=httpx.MockTransport(
            lambda request: httpx.Response(200, stream=SlowBody()),
        )) as client:
            with self.assertRaises(HTTPException) as error, patch('app.auth.VERIFICATION_DEADLINE', 0.01):
                await IdentityVerifier(client, URL, KEY).verify('TEST_TOKEN')
        self.assertEqual(error.exception.status_code, 503)
        self.assertTrue(closed.is_set())

    async def test_cancellation_propagates(self):
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def handle(request):
            started.set()
            try:
                await asyncio.sleep(60)
            finally:
                cancelled.set()

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            task = asyncio.create_task(IdentityVerifier(client, URL, KEY).verify('TEST_TOKEN'))
            await started.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertTrue(cancelled.is_set())

    async def test_concurrent_credentials_are_isolated(self):
        seen = []
        ready = asyncio.Event()
        identities = {'Bearer FIRST': USER, 'Bearer SECOND': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}

        async def handle(request):
            seen.append(request)
            if len(seen) == 2:
                ready.set()
            await ready.wait()
            return httpx.Response(200, json={'id': identities[request.headers['authorization']]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            verifier = IdentityVerifier(client, URL, KEY)
            first, second = await asyncio.wait_for(asyncio.gather(
                verifier.verify('FIRST'), verifier.verify('SECOND'),
            ), 1)
            self.assertEqual(str(first.user_id), identities['Bearer FIRST'])
            self.assertEqual(str(second.user_id), identities['Bearer SECOND'])
            self.assertNotIn('authorization', client.headers)
