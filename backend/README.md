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

CORS allows only `http://localhost:5173` and `http://127.0.0.1:5173`, with GET and POST
allowed and credentials disabled. Allowed headers are Content-Type and Authorization. An unlisted
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

For the first real quote check, use the private, research-disabled procedure below
instead of submitting research. Provider data must not be sent to Gemini during that check.

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
Use one worker and loopback binding. Research endpoints remain public; /api/me and watchlist routes verify user identity. CORS allows local frontend GET/POST requests and is not an authorization boundary.
The frontend research page uses the agent endpoint described below.
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

`app.research_agent.ResearchAgent` remains a callable component and is now
exposed through `POST /api/research/agent`, with a frontend interface at `/research`. The existing
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
language request. It retrieves evidence only after the model requests `get_quotes(symbols)`
or `get_historical_metrics(symbols, start_date, end_date)`. Application code checks
the exact function name and validates the complete argument object through
`QuotesInput` or `HistoricalResearchInput` before any service call. Unknown
tools and invalid symbols, duplicates, extra fields, or invalid list sizes produce
fixed safe tool errors, which the model may correct within the remaining budget.

Quote tool results contain cumulative request evidence in first-requested symbol order,
existing backend calculations, and candidate findings. Repeated symbols reuse the
identical quote object, including its original `cache_hit` and timestamps. Expected
failures are also memoized, so they are not retried during the request. Evidence IDs
remain stable across tool calls, with no replacements or duplicates in the result.
This memoization is separate from the existing provider cache and request budget.

The model may request another tool invocation or finish with `AgentReply`, which
extends `ModelReply` with a separate `historical_findings` array. Quote findings
must exactly match a subset of the latest
tool-returned candidates, including ordered operands, comparison direction, and
ranking/ties. Existing backend validation/rendering produces the numerical text.
An answer without evidence, invented references, duplicate findings, arbitrary
prose, or model-owned prices is rejected. Partial quote data and differing trading dates
retain evidence and limitations but cannot produce an answered comparison.

Supported quote research remains reported quotes, daily high-minus-low ranges,
ordered percentage-point differences, and rankings of reported percentage changes.
Historical research now supports the four descriptive metrics below, including
single-metric reports and pairwise comparisons. Momentum, forecast, valuation, and trading requests
are rejected by a conservative scope guard. Other unsupported/ambiguous requests
use model-selected unsupported/clarification statuses. This is not a general
semantic proof that every possible question has been understood; the factual
guarantee is limited to validated evidence relationships and backend-rendered text.
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
`tool_requests`, and safe `tool_outcomes` (quote/unknown tool name, validated symbols,
outcome code). Additive historical fields and overall `status` are documented below.
`tool_requests` counts all requests observed, including a rejected batch,
so it can exceed two even though no more than two invocations execute. There is
no HTTP status mapping inside the component; the route applies the contract below.

Existing safe explanation codes are reused, with `tool_budget_exhausted` and
`model_budget_exhausted` added. Deadline failures retain completed quote outcomes;
missing outcomes become safe timeout errors without new provider calls. Shared
quote fetches retain the existing cancellation policy and can finish in the
service cache after a caller times out. The HTTP route shares the existing
process-local research admission lock. There is no daily spending cap.

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


## Research agent HTTP endpoint

`POST /api/research/agent` accepts exactly one field:

```json
{"question":"Compare Apple and Microsoft’s reported percentage changes."}
```

The question must be a string, trimmed to 1–1,000 characters. Missing, blank,
non-string, oversized questions and extra fields (including `symbols`) receive
HTTP 422 with FastAPI validation details, before any agent or quote call.
The model selects supported symbols through validated quote/historical tools;
the HTTP route does not implement another loop.

| HTTP | Response |
| --- | --- |
| 503 | `AgentResult` with `research_unavailable` when research is disabled or configuration is missing/invalid; no agent/model calls |
| 429 | `AgentResult` with `research_busy` when either research endpoint is active; no queued work |
| 200 | Completed `AgentResult`; inspect overall `status`, quote `explanation`, and `historical_findings`, including safe failure/timeout outcomes |
| 422 | FastAPI request-validation error |

The typed `AgentResult` schema is published in `/openapi.json`. It contains the
trimmed `question`, nullable `quotes` (source evidence, metadata, fictional labels,
and backend calculations), `explanation` (status, code, safe message, validated
findings), `model_calls`, `tool_requests`, and `tool_outcomes` (tool, validated
symbols, code). Configuration and busy results have null quotes, zero counters,
and no tool outcomes. A 200 response does not imply an answered question: quota,
refusal, invalid model output, unsupported requests, exhausted budgets, partial
provider results, and timeouts remain structured agent outcomes. No raw errors,
internal prompts, conversation, signatures, or hidden reasoning are returned.

Both research endpoints share one configured Gemini client, closed once at
application shutdown, and one nonblocking admission lock. The slot is released
on success, failure, timeout, and cancellation. The existing 30-second agent
deadline, three-model-call/two-tool-invocation budgets, evidence validation,
fictional labeling, and quote cache policy are unchanged. `/api/research` keeps
its existing request, response, and status behavior.

