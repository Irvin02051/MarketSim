# MarketSim frontend

React dashboard with static demo data, an API health indicator, a research interface,
and fictional stock-history charts. Authentication and trading remain demos.

## Run both servers (separate terminals)

Backend terminal, using the existing virtual environment:

```sh
cd /Users/irvin/Documents/MarketSim/backend
source .venv/bin/activate
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

See [backend setup](../backend/README.md) if the virtual environment is missing.

Frontend terminal:

```sh
cd /Users/irvin/Documents/MarketSim/frontend
# Create configuration only if absent; never overwrite existing settings.
if [ ! -e .env.local ]; then cp -n .env.example .env.local; fi
npm run dev -- --port 5173 --strictPort
```

Open http://localhost:5173/dashboard or http://127.0.0.1:5173/dashboard.
The local configuration must set `VITE_API_BASE_URL` to the backend's HTTP(S)
base URL. Trailing slashes are supported. Do not include credentials, a query,
or a fragment in this URL. Restart Vite after changing environment settings;
production bundles must be rebuilt. All `VITE_` values are public browser
configuration: never put passwords, tokens, or secret keys there.
`.env.local` is ignored; `.env.example` contains only a public local URL.

If a port is occupied, do not stop another project's server. For the backend,
choose another free port and update your local API URL, then restart Vite.
The frontend requires port 5173 for the current CORS allowlist; `--strictPort`
prevents Vite from silently switching to an unapproved port.

## Verify the connection manually

1. With both servers running, open `/dashboard`. Service status should change
   from “Checking connection…” to “Connected”.
2. Stop only your backend using Control-C in its terminal. Select “Check
   connection”. Expect “Unavailable”; the sample dashboard remains usable.
3. Restart your backend using the same command and select “Retry”. Expect
   “Connected”. There is no periodic polling.
4. Tab to the check/retry button and activate it with Enter or Space. Check
   visible focus, live announcements with a screen reader, and narrow mobile
   layouts for wrapping and overflow. The button is disabled while checking.

Requests time out after five seconds. Missing/invalid configuration, network
failures, HTTP errors, and invalid health JSON produce concise status messages.
Leaving the dashboard cancels the request and clears its timeout. React
StrictMode may start and cancel an extra mount check during development.
The check confirms API responsiveness only, not database or market-data health.

## Checks

```sh
npm run lint
npm test
npm run build
```

The research API helper has mocked tests using Node’s built-in test runner and
TypeScript stripping (validated on Node 22.14.0; no added test dependencies).
These tests cover validation, success, unavailable evidence, clarification, HTTP
errors, network errors, malformed responses, and cancellation. Historical evidence
also has rendered-HTML tests using the installed TypeScript compiler and React
server renderer. These assert real component output and text escaping, but do not
mount an interactive page or replace browser layout, keyboard, and screen-reader checks.
Stop each server with Control-C in its own terminal; run `deactivate` in the
backend terminal afterward.


## Stock Research Assistant

Open `/research` directly or choose **Stock research** on the dashboard. The
quote and historical example buttons fill the textarea without submitting. Only a user submission
sends `{"question":"..."}` to `/api/research/agent`, using the existing
`VITE_API_BASE_URL`. Gemini keys stay exclusively in backend configuration.
Supported research covers AAPL, MSFT, and NVDA quotes, reported daily ranges,
percentage changes, and historical price change, SMA20/SMA50, and adjacent-return
volatility. History is fictional, covering 2024–2025; questions should include
explicit start/end dates. Predictions are unsupported. This is educational research,
not financial advice.

The client validates the fields it displays and rejects malformed responses.
It renders findings as plain text and never calculates new research metrics.
HTTP 200 does not guarantee an answer: unsupported, clarification, quota,
timeout, and unavailable outcomes are shown explicitly. Available evidence,
source labels, trading dates, fetch timestamps, limitations, and symbol errors
remain visible even if the explanation is unavailable. Fictional quote metadata
always triggers a prominent demo label. Tool activity is collapsed by default.

The main heading and live announcement use the backend's **overall `status`**.
For historical-only success, `status="answered"` takes precedence over the old
quote compatibility explanation (`historical_answer_available`). That notice is
replaced with a historical success message; genuine clarification and unavailable
outcomes retain their own safe message. Quote-only and mixed results remain supported.
The current client requires the additive fields provided by the merged backend;
responses missing them fail safely instead of silently dropping historical data.

Historical findings are backend-rendered plain text with evidence-reference links
to per-stock cards. Cards display exact Decimal strings, units, actual windows and
observation counts for all four metrics. There is no conversion of metric values
to JavaScript numbers and no client calculation of metrics, comparisons or signals.
Long values can wrap inside cards. Unavailable metrics show their reason and available
observation count, never a substituted zero. Empty/partial coverage, requested and
returned ranges, source, fetch time, unknown adjustment basis, and limitations remain
visible even when final analysis fails. Quote and historical sections are distinct:
the fictional fixtures are separate datasets.

Price change excludes dividends. Volatility uses 20 returns from 21 observations,
is not annualized, and does not establish overall safety. These metrics describe
fictional observations, not actual performance or forecasts. No actual exchange
calendar or adjustment information is invented.

Tool activity counts both outcome arrays and groups them by type, with validated
historical date ranges. It does not invent a chronological ordering across arrays.
Observed tool-request counts can exceed executed outcomes when a batch is rejected.
Invalid arguments can have no validated symbols/dates. Singular/plural labels reflect
the actual counts.

Research has a 35-second browser timeout, separate from the unchanged five-second
health timeout. Submissions are blocked while pending; there is no auto-submit,
retry, mount request, or polling. Leaving the page aborts the browser request and
clears the timer. Late responses cannot replace a newer attempt. Browser
cancellation does not guarantee backend cancellation; work may still be running.
The backend CORS allowlist permits GET, POST, and Content-Type for the existing
localhost/127.0.0.1 frontend origins on port 5173, without credentials.

### Manual browser checks

1. Start the backend with research disabled and fictional data (no keys needed):
   `RESEARCH_ENABLED=false MARKET_DATA_PROVIDER=demo .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000`
   from `backend/`. Start the frontend with `npm run dev -- --port 5173 --strictPort`.
2. Open `/research`. Confirm no research request on mount. Tab through the
   navigation, labeled textarea, both example buttons, and submit; activate each example
   and confirm it only fills the field without a request. Submit once and expect the safe unavailable
   response from the disabled backend. Blank or oversized input must not send a request.
3. Check a narrow mobile viewport and desktop for wrapping, visible keyboard focus,
   and expandable tool activity. Verify loading and error announcements with a
   screen reader. Stop the backend and submit to check the network error.
4. With research still disabled, use the browser's Network response overrides for
   `POST /api/research/agent` to supply HTTP 200 mocked responses matching the submitted
   question. `tests/research.test.mjs` contains historical, mixed, unavailable, empty,
   partial and malformed fixtures. Confirm historical-only success says “Research
   findings”, with no legacy “Clarification needed” notice. Follow each `hm` evidence
   link to its card, check exact decimal strings and dates, then expand tool activity.
   Mixed results must show separate quote/historical sections. Failed analysis must
   retain evidence; empty history must show unavailable reasons; partial history must
   retain its limitations. Malformed data must show a safe error.
5. Test at 320px and desktop width, including a 634-digit metric string: no horizontal
   page overflow, clipped values or inaccessible evidence links. Tab/Enter/Space through
   example buttons, submit, evidence links and activity summary. Delay a mocked response
   to verify all submission/example controls stay disabled; navigate away and confirm
   no stale result appears. Browser automation was unavailable during implementation;
   these interaction, mobile and screen-reader checks remain manual. The rendered-HTML
   tests do not establish them.
6. For **one later user-triggered live-Gemini request**, stop the old backend and
   restart from `backend/` with your locally configured ignored `.env`:
   `RESEARCH_ENABLED=true MARKET_DATA_PROVIDER=demo .venv/bin/python -m uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8000`
   Open `/research`, select the historical example, then explicitly submit once. This calls
   Gemini with fictional historical evidence; review the outcome, cards and tool activity.
   No live request was executed for this milestone. Keep the server on loopback;
   there is no real authentication or daily spending cap.

## Fictional stock-history charts

Open `/stocks/AAPL`, `/stocks/MSFT`, or `/stocks/NVDA`, or follow a symbol link in
the dashboard's sample watchlist. Its sample prices remain separate from history.
The chart uses the existing `VITE_API_BASE_URL` and GET history endpoint, with no
API keys or model requests. Run the backend with research disabled and demo data
as described above; history itself is always fictional regardless of quote-provider
configuration.

Recharts 3.10.1 and react-is 19.3.0 were added, matching installed React 19.3.0.
The [official installation guide](https://recharts.github.io/en-US/guide/installation/)
recommends npm; the [official README](https://github.com/recharts/recharts#installation)
requires react-is to match React. Recharts' published peer dependencies support
React 19. No existing dependency versions were upgraded.

`src/lib/history.ts` centralizes the fixed fixture bounds, 2024-01-01 through
2025-12-31. A test checks the anchor against the backend contract. All date-only
values use UTC. Ranges end at **December 31, 2025**, never today:

| Range | Inclusive start | Inclusive end |
| --- | --- | --- |
| 1W | 2025-12-25 | 2025-12-31 |
| 1M (default) | 2025-12-01 | 2025-12-31 |
| 3M | 2025-10-01 | 2025-12-31 |
| 1Y | 2025-01-01 | 2025-12-31 |

1W covers seven calendar dates. Other ranges subtract one/three/twelve calendar
months, clamp to a valid day in the destination month, then add one day for the
inclusive start. These are not fixed 30/90/365-day windows. No intraday range is
offered. The numeric time axis preserves elapsed-time spacing; straight lines
connect observations without smoothing or inventing measured intermediate prices.
Empty results show a message; a single observation shows a dot. The expandable
HTML table is an alternative to the chart. Closing prices are USD, adjustment is
unknown, and backend limitations and coverage warnings remain visible.

The client validates consumed metadata, date ordering, uniqueness, bounds, and
finite positive closing prices. It rejects malformed data rather than sorting,
deduplicating, or filling gaps. Each response must match the requested symbol and
range. Symbol/range changes unmount the previous result immediately and abort its
request; cleanup also prevents obsolete completions from updating the page.
Requests time out after ten seconds. Retry is manual; there is no polling or
automatic retry loop. React StrictMode can start and cancel an extra mount request
in development.

### History browser checks

1. Start the local demo backend with research disabled. Open `/dashboard` and
   follow each symbol link; verify the prominent fictional banner and 1M default.
2. Switch symbols and all four ranges, including rapid changes under network
   throttling. Confirm the requested/returned dates, spacing, tooltips, selected
   buttons, and absence of the previous stock's chart during loading.
3. Check desktop and 320px mobile widths for clipped prices or horizontal overflow.
   Tab through navigation, selector, range buttons, chart and table summary; verify
   visible focus, keyboard chart exploration and status announcements. Expand the
   data table and compare date/close values with the tooltip.
4. Visit `/stocks/TSLA`: no history request should be sent. Stop the local backend
   to check the network error and manual retry. Use browser response mocks for
   empty/one-point/partial results, malformed data, HTTP errors and delayed requests
   exceeding ten seconds. Preserve matching requested-range metadata in mocks.
5. The fixed UI ranges lie inside coverage, so empty and partial states normally
   require mocks. Browser automation was unavailable during this milestone;
   rendering, mobile, keyboard, and screen-reader checks still require manual review.

History helper tests run with `npm test` alongside the research tests and need no
server or credentials. The production build was run with a temporary configuration
outside the repository setting `envDir: false`, so no actual `.env` files were read.
