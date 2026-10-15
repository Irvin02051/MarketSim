import asyncio
import base64
import copy
import json
import unittest
from datetime import date
from unittest.mock import AsyncMock, call, patch

import httpx
from pydantic import ValidationError
from test_research import quote

from app.gemini_client import GeminiClient
from app.market_data import MarketData, QuoteError
from app.research_agent import ResearchAgent

QUESTION = 'Compare Apple and Microsoft’s reported percentage changes.'


def response(parts, *, reason='STOP'):
    return {'candidates': [{'finishReason': reason, 'content': {'role': 'model', 'parts': parts}}]}


def tool(symbols=None, *, name='get_quotes', args=None, call_id='call-1'):
    return {'functionCall': {'id': call_id, 'name': name,
                             'args': {'symbols': symbols} if args is None else args}}


def final(status='answered', findings=None):
    return response([{'text': json.dumps({'status': status, 'findings': findings or []})}])


def tool_payload(body):
    return body['contents'][-1]['parts'][-1]['functionResponse']['response']


def choose_difference(body):
    findings = tool_payload(body)['candidate_findings']
    return final(findings=[next(item for item in findings if item['kind'] == 'difference')])


class ResearchAgentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.environment = patch.dict('os.environ', {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.network_guards = []
        for transport, method in [('AsyncHTTPTransport', 'handle_async_request'),
                                  ('HTTPTransport', 'handle_request')]:
            guard = patch(f'httpx.{transport}.{method}',
                          side_effect=AssertionError('External requests forbidden'))
            self.network_guards.append(guard.start())
            self.addCleanup(guard.stop)
        self.service = AsyncMock(spec=MarketData)
        self.fixture = {'AAPL': quote(), 'MSFT': quote('MSFT', change_percent=-1),
                        'NVDA': quote('NVDA', change_percent=10)}
        self.service.get_quote.side_effect = lambda symbol: self.fixture[symbol]
        self.script = []
        self.requests = []
        self.bodies = []

        async def handle(request):
            self.requests.append(request)
            body = json.loads(request.content)
            self.bodies.append(body)
            if not self.script:
                self.fail('SDK made an unplanned model request')
            action = self.script.pop(0)
            if isinstance(action, Exception):
                raise action
            value = action(body) if callable(action) else action
            if asyncio.iscoroutine(value):
                value = await value
            return value if isinstance(value, httpx.Response) else httpx.Response(200, json=value)

        self.http = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        self.model = GeminiClient('FAKE_AGENT_KEY', http_client=self.http)
        self.agent = ResearchAgent(self.model)

    async def asyncTearDown(self):
        await self.model.close()
        self.assertTrue(self.http.is_closed)
        for guard in self.network_guards:
            guard.assert_not_called()

    async def run_agent(self, question=QUESTION):
        return await self.agent.run(self.service, {'question': question})

    async def test_natural_language_sdk_exchange_preserves_ids_parts_and_signatures(self):
        signature = base64.b64encode(b'opaque-test-signature').decode()
        parts = [
            {'thought': True, 'text': 'PRIVATE_REASONING', 'thoughtSignature': signature},
            {'text': 'I will inspect the requested quotes.'},
            tool(['aapl', 'MSFT'], call_id='correlation-17') | {'thoughtSignature': signature},
        ]

        def first(body):
            self.service.get_quote.assert_not_called()  # Model chooses before retrieval.
            self.assertEqual(body['contents'][0]['parts'][0]['text'], QUESTION)
            declarations = body['tools'][0]['functionDeclarations']
            self.assertEqual([item['name'] for item in declarations], ['get_quotes'])
            self.assertFalse(declarations[0]['parameters_json_schema']['additionalProperties'])
            self.assertEqual(body['toolConfig']['functionCallingConfig']['mode'], 'AUTO')
            return response(parts)

        self.script = [first, choose_difference]
        result = await self.run_agent()
        self.assertEqual(result.explanation.status, 'answered')
        self.assertEqual(result.model_calls, 2)
        self.assertEqual(result.tool_requests, 1)
        self.assertEqual(self.service.get_quote.await_args_list, [call('AAPL'), call('MSFT')])
        sent = self.bodies[1]['contents']
        self.assertEqual(sent[1], {'role': 'model', 'parts': parts})
        self.assertEqual(sent[2]['role'], 'user')
        function_result = sent[2]['parts'][0]['functionResponse']
        self.assertEqual(function_result['id'], 'correlation-17')
        self.assertEqual(function_result['name'], 'get_quotes')
        self.assertEqual(function_result['response']['result']['data_mode'], 'fictional')
        self.assertIn('FICTIONAL', result.quotes.label)
        self.assertEqual(result.quotes.evidence[0].quote, self.fixture['AAPL'])
        self.assertIn('3.5 percentage points', result.explanation.findings[0].statement)
        self.assertEqual(result.explanation.findings[0].statement_origin, 'backend')
        self.assertNotIn('PRIVATE_REASONING', result.model_dump_json())
        self.assertNotIn(signature, result.model_dump_json())
        for request in self.requests:
            self.assertLessEqual(request.extensions['timeout']['read'], 20)

    async def test_model_can_select_a_different_supported_symbol(self):
        def choose_range(body):
            return final(findings=[tool_payload(body)['candidate_findings'][0]])

        self.script = [response([tool(['NVDA'])]), choose_range]
        result = await self.run_agent('What is Nvidia’s reported daily range?')
        self.service.get_quote.assert_awaited_once_with('NVDA')
        self.assertEqual(result.explanation.status, 'answered')
        self.assertIn('NVDA', result.explanation.findings[0].statement)

    async def test_invalid_inputs_precede_model_and_quote_calls(self):
        for data in [{}, {'question': ' '}, {'question': 4}, {'question': 'a' * 1001},
                     {'question': QUESTION, 'symbols': ['AAPL']}]:
            with self.subTest(data=data), self.assertRaises(ValidationError):
                await self.agent.run(self.service, data)
        self.assertEqual(self.requests, [])
        self.service.get_quote.assert_not_called()

    async def test_unknown_tools_and_invalid_arguments_never_execute(self):
        bad_calls = [tool(name='https://example.com/SECRET', args={'command': 'print(1)'}),
                     tool([]), tool(['AAPL', 'TSLA']), tool(['AAPL', 'aapl']),
                     tool(['AAPL', 'MSFT', 'NVDA', 'AAPL']), tool([' AAPL']),
                     tool(args={'symbols': ['AAPL'], 'url': 'SECRET'}),
                     tool(args={'symbols': 'AAPL'}), tool(args={'symbols': [42]})]
        for invalid in bad_calls:
            self.script = [response([invalid]), final('clarification')]
            result = await self.run_agent()
            self.assertEqual(result.tool_requests, 1)
            self.assertIn(result.tool_outcomes[0].code, ['unknown_tool', 'invalid_tool_arguments'])
            self.assertEqual(result.explanation.status, 'clarification')
            self.assertNotIn('SECRET', result.model_dump_json())
        self.service.get_quote.assert_not_called()

    async def test_invalid_tool_can_be_corrected_within_budget(self):
        self.script = [response([tool(['AAPL', 'TSLA'])]),
                       response([tool(['AAPL', 'MSFT'], call_id='corrected')]), choose_difference]
        result = await self.run_agent()
        self.assertEqual(result.explanation.status, 'answered')
        self.assertEqual((result.model_calls, result.tool_requests), (3, 2))
        self.assertEqual(self.bodies[-1]['generationConfig']['responseMimeType'], 'application/json')
        self.assertFalse(self.bodies[-1].get('tools'))

    async def test_repeated_symbols_use_identical_evidence_and_stable_ids(self):
        def second(body):
            self.first_bundle = copy.deepcopy(tool_payload(body)['result'])
            return response([tool(['MSFT', 'aapl'], call_id='second')])

        self.script = [response([tool(['AAPL'])]), second, choose_difference]
        result = await self.run_agent()
        self.assertEqual(result.explanation.status, 'answered')
        self.assertEqual(self.service.get_quote.await_args_list, [call('AAPL'), call('MSFT')])
        self.assertEqual(result.quotes.requested_symbols, ['AAPL', 'MSFT'])
        self.assertEqual(result.quotes.evidence[0].model_dump(mode='json'), self.first_bundle['evidence'][0])
        self.assertEqual([item.id for item in result.quotes.evidence], ['q1', 'q2'])
        self.assertEqual([item.code for item in result.tool_outcomes], ['ok', 'ok'])

    async def test_multi_tool_batch_is_sequential_and_correlated(self):
        active = 0

        async def fetch(symbol):
            nonlocal active
            active += 1
            self.assertEqual(active, 1)
            await asyncio.sleep(0)
            active -= 1
            return self.fixture[symbol]

        self.service.get_quote.side_effect = fetch
        self.script = [response([tool(['AAPL'], call_id='a'), tool(['MSFT'], call_id='b')]),
                       choose_difference]
        result = await self.run_agent()
        self.assertEqual(result.explanation.status, 'answered')
        replies = self.bodies[1]['contents'][-1]['parts']
        self.assertEqual([p['functionResponse']['id'] for p in replies], ['a', 'b'])
        self.assertEqual(result.tool_requests, 2)

    async def test_oversized_batch_rejected_before_any_execution(self):
        self.script = [response([tool(['AAPL'], call_id=str(i)) for i in range(3)])]
        result = await self.run_agent()
        self.assertEqual(result.explanation.code, 'tool_budget_exhausted')
        self.assertEqual((result.model_calls, result.tool_requests), (1, 3))
        self.service.get_quote.assert_not_called()

    async def test_remaining_tool_budget_counts_unknown_requests(self):
        self.script = [response([tool(name='shell', args={})]), response([
            tool(['AAPL'], call_id='a'), tool(['MSFT'], call_id='b'),
        ])]
        result = await self.run_agent()
        self.assertEqual(result.explanation.code, 'tool_budget_exhausted')
        self.assertEqual(result.tool_requests, 3)
        self.service.get_quote.assert_not_called()

    async def test_model_budget_stops_third_turn_tool_request(self):
        self.script = [response([tool(['AAPL'], call_id=str(i))]) for i in range(3)]
        result = await self.run_agent()
        self.assertEqual(result.explanation.code, 'model_budget_exhausted')
        self.assertEqual(result.model_calls, 3)
        self.assertEqual(len(self.requests), 3)
        self.service.get_quote.assert_awaited_once_with('AAPL')
        self.assertEqual(len(result.tool_outcomes), 2)

    async def test_duplicate_call_ids_rejected_before_batch_execution(self):
        self.script = [response([tool(['AAPL']), tool(['MSFT'])])]
        result = await self.run_agent()
        self.assertEqual(result.explanation.code, 'invalid_model_output')
        self.assertEqual(result.tool_requests, 2)
        self.service.get_quote.assert_not_called()

    async def test_overall_deadline_during_model_and_tool_operations(self):
        self.agent.deadline = 0.02

        async def slow(*args):
            await asyncio.Event().wait()

        self.script = [slow]
        result = await self.run_agent()
        self.assertEqual(result.explanation.code, 'research_timeout')
        self.assertLessEqual(self.requests[-1].extensions['timeout']['read'], 0.02)
        self.assertEqual(result.model_calls, 1)
        self.service.get_quote.assert_not_called()

        async def partial(symbol):
            return self.fixture[symbol] if symbol == 'AAPL' else await slow()

        self.service.get_quote.side_effect = partial
        self.script = [response([tool(['AAPL', 'MSFT'])])]
        result = await self.run_agent()
        self.assertEqual(result.explanation.code, 'research_timeout')
        self.assertEqual(len(result.quotes.evidence), 1)
        self.assertEqual(result.quotes.errors[0].status, 504)
        self.assertEqual(result.tool_outcomes[0].code, 'research_timeout')

    async def test_provider_failures_and_date_mismatch_cannot_produce_comparisons(self):
        for values, code in [
            ([quote(), QuoteError(502, 'SECRET')], 'incomplete_evidence'),
            ([QuoteError(503, 'SECRET'), QuoteError(502, 'SECRET')], 'incomplete_evidence'),
            ([quote(), quote('MSFT', latest_trading_day=date(2026, 1, 3))], 'different_dates'),
        ]:
            self.service.get_quote.side_effect = values
            self.script = [response([tool(['AAPL', 'MSFT'])]), final(findings=[{
                'kind': 'difference', 'evidence_ids': ['q1', 'q2'],
                'calculation_ref': 'calculations.difference', 'relation': 'higher',
            }])]
            result = await self.run_agent()
            self.assertEqual(result.explanation.code, code)
            self.assertEqual(result.explanation.findings, [])
            self.assertNotIn('SECRET', result.model_dump_json())
            self.assertIsNone(result.quotes.calculations.difference)
            self.assertEqual(tool_payload(self.bodies[-1])['candidate_findings'], [])

    async def test_historical_forecasting_and_unsupported_stock_requests(self):
        for question in ['Compare historical momentum for Apple and Microsoft',
                         'Predict Nvidia tomorrow', 'What is Apple volatility?']:
            result = await self.run_agent(question)
            self.assertEqual(result.explanation.status, 'unsupported')
            self.assertEqual(result.model_calls, 0)
        self.script = [final('unsupported')]
        result = await self.run_agent('Compare Tesla and Apple')
        self.assertEqual(result.explanation.status, 'unsupported')
        self.service.get_quote.assert_not_called()

    async def test_final_without_evidence_or_with_invented_claims_is_rejected(self):
        finding = {'kind': 'difference', 'evidence_ids': ['q1', 'q2'],
                   'calculation_ref': 'calculations.difference', 'relation': 'higher'}
        self.script = [final(findings=[finding])]
        result = await self.run_agent()
        self.assertEqual(result.explanation.code, 'invalid_model_output')
        self.service.get_quote.assert_not_called()
        for invalid in [finding | {'evidence_ids': ['q1', 'invented']},
                        finding | {'relation': 'lower'}, finding | {'price': 999},
                        finding | {'evidence_ids': ['q2', 'q1']}]:
            self.script = [response([tool(['AAPL', 'MSFT'])]), final(findings=[invalid])]
            result = await self.run_agent()
            self.assertEqual(result.explanation.code, 'invalid_model_output')
            self.assertEqual(len(result.quotes.evidence), 2)

    async def test_sdk_failure_refusal_and_continuation_are_safe_and_not_retried(self):
        for value, code in [
            (httpx.Response(429, json={'error': {'code': 429, 'message': 'SECRET'}}), 'model_quota'),
            (httpx.Response(500, json={'error': {'code': 500, 'message': 'SECRET'}}), 'model_unavailable'),
            (httpx.ReadTimeout('SECRET'), 'research_timeout'),
            (response([{'text': 'SECRET'}], reason='SAFETY'), 'model_refusal'),
            (response([{'text': 'SECRET'}], reason='MAX_TOKENS'), 'model_truncated'),
            (response([{'text': 'SECRET'}], reason='CONTINUATION') | {'continuationToken': 'token'},
             'model_truncated'),
        ]:
            self.script = [value]
            before = len(self.requests)
            result = await self.run_agent()
            self.assertEqual(result.explanation.code, code)
            self.assertEqual(len(self.requests) - before, 1)
            self.assertNotIn('SECRET', result.model_dump_json())

    async def test_missing_model_and_malformed_output(self):
        result = await ResearchAgent(None).run(self.service, {'question': QUESTION})
        self.assertEqual(result.explanation.code, 'research_unavailable')
        self.script = [response([{'text': 'not JSON SECRET'}])]
        result = await self.run_agent()
        self.assertEqual(result.explanation.code, 'invalid_model_output')
        self.assertNotIn('SECRET', result.model_dump_json())

    async def test_request_state_does_not_leak_between_runs(self):
        for _ in range(2):
            self.script = [response([tool(['AAPL', 'MSFT'])]), choose_difference]
            result = await self.run_agent()
            self.assertEqual(result.model_calls, 2)
            self.assertEqual(result.tool_requests, 1)
            self.assertEqual(result.quotes.evidence[0].id, 'q1')
        self.assertEqual(self.service.get_quote.await_count, 4)

    async def test_failed_symbols_are_not_retried_or_evidence_ids_reassigned(self):
        async def fetch(symbol):
            if symbol == 'AAPL':
                raise QuoteError(502, 'SECRET')
            return self.fixture[symbol]

        def second(body):
            self.first_bundle = copy.deepcopy(tool_payload(body)['result'])
            return response([tool(['AAPL', 'NVDA'], call_id='second')])

        self.service.get_quote.side_effect = fetch
        self.script = [response([tool(['AAPL', 'MSFT'])]), second, final('clarification')]
        result = await self.run_agent()
        self.assertEqual(self.service.get_quote.await_args_list,
                         [call('AAPL'), call('MSFT'), call('NVDA')])
        self.assertEqual(result.quotes.evidence[0].model_dump(mode='json'), self.first_bundle['evidence'][0])
        self.assertEqual([(e.id, e.quote.symbol) for e in result.quotes.evidence],
                         [('q1', 'MSFT'), ('q2', 'NVDA')])
        self.assertIsNone(result.quotes.calculations.ranking)
        self.assertNotIn('SECRET', result.model_dump_json())

    async def test_negative_ranking_ties_are_backend_rendered(self):
        self.fixture = {symbol: quote(symbol, change_percent=-1 if symbol != 'AAPL' else -5)
                        for symbol in ('AAPL', 'MSFT', 'NVDA')}

        def ranking(body):
            findings = tool_payload(body)['candidate_findings']
            return final(findings=[next(item for item in findings if item['kind'] == 'ranking')])

        self.script = [response([tool(['AAPL', 'MSFT', 'NVDA'])]), ranking]
        result = await self.run_agent('Rank Apple, Microsoft and Nvidia by reported percentage change')
        self.assertEqual(result.explanation.status, 'answered')
        finding = result.explanation.findings[0]
        self.assertEqual(finding.evidence_ids, ['q2', 'q3', 'q1'])
        self.assertIn('(-1.0%) — tied', finding.statement)
        self.assertIn('Rank 2: AAPL (-5.0%)', finding.statement)

    async def test_remaining_deadline_decreases_across_model_turns(self):
        self.agent.deadline = 0.2

        async def delayed(body):
            await asyncio.sleep(0.03)
            return response([tool(['AAPL', 'MSFT'])])

        self.script = [delayed, choose_difference]
        result = await self.run_agent()
        self.assertEqual(result.explanation.status, 'answered')
        first, second = [request.extensions['timeout']['read'] for request in self.requests]
        self.assertLessEqual(first, 0.2)
        self.assertLess(second, first - 0.02)

    async def test_second_turn_outbound_content_matches_generate_content_contract(self):
        def inspect_followup(body):
            # Check the actual SDK wire representation, not a permissive mock's
            # success alone. Content roles are user/model per the REST contract.
            self.assertEqual([item['role'] for item in body['contents']], ['user', 'model', 'user'])
            result_part = body['contents'][-1]['parts'][0]
            self.assertEqual(set(result_part), {'functionResponse'})
            result = result_part['functionResponse']
            self.assertEqual(result['name'], 'get_quotes')
            self.assertEqual(result['id'], 'call-1')
            evidence = result['response']['result']
            self.assertEqual(evidence['data_mode'], 'fictional')
            self.assertEqual(evidence['calculations']['difference']['value'], '3.5')
            self.assertIsInstance(evidence['evidence'][0]['quote']['fetched_at'], str)
            self.assertEqual(body['tools'], self.bodies[0]['tools'])
            self.assertEqual(body['toolConfig']['functionCallingConfig']['mode'], 'AUTO')
            self.assertNotIn('responseMimeType', body['generationConfig'])
            self.assertNotIn('responseJsonSchema', body['generationConfig'])
            self.assertNotIn('responseSchema', body['generationConfig'])
            return choose_difference(body)

        self.script = [response([tool(['AAPL', 'MSFT'])]), inspect_followup]
        result = await self.run_agent()
        self.assertEqual(result.explanation.status, 'answered')
        self.assertEqual(len(self.requests), 2)

    async def test_second_turn_failure_diagnostics_are_safe(self):
        cases = [
            (httpx.Response(400, json={'error': {'code': 400, 'message': 'SECRET'}}),
             'request_rejected', 'ClientError', 400, 'model_unavailable'),
            (httpx.Response(503, json={'error': {'code': 503, 'message': 'SECRET'}}),
             'provider_error', 'ServerError', 503, 'model_unavailable'),
            (httpx.Response(429, json={'error': {'code': 429, 'message': 'SECRET'}}),
             'quota', 'ClientError', 429, 'model_quota'),
            (httpx.ConnectError('SECRET https://example.com?key=SECRET'),
             'transport', 'ConnectError', None, 'model_unavailable'),
            (httpx.ReadTimeout('SECRET'), 'timeout', 'ReadTimeout', None, 'research_timeout'),
            (httpx.Response(200, text='SECRET not JSON'),
             'response_json_decode', 'JSONDecodeError', None, 'model_unavailable'),
        ]
        for failure, category, exception, status, public_code in cases:
            with self.subTest(category=category):
                self.script = [response([tool(['AAPL', 'MSFT'])]), failure]
                before = len(self.requests)
                with self.assertLogs('app.gemini_client', level='WARNING') as logs:
                    result = await self.run_agent()
                self.assertEqual(len(self.requests) - before, 2)
                self.assertEqual(result.model_calls, 2)
                self.assertEqual(result.tool_requests, 1)
                self.assertEqual(result.tool_outcomes[0].code, 'ok')
                self.assertEqual(result.explanation.code, public_code)
                self.assertEqual(len(result.quotes.evidence), 2)
                self.assertEqual(len(logs.records), 1)
                record = logs.records[0]
                self.assertEqual(record.getMessage(),
                                 f'Gemini agent failure model_call=2 exception={exception} '
                                 f'category={category} status={status}')
                self.assertIsNone(record.exc_info)
                self.assertIsNone(record.stack_info)
                self.assertNotIn('SECRET', str(logs.output) + result.model_dump_json())
                self.assertNotIn(QUESTION, str(logs.output))
                self.assertNotIn('FAKE_AGENT_KEY', str(logs.output))

    async def test_second_turn_local_sdk_error_diagnostic(self):
        original = self.model.client.aio.models.generate_content
        calls = 0

        async def fail_second(**kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise ValueError('SECRET request conversion detail')
            return await original(**kwargs)

        self.script = [response([tool(['AAPL', 'MSFT'])])]
        with patch.object(self.model.client.aio.models, 'generate_content', side_effect=fail_second), \
                self.assertLogs('app.gemini_client', level='WARNING') as logs:
            result = await self.run_agent()
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(result.model_calls, 2)
        self.assertEqual(result.explanation.code, 'model_unavailable')
        self.assertEqual(logs.records[0].getMessage(),
                         'Gemini agent failure model_call=2 exception=ValueError '
                         'category=sdk_other status=None')
        self.assertNotIn('SECRET', str(logs.output) + result.model_dump_json())