For a later **manual demo-data/live-Gemini check**, stop the old backend first.
With your key already in the ignored local `.env`, run from `backend/`:

```sh
RESEARCH_ENABLED=true MARKET_DATA_PROVIDER=demo .venv/bin/python -m uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8000
```

Then, from another terminal:

```sh
curl --fail-with-body -i http://127.0.0.1:8000/api/research/agent \
  -H 'Content-Type: application/json' \
  -d '{"question":"Compare Apple and Microsoft reported percentage changes."}'
```

This sends a real request to Gemini but uses fictional market quotes. It was not
run automatically. Keep loopback binding and one worker: there is no authentication
or daily spending cap. CORS allows GET/POST, Content-Type, and Authorization for the two explicit local frontend origins.
Endpoint tests use mocks and require no key or `.env` loading. Live Gemini and
market-provider behavior remain unverified.

## Internal fictional historical data

`app.historical_data.get_history()` is a synchronous service, exposed through the
history endpoint below, with no direct agent-tool registration, provider adapter, environment
configuration, or cache of its own.
It accepts `HistoricalInput` or a dictionary with `symbol`, `start_date`,
`end_date`, and optional `interval="daily"`. Python callers supply `date` objects;
`HistoricalInput.model_validate_json()` accepts ISO date strings. Symbols reuse
the quote service's normalization and AAPL/MSFT/NVDA allowlist. Extra fields,
reversed ranges, and intervals spanning two years or more from the start's
anniversary are rejected: the inclusive end must precede the two-year anniversary
(February 29 anniversaries clamp to February 28). For example, January 1, 2024
through December 31, 2025 is allowed.

All three symbols have exactly 523 **fictional synthetic weekday observations**
from **2024-01-01 through 2025-12-31**, inclusive. These are not actual trading
dates or a real exchange schedule: weekdays include holidays. No exchange
metadata or exchange-calendar completeness is claimed. Prices are self-authored
integer-cent formulas with fixed symbol bases, a small index trend and periodic
offsets. Volume is a synthetic integer except every seventeenth observation,
where it is deliberately missing (`null`). Generation does not depend on today's
date or randomness. These fixtures are separate from and do not reconcile with
the standalone demo quotes. They cannot establish real market performance.

The typed result retains the requested range and reports the actual returned
range (null when empty), USD currency, timezone-aware fetch time, `source="demo"`,
`data_kind="fictional"`, an explicit fictional label, and
`adjustment_basis="unknown"`. Corporate actions are not modeled. Coverage is
`within_fixture`, `partial_overlap`, or `outside_fixture`, describing date-bound
overlap rather than completeness. Bars are ordered, unique, finite positive OHLC
values with consistent high/low bounds and optional strict nonnegative integer
volume. Invalid bars are rejected, not repaired.

Filtering is inclusive. Weekends and dates outside the fixed coverage produce no
observations; they are never forward-filled. A weekend-only or wholly outside
request returns `status="empty"`, no bars, and no returned range. Partial overlap
retains only available bars. The fetch timestamp describes local generation,
not market-data freshness. No indicators, returns, or adjustment assumptions are
introduced by this service.

### Fictional history HTTP endpoint

`GET /api/stocks/{symbol}/history?start_date=2025-01-01&end_date=2025-12-31`
calls the existing historical service directly. Both query dates are required,
must be real dates in exact `YYYY-MM-DD` format, and are inclusive. Supported
symbols are AAPL, MSFT, and NVDA, case-insensitively. Only daily history is
supported; there is no interval parameter. Unknown or repeated query parameters
are rejected. The historical service owns range validation, including its
two-calendar-year bound described above.

HTTP 200 returns the existing `HistoricalResult`, including fictional/demo labels,
unknown adjustment basis, requested/returned/fixture ranges, coverage, limitations,
timezone-aware fetch time, and ordered OHLCV bars with nullable volume. Empty and
partial results also return 200. HTTP 422 rejects missing or malformed dates,
invalid ranges, unsupported symbols, and unknown/repeated query parameters using
a `detail` response. Framework validation errors contain a detail list; calendar,
symbol/range, and query-parameter checks use fixed safe detail strings. This
history input-validation contract does not change the quote endpoint's 400/404
symbol errors.

History is **always fictional demo data**, even when `MARKET_DATA_PROVIDER` selects
a live quote provider. It requires no credentials and works with research disabled.
No quote-provider or model requests are made by this route. The current frontend charts
and historical agent tool consume these same fictional fixtures; real quotes do not change them.

For a local check, stop any old backend and run from `backend/` without loading
an environment file:

