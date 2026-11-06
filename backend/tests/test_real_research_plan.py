import asyncio
import json
import unittest

import httpx
from pydantic import ValidationError

from app.gemini_client import GeminiClient
from app.real_research_plan import (
    RealResearchInput,
    RealResearchPlan,
    instruction_dates,
    validate_plan,
)
from app.research_explanation import ModelFailure

QUESTION = 'Compare AAPL and MSFT raw price change from 2026-10-23 to 2026-10-28.'


def plan_payload(**changes):
    return {'status': 'planned', 'reason': 'ready', 'symbols': ['AAPL', 'MSFT'],
            'start_date': '2026-10-23', 'end_date': '2026-10-28',
            'intents': [{'kind': 'compare', 'metric': 'raw_price_change'}], **changes}


def response_payload(plan=None, **candidate):
    return {'candidates': [{'finishReason': 'STOP', 'content': {'role': 'model', 'parts': [
        {'text': json.dumps(plan if plan is not None else plan_payload())}]}, **candidate}]}


class PlanTests(unittest.TestCase):
    def test_request_boundary_and_dataset_rejection(self):
        self.assertEqual(RealResearchInput(question='  Compare stocks  ').question, 'Compare stocks')
        for request in [{}, {'question': ''}, {'question': ' '}, {'question': 1},
                        {'question': 'x' * 1001}, {'question': QUESTION, 'user_id': 'private'},
                        {'question': '{"close": 123}'}, {'question': 'date,close\n2026-10-23,123'},
                        {'question': '2026-10-23;123'}]:
            with self.subTest(request=request), self.assertRaises(ValidationError):
                RealResearchInput.model_validate(request)

    def test_strict_complete_plan(self):
        self.assertEqual(RealResearchPlan(**plan_payload()).symbols, ['AAPL', 'MSFT'])
        invalid = [{'symbols': []}, {'symbols': ['AAPL', 'AAPL']}, {'symbols': ['aapl']},
                   {'symbols': ['TSLA']}, {'symbols': ['AAPL', 'MSFT', 'NVDA']},
                   {'symbols': ['AAPL']}, {'intents': []}, {'findings': []}, {'value': 12},
                   {'code': 'print(1)'}, {'start_date': '2026-10-29'}, {'start_date': '2026-2-01'},
                   {'start_date': '2026-02-30'}, {'start_date': '2026-01-01'},
                   {'start_date': None}, {'reason': 'clarify_instruction'},
                   {'status': 'unsupported'}, {'status': 'clarification'},
                   {'intents': [{'kind': 'compare', 'metric': 'raw_sma_20'}]},
                   {'intents': [{'kind': 'report', 'metric': 'forecast'}]},
                   {'intents': [{'kind': 'report', 'metric': 'raw_sma_20', 'statement': 'buy'}]},
                   {'intents': plan_payload()['intents'] * 2}]
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                RealResearchPlan(**plan_payload(**changes))
        for status, reason in [('clarification', 'clarify_instruction'), ('unsupported', 'unsupported_request')]:
            RealResearchPlan(**plan_payload(status=status, reason=reason, symbols=[], intents=[],
                                           start_date=None, end_date=None))

    def test_dates_cannot_be_invented_and_same_day_is_supported(self):
        request = RealResearchInput(question=QUESTION)
        with self.assertRaises(ValueError):
            validate_plan(RealResearchPlan(**plan_payload(start_date='2026-10-24')), request)
        for question in ['Compare last month', 'October 1 to October 30', QUESTION + ' last month',
                         QUESTION + ' or 2026-10-29']:
            self.assertIsNone(instruction_dates(question))
        same = QUESTION.replace('2026-10-28', '2026-10-23')
        validate_plan(RealResearchPlan(**plan_payload(end_date='2026-10-23')), RealResearchInput(question=same))


class PlannerSDKTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.handler = lambda req: httpx.Response(200, json=response_payload())

        async def transport(req):
            self.requests.append(json.loads(req.content))
            result = self.handler(req)
            return await result if asyncio.iscoroutine(result) else result
        self.http = httpx.AsyncClient(transport=httpx.MockTransport(transport))
        self.model = GeminiClient('synthetic-model-key', http_client=self.http)
        self.request = RealResearchInput(question=QUESTION)

    async def asyncTearDown(self):
        await self.model.close()

    async def test_actual_sdk_request_has_only_instruction_and_static_schema(self):
        plan = await self.model.plan_real_research(self.request)
        self.assertEqual(plan.symbols, ['AAPL', 'MSFT'])
        self.assertEqual(len(self.requests), 1)
        body = self.requests[0]
        self.assertEqual(json.loads(body['contents'][0]['parts'][0]['text']), {'question': QUESTION})
        config = body['generationConfig']
        self.assertEqual(config['maxOutputTokens'], 1024)
        self.assertEqual(config['responseMimeType'], 'application/json')
        self.assertIn('responseJsonSchema', config)
        self.assertFalse(body.get('tools'))
        self.assertNotIn('synthetic-model-key', json.dumps(body))

    async def test_safe_rejections_without_repair_or_retry(self):
        scenarios = [
            (httpx.Response(429, json={'error': {'code': 429, 'message': 'SECRET'}}), 'model_quota'),
            (httpx.Response(500, json={'error': {'code': 500, 'message': 'SECRET'}}), 'model_unavailable'),
            (httpx.Response(200, json={'promptFeedback': {'blockReason': 'SAFETY'}}), 'model_refusal'),
            (httpx.Response(200, json=response_payload(finishReason='MAX_TOKENS')), 'model_truncated'),
            (httpx.Response(200, json=response_payload(plan_payload(findings=['SECRET']))), 'invalid_model_output'),
            (httpx.Response(200, json=response_payload(content={'role': 'model', 'parts': [{'text': 'not json'}]})), 'invalid_model_output'),
            (httpx.Response(200, json=response_payload(content={'role': 'model', 'parts': [{'functionCall': {'name': 'bad', 'args': {}}}]})), 'invalid_model_output'),
        ]
        for response, code in scenarios:
            with self.subTest(code=code):
                self.requests.clear()
                self.handler = lambda req, response=response: response
                with self.assertRaises(ModelFailure) as caught:
                    await self.model.plan_real_research(self.request)
                self.assertEqual(caught.exception.code, code)
                self.assertNotIn('SECRET', str(caught.exception))
                self.assertEqual(len(self.requests), 1)

    async def test_planner_timeout_and_cancellation_clean_up(self):
        entered, cleaned = asyncio.Event(), asyncio.Event()

        async def slow(req):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()
        self.handler = slow
        with self.assertRaises(ModelFailure) as caught:
            await self.model.plan_real_research(self.request, timeout=0.01)
        self.assertEqual(caught.exception.code, 'research_timeout')
        self.assertTrue(cleaned.is_set())
        entered.clear(); cleaned.clear()
        task = asyncio.create_task(self.model.plan_real_research(self.request))
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(cleaned.is_set())
