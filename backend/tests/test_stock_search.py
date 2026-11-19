import asyncio
import json
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from app.main import app
from app.market_data import MarketData, ProviderBudget, QuoteError
from app.stock_search import (
    CAPACITY,
    MAX_BYTES,
    TTL,
    StockSearch,
    _diagnostic,
    parse_matches,
)

KEY = 'synthetic-private-key'


def row(symbol='TEST.A', **changes):
    # Entirely self-authored provisional schema; not a captured provider response.
    return {'1. symbol': symbol, '2. name': 'Synthetic Company', '3. type': 'Equity',
            '4. region': 'United States', '5. marketOpen': '09:30', '6. marketClose': '16:00',
            '7. timezone': 'UTC-04', '8. currency': 'USD', '9. matchScore': '0.9000', **changes}


def body(*rows):
    return json.dumps({'bestMatches': list(rows)}).encode()


class ParserTests(unittest.TestCase):
    def test_diagnostics_are_fixed_and_distinguish_validation_stages(self):
        secret = 'SENTINEL https://private.invalid/?apikey=SECRET private-query'
        missing = row(); del missing['7. timezone']
        cases = [(secret.encode(), 'json', 'none', 'decode'),
                 (b'{"bestMatches":[],"bestMatches":[]}', 'json', 'none', 'duplicate_key'),
                 (b'null', 'root', 'none', 'object'),
                 (b'{}', 'root', 'none', 'fields'),
                 (b'{"bestMatches":{}}', 'matches', 'none', 'list'),
                 (body(*[row()]*21), 'matches', 'none', 'count'),
                 (body(None), 'row', 'none', 'object'),
                 (body(missing), 'field', 'provider_timezone', 'missing'),
                 (body(row(**{secret: secret})), 'row', 'none', 'unexpected'),
                 (body(row(**{'2. name': secret+'\n'})), 'field', 'name', 'control_character'),
                 (body(row('TEST@A')), 'field', 'symbol', 'symbol_format'),
                 (body(row(), row()), 'field', 'symbol', 'duplicate_symbol')]
        for key, value, field, rule in [
            ('5. marketOpen', '24:00', 'market_open', 'time_format'),
            ('6. marketClose', '24:00', 'market_close', 'time_format'),
            ('8. currency', 'usd', 'currency', 'currency_format'),
            ('9. matchScore', '1e0', 'match_score', 'score_format'),
        ]:
            cases.append((body(row(**{key: value, '3. type': 'ETF'})), 'field', field, rule))
        for raw, stage, field, rule in cases:
            with self.subTest(stage=stage, rule=rule), self.assertLogs('app.stock_search') as logs, self.assertRaises(QuoteError) as caught:
                parse_matches(raw)
            self.assertEqual(caught.exception.detail, 'Search provider returned invalid data.')
            self.assertEqual(len(logs.records), 1)
            self.assertEqual(logs.records[0].getMessage(), f'Stock search diagnostic stage={stage} field={field} rule={rule}')
            self.assertIsNone(logs.records[0].exc_info)
            self.assertNotIn(secret, str(logs.records[0].__dict__))
        with self.assertNoLogs('app.stock_search'):
            _diagnostic(secret, 'none', 'decode')
            _diagnostic('field', secret, 'text')
            _diagnostic('field', 'name', secret)

    def test_notice_and_valid_empty_diagnostics(self):
        for message, rule, status in [('API quota exhausted', 'quota', 429), (KEY, 'other', 502)]:
            with self.assertLogs('app.stock_search') as logs, self.assertRaises(QuoteError) as caught:
                parse_matches(json.dumps({'Information': message}).encode())
            self.assertEqual(caught.exception.status, status)
            self.assertEqual(logs.records[0].getMessage(), f'Stock search diagnostic stage=notice field=none rule={rule}')
            self.assertNotIn(KEY, str(logs.records[0].__dict__))
        for raw, rule in [(body(), 'no_matches'), (body(row(**{'3. type': 'ETF'})), 'filtered')]:
            with self.assertLogs('app.stock_search', level='INFO') as logs:
                self.assertEqual(parse_matches(raw), ())
            self.assertEqual(logs.records[0].getMessage(), f'Stock search diagnostic stage=empty field=none rule={rule}')

    def test_timezone_is_required_bounded_display_metadata(self):
        # Synthetic strings, not captured live responses or verified timezone identifiers.
        for value in ['UTC-05', 'UTC-05:00', 'UTC+05:30', 'US/Eastern', 'Provider zone label', 'x'*200]:
            with self.subTest(value=value):
                result = parse_matches(body(row(**{'7. timezone': value})))
                self.assertEqual(result[0].provider_timezone, value)
                self.assertEqual(parse_matches(body(row(**{'3. type': 'ETF', '7. timezone': value}))), ())
        for value in ['', None, True, 5, [], {}, 'x'*201, 'UTC-05\n', 'UTC\x00zone', 'UTC\u200bzone', ' UTC-05']:
            for kind in ['Equity', 'ETF']:
                with self.subTest(kind=kind), self.assertLogs('app.stock_search') as logs, self.assertRaises(QuoteError) as caught:
                    parse_matches(body(row(**{'7. timezone': value, '3. type': kind})))
                self.assertEqual(caught.exception.status, 502)
                self.assertEqual(logs.records[0].getMessage(),
                                 'Stock search diagnostic stage=field field=provider_timezone rule=text')

    def test_name_formatting_and_precise_safe_diagnostics(self):
        # Synthetic formatting cases, never claimed to reproduce the live names.
        for name in ['Synthetic Company', 'Synthetic  Company', 'A&B Holdings, Inc. - Class A',
                     "L’Exemple Société (Test)", 'Synthetic\u00a0Company', 'x'*200]:
            self.assertEqual(parse_matches(body(row(**{'2. name': name})))[0].name, name)
        secret = 'SENTINEL https://private.invalid/?apikey=SECRET private-query'
        cases = [(None, 'wrong_type'), (42, 'wrong_type'), (True, 'wrong_type'),
                 ({'private': secret}, 'wrong_type'), ([secret], 'wrong_type'),
                 ('', 'empty'), (secret*10, 'over_length'),
                 ('   ', 'empty'), ('\u00a0'+secret, 'surrounding_whitespace'),
                 (secret+'\n', 'control_character'), (secret+'\t', 'control_character'),
                 (secret+'\x00', 'control_character'), (secret+'\u200b', 'control_character')]
        for kind in ['Equity', 'ETF']:
            missing = row(**{'3. type': kind}); del missing['2. name']
            rows = [(missing, 'missing')] + [(row(**{'3. type': kind, '2. name': name}), rule)
                                           for name, rule in cases]
            for invalid, rule in rows:
                with self.subTest(kind=kind, rule=rule), self.assertLogs('app.stock_search') as logs, self.assertRaises(QuoteError) as caught:
                    # A valid preceding match must not turn a malformed row into partial success.
                    parse_matches(body(row('VALID'), invalid))
                self.assertEqual(caught.exception.status, 502)
                self.assertEqual(caught.exception.detail, 'Search provider returned invalid data.')
                self.assertEqual(len(logs.records), 1)
                self.assertEqual(logs.records[0].getMessage(),
                                 f'Stock search diagnostic stage=field field=name rule={rule}')
                self.assertIsNone(logs.records[0].exc_info)
                self.assertNotIn(secret, str(logs.records[0].__dict__))
        self.assertEqual(parse_matches(body(row(**{'3. type': 'ETF'}))), ())

    def test_names_trim_only_ordinary_edge_spaces_after_raw_validation(self):
        # Synthetic names: no claim about the exact name rejected by the live provider.
        expected = "L’Exemple  Société, Inc. (Class A) & Co"
        for name in [expected, ' '+expected, expected+' ', '  '+expected+'   ']:
            result = parse_matches(body(row(**{'2. name': name})))
            self.assertEqual(result[0].name, expected)
            self.assertEqual(result[0].symbol, 'TEST.A')
            self.assertEqual(parse_matches(body(row(**{'2. name': name, '3. type': 'ETF'}))), ())
        self.assertEqual(parse_matches(body(row(**{'2. name': ' '+('x'*198)+' '})))[0].name, 'x'*198)
        for name, rule in [(' '*201, 'over_length'), (' '+('x'*199)+' ', 'over_length'),
                           ('  \tName  ', 'control_character'), ('  Name\n  ', 'control_character'),
                           ('  Name\u200b  ', 'control_character'), ('  Name\x00  ', 'control_character'),
                           ('  \u00a0Name  ', 'surrounding_whitespace')]:
            with self.assertLogs('app.stock_search') as logs, self.assertRaises(QuoteError):
                parse_matches(body(row(**{'2. name': name})))
            self.assertEqual(logs.records[0].getMessage(),
                             f'Stock search diagnostic stage=field field=name rule={rule}')
        # Other metadata is not normalized, even when the name could be normalized.
        for key in ['1. symbol', '3. type', '4. region', '8. currency']:
            with self.assertRaises(QuoteError):
                parse_matches(body(row(**{'2. name': ' Name ', key: ' '+row()[key]})))

    def test_exact_symbols_and_filtering(self):
        matches = parse_matches(body(row(), row('TEST-B'), row('TEST/C'), row('OTHER', **{'3. type': 'ETF'}),
                                     row('FOREIGN', **{'4. region': 'Canada', '8. currency': 'CAD'})))
        self.assertEqual([m.symbol for m in matches], ['TEST.A', 'TEST-B', 'TEST/C'])
        self.assertEqual(parse_matches(body()), ())
        self.assertEqual(parse_matches(body(row(**{'8. currency': 'EUR'}))), ())

    def test_invalid_rows_never_become_empty(self):
        invalid = [b'{}', b'null', b'{"bestMatches":[],"bestMatches":[]}', body(*[row()]*21)]
        for field in row():
            item = row(); del item[field]; invalid.append(body(item))
        for changes in [{'9. matchScore': 'NaN'}, {'5. marketOpen': '25:00'}, {'7. timezone': ''},
                        {'1. symbol': '<script>'}, {'2. name': '\x00secret'}, {'8. currency': None}, {'extra': 'x'}]:
            invalid.append(body(row(**changes)))
        invalid.append(body(row(), row()))
        invalid.append(body(row(**{'3. type': 'ETF', '9. matchScore': 'bad'})))
        for raw in invalid:
            with self.subTest(raw=raw), self.assertRaises(QuoteError) as caught:
                parse_matches(raw)
            self.assertEqual(caught.exception.status, 502)


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls, self.now = [], 0
        self.response = lambda req: httpx.Response(200, content=body(row()))
        async def transport(req):
            self.calls.append(req)
            answer = self.response(req)
            return await answer if asyncio.iscoroutine(answer) else answer
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(transport), trust_env=False)
        self.budget = ProviderBudget(lambda: self.now)
        self.service = StockSearch(self.client, budget=self.budget, enabled=True, api_key=KEY, clock=lambda: self.now)

    async def asyncTearDown(self):
        await self.service.close()
        await self.client.aclose()

    async def test_cache_expiry_bounds_and_shared_budget(self):
        first = await self.service.search(' Test.A ')
        second = await self.service.search('Test.A')
        self.assertTrue(second.cache_hit)
        self.assertEqual(first.fetched_at, second.fetched_at)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(dict(self.calls[0].url.params), {'function': 'SYMBOL_SEARCH', 'keywords': 'Test.A', 'datatype': 'json', 'apikey': KEY})
        self.now = TTL
        self.assertFalse((await self.service.search('Test.A')).cache_hit)
        for i in range(CAPACITY + 2):
            self.now += 86401
            await self.service.search(str(i))
        self.assertEqual(len(self.service.cache), CAPACITY)
        self.budget.attempts.extend([self.now] * 19)
        quotes = MarketData(self.client, provider='alpha_vantage', api_key=KEY, budget=self.budget)
        for operation in (lambda: self.service.search('new'), lambda: quotes.get_quote('AAPL')):
            before = len(self.calls)
            with self.assertRaises(QuoteError) as caught:
                await operation()
            self.assertEqual(caught.exception.status, 429)
            self.assertEqual(len(self.calls), before)
        await quotes.close()

    async def test_disabled_missing_key_and_invalid_input(self):
        for value in ['', ' '*4, 'a'*81, 'test\n', 'a\x00b']:
            with self.assertRaises(QuoteError):
                await self.service.search(value)
        self.service.enabled = False
        with self.assertRaises(QuoteError):
            await self.service.search('test')
        self.service.enabled = True; self.service.api_key = ''
        with self.assertRaises(QuoteError):
            await self.service.search('test')
        self.assertEqual(self.calls, [])

    async def test_coalescing_cancellation_and_close(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def respond(req):
            entered.set(); await release.wait()
            return httpx.Response(200, content=body(row()))
        self.response = respond
        first = asyncio.create_task(self.service.search('test'))
        await entered.wait()
        second = asyncio.create_task(self.service.search('test'))
        await asyncio.sleep(0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        release.set()
        self.assertEqual((await second).matches[0].symbol, 'TEST.A')
        self.assertEqual(len(self.calls), 1)
        release.clear(); entered.clear()
        pending = asyncio.create_task(self.service.search('other'))
        await entered.wait(); await self.service.close()
        with self.assertRaises(asyncio.CancelledError):
            await pending

    async def test_size_diagnostic_redacts_body_and_query(self):
        self.response = lambda req: httpx.Response(200, content=KEY.encode()*MAX_BYTES)
        with self.assertLogs('app.stock_search') as logs, self.assertRaises(QuoteError) as caught:
            await self.service.search('private-query')
        self.assertEqual(caught.exception.detail, 'Search provider returned invalid data.')
        self.assertEqual(logs.records[0].getMessage(), 'Stock search diagnostic stage=body field=none rule=size')
        self.assertNotIn(KEY, str(logs.records[0].__dict__))
        self.assertNotIn('private-query', str(logs.records[0].__dict__))

    async def test_safe_errors_notices_size_and_timeout(self):
        cases = [(429, body(), 429), (302, KEY.encode(), 502), (500, KEY.encode(), 502),
                 (200, b'x'*(MAX_BYTES+1), 502), (200, KEY.encode(), 502)]
        for notice, status in [('API quota exhausted', 429), ('Requests are throttled', 429),
                               ('Premium access; rate limit 25 requests per day', 502), ('Unknown', 502)]:
            cases.append((200, json.dumps({'Information': notice + ' ' + KEY}).encode(), status))
        for index, (status, raw, expected) in enumerate(cases):
            self.response = lambda req, status=status, raw=raw: httpx.Response(status, content=raw)
            with self.assertRaises(QuoteError) as caught:
                await self.service.search(str(index))
            self.assertEqual(caught.exception.status, expected)
            self.assertNotIn(KEY, str(caught.exception))
        for error, expected in [(httpx.ReadTimeout(KEY), 504), (httpx.ConnectError(KEY), 502)]:
            def fail(req, error=error):
                raise error
            self.response = fail
            with self.assertRaises(QuoteError) as caught:
                await self.service.search('timeout')
            self.assertEqual(caught.exception.status, expected)
            self.assertNotIn(KEY, str(caught.exception))
        async def hang(req):
            await asyncio.Event().wait()
        self.response = hang
        with patch('app.stock_search.DEADLINE', .01), self.assertRaises(QuoteError) as caught:
            await self.service.search('hang')
        self.assertEqual(caught.exception.status, 504)


class RouteTests(unittest.TestCase):
    def test_opt_in_query_validation_and_existing_routes(self):
        for flag, key in [(None, KEY), ('TRUE', KEY), ('false', KEY), ('true', '')]:
            env = {'MARKET_DATA_PROVIDER': 'demo', 'RESEARCH_ENABLED': 'false', 'ALPHA_VANTAGE_API_KEY': key}
            if flag is not None:
                env['STOCK_SEARCH_ENABLED'] = flag
            with patch.dict('os.environ', env, clear=True), patch('httpx.AsyncHTTPTransport.handle_async_request', side_effect=AssertionError('No network')) as network, TestClient(app) as client:
                self.assertEqual(client.get('/api/stocks/search?q=test').status_code, 503)
                for query in ['', '?q=', '?q=a&q=b', '?q=a&extra=b', '?q=a%0Ab']:
                    self.assertEqual(client.get('/api/stocks/search'+query).status_code, 422)
                self.assertEqual(client.get('/health').status_code, 200)
                self.assertEqual(client.get('/api/stocks/AAPL/quote').status_code, 200)
                network.assert_not_called()

    def test_enabled_route_uses_shared_service_and_serializes(self):
        with patch.dict('os.environ', {'STOCK_SEARCH_ENABLED': 'true', 'ALPHA_VANTAGE_API_KEY': KEY,
                                      'MARKET_DATA_PROVIDER': 'demo', 'RESEARCH_ENABLED': 'false'}, clear=True), TestClient(app) as client:
            calls = []
            async def respond(transport, req):
                calls.append(req)
                return httpx.Response(200, content=body(row()))
            with patch('httpx.AsyncHTTPTransport.handle_async_request', respond):
                first = client.get('/api/stocks/search?q=Test')
                second = client.get('/api/stocks/search?q=Test')
            self.assertEqual(first.status_code, 200)
            self.assertEqual(first.json()['matches'][0]['symbol'], 'TEST.A')
            self.assertTrue(second.json()['cache_hit'])
            self.assertEqual(len(calls), 1)
            self.assertIs(app.state.stock_search.budget, app.state.market_data.budget)
            self.assertIs(app.state.stock_search.budget, app.state.historical_data.budget)