```sh
MARKET_DATA_PROVIDER=demo RESEARCH_ENABLED=false .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Successful short range, empty weekend, and invalid reversed range respectively:

```sh
curl -i 'http://127.0.0.1:8000/api/stocks/aapl/history?start_date=2025-01-01&end_date=2025-01-03'
curl -i 'http://127.0.0.1:8000/api/stocks/AAPL/history?start_date=2025-01-04&end_date=2025-01-05'
curl -i 'http://127.0.0.1:8000/api/stocks/AAPL/history?start_date=2025-01-03&end_date=2025-01-01'
```

## Internal descriptive historical metrics

`app.historical_metrics.calculate_historical_metrics(history)` is a pure function
accepting an already validated `HistoricalResult`. It revalidates that model, uses
only its supplied observations, and does not retrieve data, mutate input, fill
dates, read configuration, or call a provider. The agent uses it through the compact
historical-research wrapper; it has no separate endpoint or frontend. No dependency was added.

The typed `HistoricalMetrics` result marks `origin="backend"` and retains the
complete source result under `history`, including symbol, currency, fictional
label, adjustment basis, requested/returned/fixture ranges, coverage, fetch time,
limitations and bars. Calculated fields are separate from those source fields:

| Metric | Definition | Required closes | Unit |
| --- | --- | --- | --- |
| `price_change` | `(last close / first close - 1) * 100`, across all supplied observations | 2 | percent |
| `sma_20` | Arithmetic mean of latest 20 closes | 20 | USD |
| `sma_50` | Arithmetic mean of latest 50 closes | 50 | USD |
| `adjacent_return_volatility_20` | Latest 20 simple returns from 21 closes; sample standard deviation multiplied by 100 | 21 | percent |

For volatility each return is `current close / previous close - 1`. Subtract the
mean return, square the differences, sum, divide by **19**, and take the square
root before multiplying by 100. This is adjacent-observation return volatility,
**not annualized** volatility. Calendar gaps remain gaps, not zero returns.
Observations are not described as trading days for these synthetic fixtures.

Each metric has `status`, `value`, `unit`, `window` (actual first/last observation
dates), `observation_count`, `required_observations`, and `reason`. Insufficient
history produces `status="unavailable"`, null value/window, and an explicit
reason; its count reports available observations. Available metrics report their
actual window count and no reason. `volatility_return_count` is 20 when computed,
otherwise 0. A sufficient constant-price series correctly has available zero
volatility, distinct from unavailable volatility.

Calculations convert closes using `Decimal(str(close))` inside a fresh local
context with **680 significant digits** and half-even rounding. The accepted
positive finite binary64 prices include `5e-324` and `1.7976931348623157e308`.
Their decimal-string ratio is below `3.6e631`; multiplying by 100 gives at most
634 integer digits. The budget is **634 + 6 fractional digits + 40 guard digits**.
Squaring returns increases their exponent; it does not require doubling the
significant-digit budget for the final square-root output. Decimal's exponent
range already accommodates these values, so this is not an overflow workaround.

The previous 1400-digit budget was unnecessarily conservative for the demonstrated
cases. At 28 or 50 digits, an extreme price change fails final `quantize()` with
`InvalidOperation`. Even small magnitudes can need substantial precision: the
mean of one `0.00001` close and nineteen `5e-324` closes is just above `0.0000005`.
At 50 digits the tiny contribution disappears and rounds incorrectly to zero;
680 digits retains it and returns `"0.000001"`. Tests check an exact integer
extreme-price-change oracle and compare extreme volatility outputs with a
2800-digit reference. The guard budget is conservative, not a proof of minimal
precision or exhaustive correctly rounded results at every possible boundary.
Intermediate returns are not quantized; only final values are rounded to **six
decimal places**, half-even, with negative zero normalized to zero. Decimal
values serialize as strings, such as `"25.000000"`. Outputs must be finite; the
caller’s precision, rounding mode and traps do not change results. Syntax and
APIs remain compatible with Python 3.10.

These are descriptive calculations on fictional data, not forecasts, signals or
recommendations. Unknown adjustment basis and unmodeled corporate actions remain
explicit limitations. Price change is **not dividend-inclusive total return**;
future real-provider data needs adjustment checks before use. Partial coverage
retains its source metadata and adds a warning that calculations use only supplied
observations, with actual metric windows rather than the entire requested range.

Illustrative fictional example: 50 weekday observations with every close at
USD 100 yield price change `"0.000000"` percent, SMA20/SMA50 `"100.000000"` USD,
and adjacent-observation return volatility `"0.000000"` percent. All four are
available. This is a hand-authored example, not actual market performance.

## Internal historical-metrics research tool

`app.historical_research.get_historical_metrics(request)` is a synchronous internal
wrapper, with no separate HTTP endpoint. The agent now registers it as a controlled
Gemini tool, as described below. It accepts `HistoricalResearchInput` or a dictionary with exactly
`symbols` (one to three unique AAPL/MSFT/NVDA symbols), `start_date`, and `end_date`.
Python callers supply `date` objects; `HistoricalResearchInput.model_validate_json`
accepts ISO dates. Symbol normalization and duplicate validation reuse `QuotesInput`;
each symbol's dates reuse `HistoricalInput`, including its two-calendar-year bound.
The entire request is validated before any history retrieval. Invalid input raises
`ValidationError`; no symbols are silently dropped.

For every symbol, the wrapper calls the existing `get_history` once and passes
that validated result to `calculate_historical_metrics`. It retains the full
metrics result locally while projecting a typed compact response. No calculations
are repeated, Decimal values are not converted to floats, and raw OHLCV arrays
are absent from the response.

The result includes the normalized `request`, an `evidence` tuple, `errors`, and
explicit fictional labels and limitations. Evidence IDs `hm1`, `hm2`, `hm3` follow
normalized request order and are stable within that invocation; they are separate
from quote IDs `q1`, etc. IDs restart for each invocation and are not global IDs.
Each evidence item includes:

- `origin="backend"` and compact `provenance`: symbol, USD currency, demo source,
  fictional label, unknown adjustment basis, daily interval, synthetic weekday
  calendar, requested/returned/fixture ranges, coverage/status, and fetch timestamp.
- The four unchanged `HistoricalMetric` records: Decimal value (JSON string),
  unit, availability/reason, actual window, and observation counts.
- `volatility_return_count` and all source/metric limitations, including partial
  coverage warnings and the distinction from actual market performance.

Short or empty history is valid evidence with unavailable metrics, not an error
and not a zero substitute. The current fictional history service has **no expected
per-symbol runtime domain failures after input validation**, so `errors` is empty
(typed with the existing `SymbolError` convention). This wrapper deliberately does
not invent provider failures or catch `ValueError`, downstream `ValidationError`,
arithmetic errors, or other programming errors. Such errors propagate, and a
mismatched returned symbol/range is rejected. A future live adapter must define
its expected domain exceptions and safe per-symbol mappings before it is added.

The wrapper itself performs no rankings, signals, recommendations, or cross-stock
calculations. The agent validates pairwise selections separately, checking matching
**actual metric windows, units, adjustment basis, and availability**, not merely
matching requested dates. Unknown adjustment basis remains a limitation; these
descriptive fixture comparisons do not establish suitability of real-provider data.

## Historical metrics in the bounded research agent

`POST /api/research/agent` still accepts only `question`. Natural-language requests
can now select `get_historical_metrics` with this exact tool argument shape:

```json
{"symbols":["AAPL","MSFT"],"start_date":"2025-01-01","end_date":"2025-03-31"}
```

Symbols reuse the existing allowlist/normalization and must be unique after
normalization (one to three). Dates must be explicit `YYYY-MM-DD`, ordered, and
within the existing two-calendar-year request bound. Extra fields are rejected.
The complete request is validated before retrieval. The wrapper owns all history
retrieval and calculations; the loop does not duplicate either. These histories
are always fictional, independently of the configured quote provider.

The instructions state the exact fictional coverage, **2024-01-01 through
2025-12-31**, and require clarification for missing or ambiguous dates. Common
relative periods such as “last month” are also caught before model calls. Requested
dates are never moved into coverage: outside/short intervals retain empty or
unavailable metrics, and partial coverage retains its warnings. The question is
not restricted to exact templates. Unrecognized semantic ambiguity still depends
on the model following instructions; mocked tests do not prove live interpretation.

Both tools share **three model calls, two tool invocations, and 30 seconds total**.
Validation failures/unknown tools consume budget. Execution remains sequential;
the correct `user` function-response role, IDs, original model parts/signatures,
no automatic retries, and shared HTTP concurrency lock are unchanged. Local
historical calculations run in a worker thread so the existing deadline and
cancellation remain responsive. A cancelled calculation may finish locally but
cannot publish evidence or trigger another model call.

The loop memoizes each normalized `(symbol, start_date, end_date)` for the request.
Repeated or reordered requests reuse exactly the same evidence, IDs, and fetch
timestamps; overlaps collect only new symbols. New symbols/ranges append evidence
with unique `hm1`, `hm2`, … IDs across the entire run. Earlier evidence is never
overwritten. Quote IDs stay in the `q` namespace. Historical fixtures and standalone
demo quotes remain separate datasets, never one continuous price series. Nothing
is persisted between agent requests.

Model historical selections contain only:

```json
{"metric":"price_change","evidence_ids":["hm1","hm2"],"relation":"higher"}
```

Allowed metric keys are `price_change`, `sma_20`, `sma_50`, and
`adjacent_return_volatility_20`. A single ID requires `reported`; a pair requires
`higher`, `lower`, or `equal`, describing the first value relative to the second.
At most four total quote/historical findings are accepted. Unknown IDs, duplicate
findings/operands, unavailable metrics, model-supplied numbers/prose, and unsupported
relations are rejected as `invalid_model_output`; retained evidence remains available.

`historical_findings.py` validates availability and actual metric windows, units,
currency, observation/required counts, adjustment basis, source, data kind, fixture
range, interval, and observation calendar (plus return counts for volatility).
Matching requested dates is insufficient. Compatible actual windows may support a
comparison even when the requested ranges differ. Direction uses the canonical
serialized Decimal values: equal six-decimal evidence values require `equal`.
Backend-rendered statements include the actual dates, observation count, unit,
fictional context, unknown adjustment basis, and incomplete-coverage warnings.
Lower volatility describes lower measured return variability, not overall safety.
Nominal SMA levels do not establish better performance; price change is not
dividend-inclusive total return. No forecasts, advice, or historical rankings exist.

### Additive API fields and current UI compatibility

The existing quote fields and `/api/research` contract are unchanged. `AgentResult`
adds these typed fields, also published in OpenAPI:

- `status`: overall `answered`, `clarification`, `unsupported`, or `unavailable`.
- `historical_evidence`: cumulative compact backend metric records, preserving
  Decimal strings, actual windows/counts, requested/returned ranges, source,
  fictional labels, fetch timestamps, unknown adjustment basis, and limitations.
  No raw OHLCV bars are sent.
- `historical_findings`: validated selections plus `statement` and
  `statement_origin="backend"`.
- `historical_tool_outcomes`: validated symbols/dates and safe outcome codes.
  Invalid arguments omit unvalidated fields; empty results are `unavailable`,
  partial coverage is `partial`, and ordinary collection is `ok`. Short history
  may still be `ok` while individual metrics explicitly remain unavailable.

The current frontend parser allows additive fields but only understands quote
findings and quote tool names. Historical activity therefore lives in its own
array. A historical-only success has overall `status="answered"`, its historical
findings, and a legacy quote `explanation` with `status="clarification"`, empty
findings, and code `historical_answer_available`. That is a compatibility notice,
not a claim that the historical answer is unavailable. The current UI displays
the notice under its existing “Clarification needed” heading, without historical
tool activity; **historical evidence/findings/tool rendering is a later milestone**.
Mixed results retain ordinary answered quote findings plus separate historical
findings. Consumers of historical answers must use overall `status` and the new
fields, not only the legacy quote explanation.

HTTP statuses remain 422 for invalid input, 503 for missing/disabled configuration,
429 for shared concurrency rejection, and 200 for completed safe agent outcomes.
Errors, refusals, and deadlines publish no final historical findings. No raw SDK
errors, prompts, hidden reasoning, or credentials are exposed.

For a later user-run **live Gemini / fictional data** check (not an automated test):

```sh
curl --fail-with-body -i http://127.0.0.1:8000/api/research/agent \
  -H 'Content-Type: application/json' \
  -d '{"question":"Compare Apple and Microsoft price change from 2025-01-01 to 2025-03-31 using fictional historical data."}'
