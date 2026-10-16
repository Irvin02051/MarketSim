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
from app.historical_data import get_history
from app.historical_research import get_historical_metrics
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


def historical_tool(symbols=None, *, start='2025-01-01', end='2025-03-31', call_id='history-1'):
    return tool(name='get_historical_metrics', call_id=call_id, args={
        'symbols': symbols or ['AAPL', 'MSFT'], 'start_date': start, 'end_date': end,
    })


def historical_final(ids=None, *, metric='price_change', relation='higher', **extra):
    return response([{'text': json.dumps({
        'status': 'answered', 'findings': [], 'historical_findings': [{
            'metric': metric, 'evidence_ids': ['hm1', 'hm2'] if ids is None else ids,
            'relation': relation, **extra,
        }],
    })}])


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
            self.assertEqual([item['name'] for item in declarations], ['get_quotes', 'get_historical_metrics'])
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
                         'Predict Nvidia tomorrow']:
            result = await self.run_agent(question)
            self.assertEqual(result.explanation.status, 'unsupported')
            self.assertEqual(result.model_calls, 0)
        self.script = [final('unsupported')]
        result = await self.run_agent('Compare Tesla and Apple')
        self.assertEqual(result.explanation.status, 'unsupported')
        self.service.get_quote.assert_not_called()

    async def test_historical_sdk_exchange_preserves_evidence_and_wire_contract(self):
        question = 'How did Apple and Microsoft compare on price change from 2025-01-01 to 2025-03-31?'
        signature = base64.b64encode(b'historical-signature').decode()
        parts = [historical_tool(['aapl', 'MSFT']) | {'thoughtSignature': signature}]

        def inspect(body):
            self.assertEqual([item['role'] for item in body['contents']], ['user', 'model', 'user'])
            self.assertEqual(body['contents'][1]['parts'], parts)
            reply = body['contents'][-1]['parts'][0]['functionResponse']
            self.assertEqual((reply['name'], reply['id']), ('get_historical_metrics', 'history-1'))
            bundle = reply['response']['result']
            self.assertEqual(bundle['request'], {'symbols': ['AAPL', 'MSFT'],
                                               'start_date': '2025-01-01', 'end_date': '2025-03-31'})
            self.assertEqual(bundle['data_mode'], 'fictional')
            self.assertEqual([item['id'] for item in bundle['evidence']], ['hm1', 'hm2'])
            self.assertIsInstance(bundle['evidence'][0]['price_change']['value'], str)
            self.assertNotIn('"bars"', json.dumps(bundle))
            self.assertEqual(body['tools'], self.bodies[0]['tools'])
            declaration = body['tools'][0]['functionDeclarations'][1]
            schema = declaration['parameters_json_schema']
            self.assertEqual(set(schema['required']), {'symbols', 'start_date', 'end_date'})
            self.assertFalse(schema['additionalProperties'])
            self.assertEqual(schema['properties']['start_date']['format'], 'date')
            self.assertNotIn('responseJsonSchema', body['generationConfig'])
            return historical_final()

        self.script = [response(parts), inspect]
        result = await self.run_agent(question)
        self.assertEqual(result.status, 'answered')
        self.assertEqual((result.model_calls, result.tool_requests), (2, 1))
        self.assertIsNone(result.quotes)
        self.assertEqual(result.explanation.code, 'historical_answer_available')
        self.assertEqual(result.explanation.status, 'clarification')
        self.assertEqual(result.explanation.findings, [])
        self.assertEqual(result.tool_outcomes, [])  # Legacy frontend accepts its existing vocabulary.
        self.assertEqual(result.historical_tool_outcomes[0].code, 'ok')
        statement = result.historical_findings[0].statement
        self.assertIn('FICTIONAL', statement)
        self.assertIn('2025-01-01 through 2025-03-31', statement)
        self.assertIn('higher than', statement)
        self.assertEqual(result.historical_findings[0].statement_origin, 'backend')
        self.assertNotIn(signature, result.model_dump_json())
        self.service.get_quote.assert_not_called()

    async def test_historical_model_selects_symbol_dates_and_single_metric(self):
        self.script = [response([historical_tool(['NVDA'], start='2024-01-01', end='2024-02-29')]),
                       historical_final(['hm1'], metric='sma_20', relation='reported')]
        result = await self.run_agent('Tell me Nvidia’s latest 20-observation mean in January–February 2024.')
        self.assertEqual(result.status, 'answered')
        evidence = result.historical_evidence[0]
        self.assertEqual(evidence.provenance.symbol, 'NVDA')
        self.assertEqual(evidence.provenance.requested_range.end, date(2024, 2, 29))
        self.assertEqual(evidence.sma_20.observation_count, 20)
        self.assertIn('NVDA', result.historical_findings[0].statement)

    async def test_relative_periods_require_explicit_dates_without_calls(self):
        for period in ['last month', 'this year', 'past 30 days', 'yesterday']:
            result = await self.run_agent(f'Compare Apple and Microsoft volatility {period}.')
            self.assertEqual(result.status, 'clarification')
            self.assertIn('YYYY-MM-DD', result.explanation.message)
            self.assertEqual((result.model_calls, result.tool_requests), (0, 0))
        self.assertEqual(self.requests, [])
        # Other ambiguity is still model-selected, without an exact template parser.
        self.script = [final('clarification')]
        self.assertEqual((await self.run_agent('What is Apple volatility?')).status, 'clarification')

    async def test_invalid_historical_arguments_rejected_before_retrieval(self):
        base = {'symbols': ['AAPL'], 'start_date': '2025-01-01', 'end_date': '2025-03-31'}
        invalid = [base | change for change in [
            {'symbols': []}, {'symbols': ['AAPL', 'aapl']}, {'symbols': ['AAPL', 'TSLA']},
            {'symbols': ['AAPL', 'MSFT', 'NVDA', 'AAPL']}, {'extra': 'SECRET'},
            {'start_date': 'last month'}, {'start_date': '2025-1-01'},
            {'start_date': '2025-01-01T00:00:00Z'}, {'start_date': True},
            {'start_date': '2025-02-30'}, {'end_date': '2024-01-01'}, {'end_date': '2027-01-01'},
        ]]
        invalid.append({'symbols': ['AAPL']})
        with patch('app.research_agent.get_historical_metrics') as retrieve:
            for args in invalid:
                with self.subTest(args=args):
                    self.script = [response([tool(name='get_historical_metrics', args=args)]), final('clarification')]
                    result = await self.run_agent()
                    self.assertEqual(result.historical_tool_outcomes[0].code, 'invalid_tool_arguments')
                    self.assertEqual(result.historical_evidence, [])
                    self.assertNotIn('SECRET', result.model_dump_json())
            retrieve.assert_not_called()

    async def test_historical_ids_survive_different_ranges_and_symbols(self):
        self.script = [response([historical_tool()]), response([
            historical_tool(['AAPL', 'NVDA'], start='2024-01-01', end='2024-03-31', call_id='history-2'),
        ]), historical_final(['hm1', 'hm2'])]
        result = await self.run_agent()
        self.assertEqual(result.status, 'answered')
        self.assertEqual([(e.id, e.provenance.symbol) for e in result.historical_evidence],
                         [('hm1', 'AAPL'), ('hm2', 'MSFT'), ('hm3', 'AAPL'), ('hm4', 'NVDA')])
        self.assertEqual(result.historical_evidence[0].provenance.requested_range.start, date(2025, 1, 1))
        self.assertEqual(result.historical_evidence[2].provenance.requested_range.start, date(2024, 1, 1))
        self.assertFalse(self.bodies[-1].get('tools'))
        self.assertIn('historical_findings', self.bodies[-1]['generationConfig']['responseJsonSchema']['properties'])

    async def test_reordered_normalized_history_reuses_evidence_and_fetches_once(self):
        self.script = [response([historical_tool()]), response([
            historical_tool(['msft', 'aapl'], call_id='history-2'),
        ]), historical_final(['hm2', 'hm1'], relation='lower')]
        with patch('app.historical_research.get_history', wraps=get_history) as retrieve:
            result = await self.run_agent()
        self.assertEqual(retrieve.call_count, 2)
        self.assertEqual(result.status, 'answered')
        first = tool_payload(self.bodies[1])['result']['evidence']
        second = tool_payload(self.bodies[2])['result']['evidence']
        self.assertEqual(first, list(reversed(second)))
        self.assertEqual(len(result.historical_evidence), 2)

    async def test_overlapping_history_requests_only_collect_new_symbols(self):
        self.script = [response([historical_tool(['AAPL'])]), response([
            historical_tool(['aapl', 'NVDA'], call_id='history-2'),
        ]), historical_final(['hm1'], relation='reported')]
        with patch('app.historical_research.get_history', wraps=get_history) as retrieve:
            result = await self.run_agent()
        self.assertEqual(retrieve.call_count, 2)
        self.assertEqual([(e.id, e.provenance.symbol) for e in result.historical_evidence],
                         [('hm1', 'AAPL'), ('hm2', 'NVDA')])

    async def test_quote_and_history_tools_share_budget_and_keep_separate_evidence(self):
        def mixed_final(body):
            quote_payload = body['contents'][-1]['parts'][0]['functionResponse']['response']
            selection = next(f for f in quote_payload['candidate_findings'] if f['kind'] == 'difference')
            return response([{'text': json.dumps({
                'status': 'answered', 'findings': [selection], 'historical_findings': [{
                    'metric': 'price_change', 'evidence_ids': ['hm1', 'hm2'], 'relation': 'higher',
                }],
            })}])

        self.script = [response([tool(['AAPL', 'MSFT']), historical_tool()]), mixed_final]
        result = await self.run_agent()
        self.assertEqual(result.status, 'answered')
        self.assertEqual(result.explanation.status, 'answered')
        self.assertEqual((result.model_calls, result.tool_requests), (2, 2))
        self.assertEqual([e.id for e in result.quotes.evidence], ['q1', 'q2'])
        self.assertEqual([e.id for e in result.historical_evidence], ['hm1', 'hm2'])
        self.assertFalse(self.bodies[-1].get('tools'))
        self.script = [response([tool(['AAPL']), historical_tool(), historical_tool(call_id='extra')])]
        with patch('app.research_agent.get_historical_metrics') as retrieve:
            result = await self.run_agent()
            retrieve.assert_not_called()
        self.assertEqual(result.explanation.code, 'tool_budget_exhausted')
        self.script = [response([historical_tool()]), response([
            tool(['AAPL']), historical_tool(call_id='extra'),
        ])]
        result = await self.run_agent()
        self.assertEqual(result.explanation.code, 'tool_budget_exhausted')
        self.assertEqual(len(result.historical_evidence), 2)

    async def test_invalid_historical_findings_never_publish_statements(self):
        for invalid in [
            historical_final(['hm1', 'q1']), historical_final(metric='momentum'),
            historical_final(relation='lower'), historical_final(value='100.0'),
            historical_final(statement='Buy Apple'), historical_final(['hm1'], relation='higher'),
        ]:
            self.script = [response([historical_tool()]), invalid]
            result = await self.run_agent()
            self.assertEqual(result.explanation.code, 'invalid_model_output')
            self.assertEqual(result.historical_findings, [])
            self.assertEqual(len(result.historical_evidence), 2)

    async def test_historical_empty_and_partial_coverage_never_shift_dates(self):
        for start, end in [('2026-01-01', '2026-03-31'), ('2025-01-04', '2025-01-05'),
                           ('2025-01-01', '2025-01-01')]:
            self.script = [response([historical_tool(start=start, end=end)]), historical_final()]
            result = await self.run_agent()
            self.assertEqual(result.explanation.code, 'invalid_model_output')
            self.assertIsNone(result.historical_evidence[0].price_change.value)
            self.assertEqual(str(result.historical_evidence[0].provenance.requested_range.start), start)
        self.script = [response([historical_tool(start='2023-12-29', end='2024-02-01')]), historical_final()]
        result = await self.run_agent()
        self.assertEqual(result.status, 'answered')
        self.assertIn('coverage is incomplete', result.historical_findings[0].statement)
        self.assertEqual(result.historical_evidence[0].provenance.coverage, 'partial_overlap')

    async def test_historical_failures_are_safe_and_deadline_preserves_completed_evidence(self):
        self.script = [response([historical_tool()])]
        with patch('app.research_agent.get_historical_metrics', side_effect=RuntimeError('SECRET')):
            result = await self.run_agent()
        self.assertEqual(result.explanation.code, 'research_failed')
        self.assertNotIn('SECRET', result.model_dump_json())

        async def slow(*args, **kwargs):
            await asyncio.Event().wait()

        self.agent.deadline = 0.1
        self.script = [response([historical_tool()]), slow]
        result = await self.run_agent()
        self.assertEqual(result.explanation.code, 'research_timeout')
        self.assertEqual(len(result.historical_evidence), 2)
        self.assertEqual(result.historical_findings, [])
        self.script = [response([historical_tool()])]
        with patch('app.research_agent.asyncio.to_thread', side_effect=slow):
            result = await self.run_agent()
        self.assertEqual(result.explanation.code, 'research_timeout')
        self.assertEqual(result.model_calls, 1)
        self.assertEqual(result.historical_evidence, [])

    async def test_historical_evidence_is_request_local(self):
        for _ in range(2):
            self.script = [response([historical_tool(['AAPL'])]), historical_final(['hm1'], relation='reported')]
            with patch('app.research_agent.get_historical_metrics', wraps=get_historical_metrics) as collect:
                result = await self.run_agent()
            collect.assert_called_once()
            self.assertEqual([e.id for e in result.historical_evidence], ['hm1'])

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
