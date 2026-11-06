import asyncio
import json
import unittest
from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import AsyncMock, patch

import httpx
from test_real_history import KEY, NOW, payload, request
from test_real_research_plan import QUESTION, plan_payload, response_payload

from app.gemini_client import GeminiClient
from app.historical_data import DateRange
from app.market_data import ProviderBudget
from app.real_history import HistoricalService, HistoryError
from app.real_research import RealEvidence, RealResearch, render_findings
from app.real_research_plan import RealResearchPlan


class RealResearchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.events, self.model_requests, self.provider_requests = [], [], []
        self.plan = plan_payload()
        self.model_handler = lambda req: httpx.Response(200, json=response_payload(self.plan))
        self.provider_handler = lambda req: httpx.Response(200, json=payload(req.url.params['symbol']))

        async def model_transport(req):
            self.events.append('model')
            self.model_requests.append(json.loads(req.content))
            result = self.model_handler(req)
            return await result if asyncio.iscoroutine(result) else result

        async def provider_transport(req):
            self.events.append('provider')
            self.provider_requests.append(req.url.params['symbol'])
            result = self.provider_handler(req)
            return await result if asyncio.iscoroutine(result) else result
        self.http = httpx.AsyncClient(transport=httpx.MockTransport(provider_transport))
        self.service = HistoricalService(self.http, budget=ProviderBudget(), mode='alpha_vantage',
                                         api_key=KEY, utcnow=lambda: NOW)
        self.model = GeminiClient('synthetic-model-key', http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(model_transport)))
        self.workflow = RealResearch(self.model, self.service, enabled=True)

    async def asyncTearDown(self):
        await self.service.close()
        await self.http.aclose()
        await self.model.close()

    async def run_question(self, question=QUESTION):
        return await self.workflow.run({'question': question})

    async def test_disabled_unconfigured_and_invalid_instruction_never_call(self):
        for workflow in [RealResearch(self.model, self.service), RealResearch(None, self.service, enabled=True),
                         RealResearch(self.model, None, enabled=True)]:
            self.assertIn((await workflow.run({'question': QUESTION})).code, ['disabled', 'unconfigured'])
        for field, value in [('mode', 'demo'), ('api_key', ''), ('closed', True)]:
            with patch.object(self.service, field, value):
                self.assertEqual((await self.run_question()).code, 'unconfigured')
        for question in ['', '{"close":123}', 'date,close\n2026-10-23,100']:
            self.assertEqual((await self.run_question(question)).code, 'invalid_instruction')
        self.assertEqual((await self.run_question('Compare AAPL last month')).status, 'clarification')
        self.assertEqual(self.events, [])

    async def test_invalid_plans_and_nonexecution_outcomes_never_retrieve(self):
        for change in [{'symbols': ['TSLA']}, {'start_date': '2026-10-24'}, {'findings': ['buy']},
                       {'intents': [{'kind': 'compare', 'metric': 'raw_sma_20'}]}]:
            self.plan = plan_payload(**change)
            result = await self.run_question()
            self.assertEqual((result.code, result.model_calls, result.history_retrievals), ('invalid_model_output', 1, 0))
        for status, reason in [('unsupported', 'unsupported_request'), ('clarification', 'clarify_instruction')]:
            self.plan = plan_payload(status=status, reason=reason, symbols=[], intents=[], start_date=None, end_date=None)
            result = await self.run_question()
            self.assertEqual((result.status, result.code), (status, reason))
        self.assertEqual(self.provider_requests, [])

    async def test_execution_metadata_decimal_comparison_and_cache_reuse(self):
        result = await self.run_question()
        self.assertEqual((result.status, result.model_calls, result.history_retrievals), ('answered', 1, 2))
        self.assertEqual(self.events, ['model', 'provider', 'provider'])
        self.assertEqual(self.provider_requests, ['AAPL', 'MSFT'])
        self.assertEqual([e.id for e in result.evidence], ['rh1', 'rh2'])
        self.assertEqual(result.findings[0].relation, 'equal')
        item = result.evidence[0].metrics
        self.assertEqual((item.source, item.data_kind, item.adjustment_basis), ('alpha_vantage', 'end_of_day', 'unadjusted'))
        self.assertEqual(item.fetched_at, NOW)
        self.assertEqual(item.raw_price_change.window, DateRange(start=date(2026, 10, 23), end=date(2026, 10, 28)))
        self.assertEqual(item.raw_price_change.observation_count, 3)
        self.assertEqual(item.model_dump(mode='json')['raw_price_change']['value'], '1.000000')
        self.assertNotIn('bars', result.model_dump_json())
        self.assertIn('Corporate actions', result.findings[0].statement)
        self.assertIn('not total return', result.findings[0].statement)
        again = await self.run_question()
        self.assertTrue(all(e.metrics.cache_hit for e in again.evidence))
        self.assertEqual(again.evidence[0].metrics.fetched_at, item.fetched_at)
        self.assertEqual(len(self.provider_requests), 2)
        self.assertEqual(len(self.service.budget.attempts), 2)

    async def test_comparisons_use_displayed_decimals_and_compatible_windows(self):
        result = await self.run_question()
        plan = RealResearchPlan(**self.plan)
        left, right = result.evidence
        for value, relation in [('0.5', 'higher'), ('2', 'lower'), ('1.000000', 'equal')]:
            changed = right.metrics.raw_price_change.model_copy(update={'value': Decimal(value)})
            other = RealEvidence(id='rh2', metrics=right.metrics.model_copy(update={'raw_price_change': changed,
                                                                                  'fetched_at': NOW + timedelta(hours=1)}))
            findings, omitted = render_findings(plan, [left, other])
            self.assertEqual(findings[0].relation, relation)
            self.assertEqual(omitted, [])
        metric = right.metrics.raw_price_change
        for changes in [{'window': DateRange(start=date(2026, 10, 24), end=date(2026, 10, 28))},
                        {'observation_count': 2}, {'unit': 'USD'}]:
            other = right.model_copy(update={'metrics': right.metrics.model_copy(update={
                'raw_price_change': metric.model_copy(update=changes)})})
            findings, omitted = render_findings(plan, [left, other])
            self.assertEqual(findings, [])
            self.assertIn('incompatible', omitted[0])
        for field, value in [('currency', 'EUR'), ('source', 'demo'), ('data_kind', 'fictional'),
                             ('adjustment_basis', 'adjusted'), ('interval', 'weekly')]:
            other = right.model_copy(update={'metrics': right.metrics.model_copy(update={field: value})})
            self.assertFalse(render_findings(plan, [left, other])[0])

    async def test_near_equal_calculated_values_tie_after_rounding(self):
        def provider(req):
            fixture = payload(req.url.params['symbol'])
            if req.url.params['symbol'] == 'MSFT':
                fixture['Time Series (Daily)']['2026-10-28']['4. close'] = '101.0000001'
            return httpx.Response(200, json=fixture)
        self.provider_handler = provider
        result = await self.run_question()
        self.assertEqual(result.findings[0].relation, 'equal')
        self.assertEqual([e.metrics.model_dump(mode='json')['raw_price_change']['value']
                          for e in result.evidence], ['1.000000', '1.000000'])

    async def test_planner_failure_and_timeout_never_retrieve(self):
        self.model_handler = lambda req: httpx.Response(429, json={'error': {'code': 429, 'message': 'SECRET'}})
        result = await self.run_question()
        self.assertEqual((result.code, result.model_calls, result.history_retrievals), ('model_quota', 1, 0))
        entered, cleaned = asyncio.Event(), asyncio.Event()

        async def slow(req):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()
        self.model_handler = slow
        self.workflow.deadline = 0.02
        result = await self.run_question()
        self.assertEqual(result.code, 'research_timeout')
        self.assertTrue(cleaned.is_set())
        self.assertFalse(self.provider_requests)
        self.workflow.deadline = 30
        entered.clear(); cleaned.clear()
        task = asyncio.create_task(self.run_question())
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(cleaned.is_set())
        self.assertFalse(self.provider_requests)

    async def test_partial_all_failures_empty_and_insufficient_results(self):
        self.plan = plan_payload(intents=[{'kind': 'report', 'metric': 'raw_price_change'},
                                         {'kind': 'report', 'metric': 'raw_sma_20'}])
        self.provider_handler = lambda req: (httpx.Response(500, text='PRIVATE_PROVIDER_ERROR')
                                            if req.url.params['symbol'] == 'MSFT'
                                            else httpx.Response(200, json=payload()))
        result = await self.run_question()
        self.assertEqual(result.status, 'partial')
        self.assertEqual(len(result.evidence), 1)
        self.assertEqual(len(result.findings), 1)
        self.assertEqual(result.errors[0].status, 502)
        self.assertNotIn('PRIVATE_PROVIDER_ERROR', result.model_dump_json())
        self.assertTrue(result.omitted)
        self.service.cache.clear()
        self.provider_handler = lambda req: httpx.Response(500, text='PRIVATE_PROVIDER_ERROR')
        result = await self.run_question()
        self.assertEqual((result.status, len(result.errors)), ('unavailable', 2))
        self.provider_handler = lambda req: httpx.Response(200, json=payload(req.url.params['symbol']))
        self.plan = plan_payload(start_date='2026-10-24', end_date='2026-10-25')
        result = await self.run_question(QUESTION.replace('2026-10-23', '2026-10-24').replace('2026-10-28', '2026-10-25'))
        self.assertEqual(result.status, 'unavailable')
        self.assertTrue(all(e.metrics.status == 'empty' for e in result.evidence))
        self.assertFalse(result.findings)
        self.plan = plan_payload(intents=[{'kind': 'report', 'metric': 'raw_sma_50'}])
        result = await self.run_question()
        self.assertFalse(result.findings)
        self.assertIsNone(result.evidence[0].metrics.raw_sma_50.value)

    async def test_safe_expected_errors_and_unexpected_calculation_failure(self):
        for status in [422, 429, 502, 503, 504]:
            with patch.object(self.service, 'get_history', AsyncMock(side_effect=HistoryError(status, 'SECRET'))):
                result = await self.run_question()
            self.assertEqual([e.status for e in result.errors], [status, status])
            self.assertNotIn('SECRET', result.model_dump_json())
        with patch('app.real_research.calculate_real_history_metrics', side_effect=RuntimeError('SECRET')):
            result = await self.run_question()
        self.assertEqual(result.code, 'research_failed')
        self.assertNotIn('SECRET', result.model_dump_json())

    async def test_revalidates_mutated_nested_evidence_and_plan_binding(self):
        valid = await self.service.get_history(request())
        bad_bar = valid.bars[0].model_copy(update={'close': float('nan')})
        bad_values = [valid.model_copy(update={'source': 'demo'}),
                      valid.model_copy(update={'symbol': 'NVDA'}),
                      valid.model_copy(update={'requested_range': DateRange(start=date(2026, 10, 24), end=date(2026, 10, 28))}),
                      valid.model_copy(update={'bars': (bad_bar, *valid.bars[1:])})]
        for bad in bad_values:
            with patch.object(self.service, 'get_history', AsyncMock(return_value=bad)):
                result = await self.run_question()
            self.assertEqual(result.code, 'research_failed')
            self.assertFalse(result.evidence)

    async def test_actual_model_transport_isolation_success_and_provider_error(self):
        sentinels = ['103.271829', '3.271829', 'PROVIDER_ERROR_SENTINEL']

        def provider(req):
            fixture = payload(req.url.params['symbol'])
            fixture['Time Series (Daily)']['2026-10-28']['4. close'] = sentinels[0]
            return httpx.Response(200, json=fixture)
        self.provider_handler = provider
        with self.assertNoLogs(level='WARNING'):
            result = await self.run_question()
        self.assertIn(sentinels[1], result.model_dump_json())
        self.assertEqual(self.events, ['model', 'provider', 'provider'])
        self.service.cache.clear()
        self.events.clear()
        self.provider_handler = lambda req: httpx.Response(500, text=sentinels[2])
        with self.assertNoLogs(level='WARNING'):
            failed = await self.run_question()
        self.assertEqual(self.events, ['model', 'provider', 'provider'])
        self.assertEqual(len(self.model_requests), 2)  # one per invocation, never after retrieval
        for sentinel in [*sentinels, KEY]:
            self.assertNotIn(sentinel, json.dumps(self.model_requests))
            self.assertNotIn(sentinel, failed.model_dump_json())

    async def test_overall_timeout_and_cancellation_preserve_shared_fetch(self):
        entered, released, finished = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def slow(req):
            entered.set()
            try:
                await released.wait()
                return httpx.Response(200, json=payload())
            finally:
                finished.set()
        self.provider_handler = slow
        self.workflow.deadline = 0.03
        result = await self.run_question()
        self.assertEqual(result.code, 'research_timeout')
        self.assertEqual(result.history_retrievals, 1)
        self.assertFalse(finished.is_set())  # existing shared fetch survives waiter timeout
        self.workflow.deadline = 30
        task = asyncio.create_task(self.run_question())
        # Wait for the second planner request, not for another provider fetch.
        while len(self.model_requests) < 2:
            await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        released.set()
        await asyncio.wait_for(finished.wait(), 1)
        await asyncio.sleep(0)
        self.assertEqual(self.provider_requests, ['AAPL'])
        self.assertEqual(len(self.model_requests), 2)
        self.assertFalse(any('execute' in repr(t.get_coro()) for t in asyncio.all_tasks() if t is not asyncio.current_task()))