```

Mocked tests cover the actual SDK wire exchange, preserved signatures/correlation,
selection validation, memoization and IDs, shared budgets/deadlines, API serialization,
and quote compatibility. No live model/provider calls are part of validation.

## Backend identity verification

`GET /api/me` and the watchlist routes below require a user access token. All existing health, quote,
history, and research routes remain public. Frontend integration is not part of
this milestone; the account route guard does not authorize backend requests.

Configure these backend-only variable names locally (placeholders shown):

```dotenv
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_REPLACE_WITH_YOUR_PUBLIC_KEY
```

Use the same hosted Supabase project as the frontend. Only HTTPS project origins
`https://<project-ref>.supabase.co` (optional trailing slash) are accepted; custom
domains, local Supabase, credentials, ports, query strings, and other paths are
not supported here. Only publishable keys are accepted. Never use a secret or
service-role key, database password, or signing secret. Missing/invalid settings
leave public routes working. No environment file is loaded automatically.

For later manual testing, after setting those variables in your local shell:

```sh
cd /Users/irvin/Documents/MarketSim/backend
MARKET_DATA_PROVIDER=demo RESEARCH_ENABLED=false .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Send the signed-in user's access token in exactly one `Authorization: Bearer`
header to `/api/me` using a trusted local HTTP client. Do not paste tokens into
chat, logs, URLs, or shell history. Scheme matching is case-insensitive. The
entire ASCII header is limited to 8,192 characters; empty, duplicate, comma-joined,
or malformed credentials are rejected. Query, cookie, and body tokens are never
used. This endpoint does not refresh tokens or inspect unverified JWT claims.

The reusable dependency calls the fixed `/auth/v1/user` endpoint with per-request
`apikey` and `Authorization` headers. A separate lifespan-managed HTTPX client has
no retries, redirects, or environment proxies, a two-second connection timeout,
and a five-second overall deadline including response reading. Cancellation
propagates. There is no token-result cache and no shared mutable auth header.

| Result | HTTP response |
| --- | --- |
| Verified UUID from successful Auth response | 200, only `{"user_id":"<uuid>"}` |
| Missing/malformed header or documented user credential rejection | 401, safe detail and `WWW-Authenticate: Bearer` |
| Invalid/missing configuration or verification-service failure | 503, safe detail |

Success and authentication errors include `Cache-Control: no-store`. Documented
rejection codes are `bad_jwt`, `no_authorization`, `session_expired`,
`session_not_found`, `user_banned`, and `user_not_found` on 4xx responses other
than 429. Unknown errors, invalid JSON/user UUID, redirects, timeouts, 429, and
5xx return 503; raw provider details are never exposed or logged. CORS additionally
allows Authorization for the same two local origins; methods and cookie settings
are unchanged.

Official contracts consulted October 21, 2026:
[Supabase JWT verification](https://supabase.com/docs/guides/auth/jwts) and
[Auth error codes](https://supabase.com/docs/guides/auth/debugging/error-codes).
Supabase owns cryptographic verification; this works without assuming the
project's signing algorithm. Mocked rejections test our handling, not Supabase's
cryptographic verification. Tests use mock transports and forbid live requests.
Later manually check a real user UUID, absent/invalid credentials, and unchanged
public routes. Logout must not be treated as guaranteed immediate access-token
revocation: issued access tokens may remain usable until expiry. This milestone
adds no ownership policy, database access, or authorization of existing routes.

## Authenticated personal watchlist API

These routes use the existing SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY settings
and require one user Bearer token under the same validation rules as `/api/me`.
They do not change the public quote/history/research routes or the frontend's
fictional sample watchlist. There is no frontend or agent integration yet.

| Request | Success |
| --- | --- |
| GET /api/watchlist | 200 `{"items":[{"symbol":"AAPL","created_at":"2026-10-22T12:00:00Z"}]}`; sorted by symbol, empty list allowed |
| POST /api/watchlist with `{"symbol":" aapl "}` | 201 `{"symbol":"AAPL","created_at":"..."}` |
| DELETE /api/watchlist/AAPL | Empty 204, whether present or already absent |

The example timestamp is illustrative. Input is trimmed/normalized using the
existing symbol validator and restricted to AAPL/MSFT/NVDA. Extra POST fields,
including user_id, are rejected. Every request verifies identity through Auth.
The request-local context holds the verified UUID and original token; the token
uses SecretStr, is omitted from repr/serialization, and is never a response field.
`/api/me` retains its UUID-only response and existing verification behavior.

The Data API uses a separate lifespan-managed HTTPX client with at most three
connections, no environment proxies, redirects, or automatic retries. Headers
are set per request; no token is stored in shared defaults. A fixed validated
project URL determines `/rest/v1/watchlist_items`. GET/DELETE carry structured
owner filters and DELETE also filters the symbol. POST supplies the verified
owner explicitly, never a client-provided owner. Normal INSERT is used with
`return=representation, missing=default`, not upsert: duplicate saves cannot
update the original timestamp. DELETE requests a representation internally to
validate any returned owner/symbol before discarding it and returning 204.

Returned rows must have the expected UUID owner, supported canonical symbols,
and timezone-aware timestamps. Duplicates, mismatched write symbols, invalid
shapes/cardinality, and malformed data become safe service errors. Only symbol
and created_at are exposed. Database RLS remains authoritative and unchanged.
There is no watchlist or token-result cache.

A route-specific ten-second total deadline includes request processing, identity
verification, database access, and body reading. Auth still has its existing
five-second inner limit. Cancellation propagates to outstanding work. A timed-out
write may have completed: refresh the list before deciding whether to retry.

All handled watchlist responses, including validation errors, use
`Cache-Control: no-store`. Error details never echo input or upstream bodies:

- 422: invalid input.
- 401 with `WWW-Authenticate: Bearer`: missing/rejected credentials, including
  recognized Data API JWT errors PGRST301/PGRST302/PGRST303.
- 409: POST uniqueness violation 23505 (already saved).
- 403: recognized insufficient-privilege error 42501.
- 503: unavailable configuration/schema, timeout, transport/rate-limit/server
  failure, unrecognized upstream errors, redirects, or malformed results.

CORS now permits DELETE as well as GET/POST for the same two localhost origins;
Authorization/Content-Type and disabled cookie credentials are unchanged.

Official PostgREST documentation consulted October 22, 2026:
[table requests](https://docs.postgrest.org/en/stable/references/api/tables_views.html),
[response preferences](https://docs.postgrest.org/en/stable/references/api/preferences.html),
and [error codes](https://docs.postgrest.org/en/stable/references/errors.html).

Validation uses mocked Auth/Data API HTTPX transports and network guards. It
checks request ownership/headers, concurrent users, validation/error mapping,
response schemas, cancellation, the combined deadline, no write retries, cleanup,
CORS and existing route regressions. These mocks do not prove live Data API
integration or replace the real PostgreSQL/RLS tests under supabase/tests.

Before a later live integration check, separately review hosted migration
application, exposed schema and explicit table grants/RLS. No migration is
applied by this application. Then check two synthetic accounts through list/add/
duplicate/delete, confirm independent ownership, and ensure timestamps survive a
duplicate add. Never use administrative credentials or copy tokens into logs.
This milestone made no live requests and did not access or modify the hosted project.


## Private free end-of-day quote check

User-reported manual verification completed October 29, 2026 with research disabled:
AAPL, MSFT, and NVDA each returned HTTP 200 with `source=alpha_vantage`,
`data_kind=end_of_day`, and reported trading date `2026-10-28`. Repeated AAPL
returned `cache_hit=true` with unchanged quote values and the original `fetched_at`.
These checks establish successful provider responses and cache reuse, not independent
price accuracy, ongoing availability, or public-display permission. Historical data
remains fictional; real-data Gemini research is untested. No provider payloads or
prices were retained as fixtures.

Automated coverage uses synthetic provider payloads and mocked HTTP only. Use only a free
Alpha Vantage key; do not enable billing, buy a plan, or subscribe. The readiness
review checked [free access](https://www.alphavantage.co/support/),
[GLOBAL_QUOTE documentation](https://www.alphavantage.co/documentation/#latestprice),
and [terms](https://www.alphavantage.co/terms_of_service/) on October 27, 2026:
standard free access is 25 requests/day and the default quote is end-of-day.
This adapter does not request premium real-time/delayed entitlements. If free access
is rejected, stop and inspect the safe error; do not upgrade or retry repeatedly.

`MARKET_DATA_PROVIDER=demo` remains the default and explicit fictional mode.
`MARKET_DATA_PROVIDER=alpha_vantage` requires `ALPHA_VANTAGE_API_KEY` exclusively
in backend environment variables. Never put it in React/VITE configuration, URLs
entered in a browser, chat, logs, or committed files. Provider errors never fall
back to fictional quotes.

Use one backend worker, without reload, for this check. Successful quotes remain
cached for six hours; concurrent callers share each symbol's pending request.
The 20-attempt rolling-24-hour budget is process-local and counts failures. Restarting
resets it; additional workers/processes and other uses of the same key consume provider
quota independently. It is not an account-wide limit. Do not restart to evade quotas.
A fresh process plus the sequence below needs at most three provider attempts on success.
Avoid opening watchlist quote panels or using other clients during the check.

Trading date is the provider's reported date, not the retrieval date. Old dates remain
visible and valid; no exchange-calendar freshness guarantee is made. `fetched_at` records
retrieval only and is preserved on cache hits. A six-hour cache can retain an older EOD
quote after a newer one becomes available. The only accepted provenance pairs are
`demo/fictional` and `alpha_vantage/end_of_day`. Research preserves those fields and
cache status; frontend research validation rejects contradictory provenance/fictional flags
or bundle modes. History remains separate fictional 2024–2025 data in either mode.
Public demos must stay in fictional mode until display/redistribution rights are resolved.

Manual verification procedure (not part of automated validation):

1. Stop only your old MarketSim backend. Obtain a free key from the official free-key
   page yourself. In a local **zsh** terminal, enter it at the hidden prompt below;
   the value is not part of command history. Do not enable shell tracing.
2. Start on loopback without loading any environment file:

```zsh
cd /Users/irvin/Documents/MarketSim/backend
read -rs 'ALPHA_VANTAGE_API_KEY?Alpha Vantage free API key (hidden): '
printf '\n'
export ALPHA_VANTAGE_API_KEY
MARKET_DATA_PROVIDER=alpha_vantage RESEARCH_ENABLED=false .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
unset ALPHA_VANTAGE_API_KEY
```

3. In another terminal, run each command once, sequentially. Stop on an error;
   do not treat it as a reason to purchase access or loop retries:

```sh
curl --fail-with-body http://127.0.0.1:8000/api/stocks/AAPL/quote
curl --fail-with-body http://127.0.0.1:8000/api/stocks/MSFT/quote
curl --fail-with-body http://127.0.0.1:8000/api/stocks/NVDA/quote
curl --fail-with-body http://127.0.0.1:8000/api/stocks/AAPL/quote
```

4. Verify each successful response has the requested symbol, USD, `alpha_vantage`,
   `end_of_day`, valid prices, a reported trading date and a timezone-aware fetch time.
   The repeated AAPL response should have `cache_hit=true`, identical original
   `fetched_at`, trading date and values. Do not infer freshness from HTTP 200.
5. Stop the backend with Control-C; the following `unset` clears the key from that
   shell. To return to explicit demo mode, use:

```sh
MARKET_DATA_PROVIDER=demo RESEARCH_ENABLED=false .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

