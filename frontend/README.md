# MarketSim frontend

React dashboard with static demo data, an API health indicator, and a research interface.
Authentication and trading remain demos. No new dependencies are needed.

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
errors, network errors, malformed responses, and cancellation. They do not mount
React or replace browser layout, keyboard, and screen-reader checks.
Stop each server with Control-C in its own terminal; run `deactivate` in the
backend terminal afterward.


## Stock Research Assistant

Open `/research` directly or choose **Stock research** on the dashboard. The
example button fills the textarea without submitting. Only a user submission
sends `{"question":"..."}` to `/api/research/agent`, using the existing
`VITE_API_BASE_URL`. Gemini keys stay exclusively in backend configuration.
Supported research covers AAPL, MSFT, and NVDA quotes, reported daily ranges,
and percentage changes; it is educational and not financial advice.

The client validates the fields it displays and rejects malformed responses.
It renders findings as plain text and never calculates new research metrics.
HTTP 200 does not guarantee an answer: unsupported, clarification, quota,
timeout, and unavailable outcomes are shown explicitly. Available evidence,
source labels, trading dates, fetch timestamps, limitations, and symbol errors
remain visible even if the explanation is unavailable. Fictional quote metadata
always triggers a prominent demo label. Tool activity is collapsed by default.

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
   navigation, labeled textarea, example, and submit buttons; activate the example
   and confirm it only fills the field. Submit once and expect the safe unavailable
   response from the disabled backend. Blank or oversized input must not send a request.
3. Check a narrow mobile viewport and desktop for wrapping, visible keyboard focus,
   and expandable tool activity. Verify loading and error announcements with a
   screen reader. Stop the backend and submit to check the network error.
4. Use mocked browser responses to check answered, clarification, and unavailable
   responses containing evidence. Confirm fictional labels, separate dates, safe
   plain-text rendering, and preserved evidence. Delay a mocked response to check
   disabled controls; navigate away and confirm no stale result appears. Browser
   automation was unavailable during implementation; these visual checks remain manual.
5. For **one later user-triggered live-Gemini request**, stop the old backend and
   restart from `backend/` with your locally configured ignored `.env`:
   `RESEARCH_ENABLED=true MARKET_DATA_PROVIDER=demo .venv/bin/python -m uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8000`
   Open `/research`, select the example, then explicitly submit once. This calls
   Gemini with fictional quote evidence; review the outcome and tool activity.
   No live request was executed for this milestone. Keep the server on loopback;
   there is no real authentication or daily spending cap.
