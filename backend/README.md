# MarketSim API

FastAPI backend with health, stock quotes, and optional research explanations.
`GET /health`
It returns HTTP 200 with `{"status":"ok","service":"marketsim-api"}`.
This only confirms that the API process responds; it does not check database
or market-data availability. No external service configuration is required.

## Set up on macOS

Use Python 3.10 or newer; this milestone was validated with Python 3.13.2.
From Terminal:

```sh
cd /Users/irvin/Documents/MarketSim/backend
python3 -m venv .venv
source .venv/bin/activate
.venv/bin/python -m pip install -r requirements-dev.txt
```

Install only into this project virtual environment, not system Python.
Runtime dependencies are pinned to FastAPI 0.143.0 and Uvicorn 0.54.0;
the development requirements include them and Ruff 0.17.0.
Direct versions and Python compatibility were checked against official PyPI
metadata: [FastAPI](https://pypi.org/pypi/fastapi/0.143.0/json),
[Uvicorn](https://pypi.org/pypi/uvicorn/0.54.0/json), and
[Ruff](https://pypi.org/pypi/ruff/0.17.0/json).
Transitive dependencies are resolved by pip and are not locked.

## Start the development server

From `backend/`, with the environment activated:

```sh
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Activation makes `python` resolve to `.venv/bin/python`. Without activation,
use `.venv/bin/python` in place of `python` in that command.
`app.main:app` means import the `app.main` module (`app/main.py`) and serve
its `app` FastAPI object. `--reload` restarts the server when Python source
changes during development; omit it for a smoke test.

## Verify from another terminal

```sh
curl --fail-with-body -i http://127.0.0.1:8000/health
curl --fail-with-body -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/docs
curl --fail-with-body http://127.0.0.1:8000/openapi.json
open http://127.0.0.1:8000/docs
```

Expect HTTP 200 and the health JSON above, HTTP 200 for `/docs`, and a
`get` operation under `/health` in the OpenAPI schema. The interactive docs
use FastAPI's default Swagger UI assets, which require browser internet access.
If port 8000 is occupied, leave that process running and choose another port
with `--port` (for example, 8001); update the verification URLs to match.

## Local checks

From `backend/`:

```sh
.venv/bin/python -m ruff check app tests
MARKET_DATA_PROVIDER=demo .venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m pip check
```

The unittest suite uses fictional fixtures and mocked external transports.
It requires no API keys and performs no live model or market-provider requests.
Virtual environments, bytecode, Ruff caches, and `.env`/`.env.*` files are ignored.
The tracked `.env.example` contains configuration placeholders only.

## Stop

Press `Control-C` in the server terminal to stop your server. Then run:

```sh
deactivate
```

## Dashboard connection and CORS

Run this API and the frontend in separate terminals. Keep the backend command
above running; in the frontend terminal use:

```sh
cd /Users/irvin/Documents/MarketSim/frontend
if [ ! -e .env.local ]; then cp -n .env.example .env.local; fi
npm run dev -- --port 5173 --strictPort
```

Restart Vite after changing `.env.local`. Never place secrets in frontend
`VITE_` variables. Do not stop another project's server if a port is occupied.
See [frontend instructions](../frontend/README.md) for connection, unavailable,
retry, keyboard, and mobile checks.

CORS allows only `http://localhost:5173` and `http://127.0.0.1:5173`, with GET
and credentials disabled. No custom request headers are needed. An unlisted
origin receives no `Access-Control-Allow-Origin` header; CORS is browser
access control, not authentication. The health response is unchanged.

```sh
curl --fail-with-body -i -H 'Origin: http://localhost:5173' http://127.0.0.1:8000/health
curl --fail-with-body -i -H 'Origin: http://localhost:5174' http://127.0.0.1:8000/health
```

The first response should include `Access-Control-Allow-Origin: http://localhost:5173`;
the second should omit that header. Both may return HTTP 200: curl does not
apply the browser's CORS policy.

## Milestone B: local research explanations

This is an LLM-assisted explanation endpoint, not a tool-calling agent.
`POST /api/research` accepts a JSON object with exactly `question` and `symbols`:

```json
{"question":"Compare their reported percentage changes.","symbols":["AAPL","MSFT"]}
```

Questions are trimmed, then must contain 1–1,000 characters. Symbols use the
existing validation: one to three unique supported symbols (AAPL, MSFT, NVDA),
case-normalized, with no silent removal of invalid entries. Extra fields are rejected.

The first version deliberately accepts three question templates:

- `Compare their reported percentage changes.` (two symbols: ordered difference;
  three symbols: ranking)
- `Show their reported daily ranges.` (one to three symbols)
- `Rank their reported percentage changes.` (two or three symbols)

Case, whitespace, trailing question/exclamation/period punctuation, and replacing
`their reported` with `the reported` or `reported` are accepted. Other wording
gets an explicit clarification response without a model call. A single-symbol
comparison/ranking returns unsupported with its quote evidence. This bounded
vocabulary prevents unrelated advisory/historical questions from being answered
by an apparently valid but irrelevant quote comparison.

The endpoint calls internal `get_quotes()` directly, preserving its source quotes,
metadata, errors, labels, Decimal calculations, operand order, and tied ranks.
It never calls our own HTTP API. Partial failures, all-quote failures, and mismatched
trading dates retain the completed evidence bundle and skip Gemini.

For complete evidence, Gemini selects structured findings from backend-generated
candidates. The backend validates finding types, exact calculation references,
ordered evidence IDs, comparison direction, ranking order, ties, and completeness.
It then renders numerical statements itself. No free-form model prose is returned.
The response separates `quotes` (unchanged evidence/calculations) from `explanation`.
JSON validity alone does not prove factual accuracy; relationship validation and
backend rendering are required. User questions and evidence are untrusted data,
never tool instructions. No tools, search grounding, or hidden reasoning are exposed.

### Configuration and local startup

Research is **disabled by default**. Health and stock quotes do not require Gemini.
The example variable names/defaults are:

```dotenv
MARKET_DATA_PROVIDER=demo
ALPHA_VANTAGE_API_KEY=
RESEARCH_ENABLED=false
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite
```

No `.env` file is loaded implicitly. From `backend/`, the following command
explicitly keeps research disabled and market data fictional, even if conflicting
values are inherited from your shell:

```sh
RESEARCH_ENABLED=false MARKET_DATA_PROVIDER=demo .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

For a future explicitly authorized live-model smoke test, prepare an ignored
`backend/.env` locally using the example names. Keep credentials out of Git,
frontend `VITE_*` variables, logs, and chat. Set `RESEARCH_ENABLED=true` only when
ready to send data to Google. Explicitly load that file with the existing Uvicorn
startup tooling (python-dotenv is already a dependency):

```sh
.venv/bin/python -m uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8000
```

Existing process environment variables take precedence over `.env` values.
Use one worker and loopback binding. There is no real authentication; CORS remains
GET-only and is not an authorization boundary. No frontend integration is included.
Do not expose this endpoint publicly. This milestone was tested only with mocks.

### Limits and HTTP behavior

One active research request per process is allowed; excess requests are rejected
immediately. The 30-second application deadline covers retrieval and generation,
using Python-3.10-compatible `asyncio.wait_for`. The SDK transport timeout is
20,000 milliseconds (20 seconds), with 1,024 maximum output tokens, one candidate,
one attempt, automatic function calling disabled, and automatic continuation
disabled. Client creation and cleanup are managed by the application lifespan.
There is no paid fallback or retry loop. The limit is process-local, not a daily
spending cap; multiple workers would each have their own limit.

| HTTP | Body behavior |
| --- | --- |
| 422 | FastAPI request-validation error; no retrieval/model call |
| 503 | Research envelope with `research_unavailable`; disabled, missing, or invalid configuration |
| 429 | Research envelope with `research_busy`; no queued work |
| 200 | Completed research attempt; inspect `explanation.status` and `explanation.code` |

Every research envelope has `question`, nullable `quotes`, and `explanation`.
`explanation` has `status`, `code`, a fixed safe `message`, and `findings`.
Statuses are `answered`, `unsupported`, `clarification`, or `unavailable`.
Successful findings include their references, relation, backend-rendered `statement`,
and `statement_origin: "backend"`. No provider error text is returned.

Unavailable codes include `incomplete_evidence`, `different_dates`, `model_quota`,
`research_timeout`, `model_refusal`, `model_truncated`, `invalid_model_output`,
`model_unavailable`, and `research_failed`. Unsupported/clarification codes are
`unsupported_question` and `clarify_question`. The success code is `answered`.
All explanation failures retain the quote bundle. If the total deadline interrupts
retrieval, completed outcomes are replayed through `get_quotes()` without more
service calls; missing outcomes become safe timeout errors. `quotes` is null when
retrieval never started (configuration, busy, or clarification responses).
The existing shared quote tasks/cache retain their original
cancellation policy. No fictional fallback is substituted after provider failure.

### SDK and verification

Pinned `google-genai==2.31.0` declares Python >=3.10. Its SDK uses async
`client.aio.models.generate_content`, JSON-schema output, `HttpRetryOptions(attempts=1)`,
and `HttpOptions(timeout=20000)`. References reviewed:

- [Official package metadata](https://pypi.org/pypi/google-genai/2.31.0/json)
- [Official SDK documentation](https://googleapis.github.io/python-genai/)
- [Pinned SDK option definitions](https://github.com/googleapis/python-genai/blob/v2.31.0/google/genai/types.py)

Existing dependency pins are unchanged; transitive SDK dependencies are not locked.
The tests exercise real SDK serialization/parsing through `httpx.MockTransport`,
including errors and continuation suppression, in addition to orchestration and
HTTP routing. They use fake credentials and block ordinary external HTTP transport.
Python 3.10 syntax/APIs are preserved, but a Python 3.10 runtime test has not been run.

Fictional data stays explicitly labeled; it cannot establish real market performance.
Daily range is not historical volatility, price is not valuation, and one reported
change is not momentum. Live model availability, free-tier quota, prompt quality,
and live market-provider behavior remain unverified. Before any real Google use,
review [free-tier pricing](https://ai.google.dev/gemini-api/docs/pricing) and
[data handling/eligibility terms](https://ai.google.dev/gemini-api/terms).
Keep a free-tier project unbilled; do not submit personal or confidential data.

## Internal research agent (Milestone C foundation)

`app.research_agent.ResearchAgent` is an internal callable component. It is not
registered with FastAPI or exposed through the frontend. The existing
`POST /api/research` retains its Milestone B behavior and question templates.
No dependencies, configuration variables, or market-provider behavior change.

The internal API takes an already constructed Gemini adapter and quote service:

```python
# Illustrative integration only; the test suite supplies mocked transports.
agent = ResearchAgent(model)
result = await agent.run(market_data, {
    "question": "Compare Apple and Microsoft’s reported percentage changes."
})
```

The caller owns client creation/cleanup and any future opt-in. The component does
not load `.env`, read keys, create clients, or register endpoints. Passing `None`
as the model returns `research_unavailable`. The question is trimmed and must be
1–1,000 characters; extra request fields are rejected with Pydantic validation.

Unlike Milestone B, this component first asks the model to interpret the natural
language request. It does not fetch quotes until the model requests the sole tool,
`get_quotes(symbols)`. Application code checks the exact function name and validates
the complete argument object through `QuotesInput` before any service call. Unknown
tools and invalid symbols, duplicates, extra fields, or invalid list sizes produce
fixed safe tool errors, which the model may correct within the remaining budget.

Tool results contain cumulative request evidence in first-requested symbol order,
existing backend calculations, and candidate findings. Repeated symbols reuse the
identical quote object, including its original `cache_hit` and timestamps. Expected
failures are also memoized, so they are not retried during the request. Evidence IDs
remain stable across tool calls, with no replacements or duplicates in the result.
This memoization is separate from the existing provider cache and request budget.

The model may request another tool invocation or finish with the existing
`ModelReply` schema. Final findings must exactly match a subset of the latest
tool-returned candidates, including ordered operands, comparison direction, and
ranking/ties. Existing backend validation/rendering produces the numerical text.
An answer without evidence, invented references, duplicate findings, arbitrary
prose, or model-owned prices is rejected. Partial data and differing trading dates
retain evidence and limitations but cannot produce an answered comparison.

Supported research remains reported quotes, daily high-minus-low ranges, ordered
percentage-point differences, and rankings of reported percentage changes.
Common historical, momentum, volatility, forecast, valuation, and trading requests
are rejected by a conservative scope guard. Other unsupported/ambiguous requests
use model-selected unsupported/clarification statuses. This is not a general
semantic proof that every possible question has been understood; the factual
guarantee is limited to validated quote relationships and backend-rendered text.
Fictional values remain labeled, and fetch time is not evidence of freshness.

### Manual loop limits and results

- At most three model calls and two tool invocations per request. Invalid and
  unknown tool requests count. An oversized batch is rejected before executing
  any of its calls; accepted calls are executed sequentially.
- The third model call, or a call after both tool slots are used, requests final
  structured JSON with no tools. Unexpected further tool requests are rejected.
- A 30-second overall `asyncio.wait_for` deadline, with remaining time applied to
  each model/tool/quote wait. SDK HTTP timeouts use milliseconds and are at most
  20 seconds or the remaining time, whichever is smaller. No automatic retries,
  automatic tool execution, or automatic continuation is enabled.
- Conversation, budgets, cached outcomes, and evidence are request-local. Original
  model content parts/signatures are retained internally; function results echo
  their matching call IDs. No conversation, hidden reasoning, signatures, raw
  provider errors, or credentials are included in the public result or logged by
  the component. Tool text is data, not instructions.

The result contains `question`, nullable `quotes`, `explanation`, `model_calls`,
`tool_requests`, and safe `tool_outcomes` (tool name, validated symbols, outcome
code). `tool_requests` counts all requests observed, including a rejected batch,
so it can exceed two even though no more than two invocations execute. There is
no HTTP status mapping for this internal component.

Existing safe explanation codes are reused, with `tool_budget_exhausted` and
`model_budget_exhausted` added. Deadline failures retain completed quote outcomes;
missing outcomes become safe timeout errors without new provider calls. Shared
quote fetches retain the existing cancellation policy and can finish in the
service cache after a caller times out. There is no new process-wide admission
control or daily spending cap; those are future endpoint integration decisions.

Official references checked for the installed `google-genai==2.31.0`:

- [Versioned manual function-calling examples](https://github.com/googleapis/python-genai/blob/v2.31.0/README.md#manually-declare-and-invoke-a-function-for-function-calling)
- [Versioned function-call IDs, signatures, timeout and retry types](https://github.com/googleapis/python-genai/blob/v2.31.0/google/genai/types.py)
- [Google function-calling guide](https://ai.google.dev/gemini-api/docs/function-calling)
- [Thinking/signature guide](https://ai.google.dev/gemini-api/docs/thinking)

The current web guides emphasize the Interactions API; this implementation follows
the installed SDK's `generate_content` interface. Tool-enabled turns request final
JSON in the instructions and validate it locally; the final-only turn also supplies
the response schema. Live server acceptance and model behavior remain unverified.

Tests exercise the actual SDK through mocked HTTP transport, including full
function-call/function-result serialization, preserved parts/signatures, IDs,
budgets, deadlines, safe failures, and grounded output. No real key is needed:

```sh
MARKET_DATA_PROVIDER=demo RESEARCH_ENABLED=false .venv/bin/python -m unittest discover -s tests -v
```