No research submission, history-provider change, live test automation, or public
real-data deployment is authorized by this sequence. The recorded manual result above
is limited to that check; mocked tests cannot establish live entitlement or freshness.

## Internal real-history retrieval foundation

`app.real_history.HistoricalService` is an internal async service, not a new
endpoint or agent tool. Existing history routes, charts, metrics and historical
research still use the fixed fictional 2024–2025 fixtures. Quote configuration
never activates real history. The lifespan creates `app.state.historical_data`
in default demo mode and shares its HTTPX client and `ProviderBudget` with quotes.

The internal interface is `await service.get_history(HistoryRequest(...))` (a
validated dictionary also works). A caller-owned instance is constructed with
`HistoricalService(client, budget=shared_budget)` for demo mode or explicitly
`HistoricalService(client, budget=shared_budget, mode='alpha_vantage')` for real
retrieval. Close it with `await service.close()` before closing the HTTPX client.
Use the same `ProviderBudget` instance in `MarketData(client, budget=shared_budget)`.
The application lifespan already owns this setup and cleanup. Use the application
client's bounded connections, disabled transport logging, and default zero transport
retries. Custom callers must preserve these settings; redirects are explicitly
disabled on every history request.

Real mode reads only the existing backend `ALPHA_VANTAGE_API_KEY`, or an explicit
backend constructor argument. No new environment variables are needed; no keys
belong in frontend configuration. `HistoryRequest` accepts one supported normalized
symbol (AAPL/MSFT/NVDA), inclusive explicit dates and daily interval only. Python
inputs use `date` objects; `HistoryRequest.model_validate_json()` accepts ISO dates.
Extra fields, reversed ranges and intervals exceeding **90 calendar days** fail
before network access. This application bound is not a provider coverage guarantee.
It applies to both modes of this new wrapper; the existing fictional endpoint keeps
its original two-calendar-year contract.

The fixed request uses `TIME_SERIES_DAILY`, `outputsize=compact`, `datatype=json`
at `https://www.alphavantage.co/query`. The official
[daily documentation](https://www.alphavantage.co/documentation/#daily), checked
October 29, 2026, documents free compact access to the latest 100 observations;
full daily history requires premium access. This service uses only compact raw
prices: no billing, subscription, paid endpoint or premium fallback. A limited AAPL
live check is recorded below; MSFT/NVDA live history remains unverified.

The separate `RealHistoryResult` reports `source=alpha_vantage`,
`data_kind=end_of_day`, `adjustment_basis=unadjusted`, USD, requested range,
available snapshot range, actual returned range (null when empty), original UTC
retrieval timestamp, cache status, ordered OHLCV bars, timezone and limitations.
Coverage is `within_snapshot_bounds`, not exchange-calendar completeness. Requests
outside either snapshot boundary raise `HistoryError` with status 422 and typed
`available_range`; there is no silent partial success. An interval inside those
bounds may legitimately have no observations (`status=empty`).

All bars are validated, including those outside the requested subrange. Duplicate
JSON keys/dates fail before decoding can overwrite them. Dates remain dates;
observations are sorted ascending without filling gaps. OHLC must be finite,
positive and range-consistent. Missing OHLC fails. Volume must be a nonnegative
integer string or missing/null (preserved as null); booleans and malformed values
fail. Symbol metadata must match. Recognized IANA timezone metadata is preserved;
missing/unrecognized timezone becomes null, explicitly unknown. Arbitrary provider
text is not forwarded. Neither timezone nor retrieval time proves session completion
or freshness; no daily midnight timestamps or exchange calendar are fabricated.

Raw prices may contain split discontinuities. Splits/dividends are neither detected
nor adjusted. Real results intentionally fail the existing fictional metrics input
boundary; they contain no `fixture_range` or synthetic-weekday labels. No real data
is passed to Gemini or used to calculate returns/volatility in this milestone.

Fetches have a ten-second total network/body deadline and 256 KiB decoded body cap.
At most 100 bars are accepted. Only validated snapshots are cached: one per supported
symbol, at most three, for six hours. Subranges share snapshots and pending fetches.
Cache hits preserve original `fetched_at`; waiters joining a new fetch are not cache
hits. Expired snapshots are replaced, never accumulated into longer history. Failures
do not serve expired or fictional replacements. A range error can leave a valid
snapshot cached for a later narrower request. Cancelling one waiter does not cancel
shared work; shutdown cancels pending work, closes streams and clears the cache.

Quotes and real history share **20 attempted requests per rolling 24 hours**,
reserved before network awaits. Failures count; cache hits do not. Quote caching
and coalescing are unchanged. Use one worker: this process-local budget resets on
restart and cannot track other processes consuming the same provider key. Do not
restart to bypass quotas. No automatic retries are added. Safe errors distinguish
quota (429), provider/malformed data/oversized body (502), unavailable configuration
or closed service (503), and timeout (504), without raw messages or credentials.

Tests use self-authored fixtures and mocked transport for validation, cache/budget,
streaming bounds, cancellation, metrics rejection and unchanged fictional routes/tools.
Public-display, external-LLM and cache-retention
rights remain unresolved: the TTL is an engineering bound, not a license entitlement.
Public demos stay fictional.

### Manual verification — October 29, 2026

The user completed a local AAPL history check for 2026-10-01 through 2026-10-23.
It returned 17 observations with matching returned bounds, `source=alpha_vantage`,
`data_kind=end_of_day`, and `adjustment_basis=unadjusted`. The second identical
request reused the cache with identical bars and the original `fetched_at`.
The check permitted at most one upstream attempt. No Gemini calls or provider data
files were created.

This establishes successful AAPL retrieval and cache reuse, not independent price
accuracy, complete exchange-calendar coverage, MSFT/NVDA live-history verification,
adjustment support, or public-display permission. Existing charts and historical
research remain fictional.

### Procedure for any later local check

After reviewing private cache/storage terms and separately authorizing a minimal check:

1. Stop other provider consumers and keep `RESEARCH_ENABLED=false`. Supply the existing
   free key privately to backend environment variables; never paste it into chat.
2. Use a short local async harness with redirects/retries and transport logging disabled,
   one shared budget, and an explicitly real-mode history service. Do not load actual
   environment files. Existing history HTTP endpoints intentionally remain fictional.
3. Make one AAPL request covering at most 90 days and ending on a known past observation
   date. On range-unavailable, review available bounds before narrowing against the
   cached snapshot. Stop on other errors rather than retrying or upgrading.
4. Review summary provenance, count, ranges and timestamps. Repeat the accepted range
   once to verify unchanged bars, original `fetched_at` and `cache_hit=true`. Do not
   save payloads as fixtures, calculate metrics or send the data to Gemini.
5. Close the service/client and remove the key from that shell. Record actual outcomes.
   Further symbols and chart/research integration are separate reviewed milestones.

These steps are a proposal, not authorization to execute live requests.
