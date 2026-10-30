# MarketSim frontend

React dashboard with static demo data, an API health indicator, a research interface,
and fictional stock-history charts. Authentication uses Supabase when configured; portfolio data and trading remain demos.

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
`.env.local` is ignored; `.env.example` contains a public local API URL and blank
optional public authentication settings.

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

## Authentication session foundation

The root `AuthProvider` supplies `useAuth()` with `loading`, `signed_out`,
`signed_in` (session and user), or `unavailable`. This is UI state only, not backend
authorization. Login/signup forms now call Supabase, with confirmation handling and
a dashboard sign-out control. Demo routes and API clients remain public: no
backend verification is implemented; `/account` now has frontend route protection. No auth error banner is added
to demo pages.

Optional public configuration names are `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY`. Use the project's HTTPS root URL and current
`sb_publishable_...` key. The example leaves both blank. Missing/invalid values,
inaccessible browser storage, or client creation errors produce unavailable state.
Invalid configuration never creates an SDK client. Syntax checks cannot establish
whether a project/key exists or is accepted by Supabase. Never put secret/service-role
keys, database passwords, JWT signing secrets, or provider credentials in React.

One lazy client uses native `window.sessionStorage`, SDK persistence and automatic
refresh. No custom storage or refresh loop is implemented. Sessions survive reloads
within the tab's browser session; tab duplication/browser session restoration can
copy or restore this storage. Closing a tab is not server-side logout. Storage is
accessible to same-origin JavaScript and is not protection against XSS. Remember me
is unavailable and its checkbox has been removed. Automatic URL session detection
remains disabled; only the dedicated callback handles confirmation tokens.

The provider subscribes before `getSession()`. Callbacks synchronously publish state
without additional auth calls. New auth events supersede pending initialization,
including errors. Late INITIAL_SESSION events cannot overwrite completed initialization
or newer events. Cleanup unsubscribes and ignores late results/callbacks; Strict Mode
effect remounts reuse the client with a fresh observer. Raw errors are never exposed
or logged. The separate context/hook module keeps component exports separate.

Supabase JS 2.118.0 requires Node >=22 and has no React peer dependency. Installation
was checked against Node 22.14.0 and React 19.3.0 without upgrading existing packages.
Official documentation consulted October 20, 2026:
[initialization](https://supabase.com/docs/reference/javascript/initializing),
[session retrieval](https://supabase.com/docs/reference/javascript/auth-getsession),
[subscriptions and cleanup](https://supabase.com/docs/reference/javascript/auth-onauthstatechange),
and [runtime support](https://github.com/supabase/supabase-js#support-policy).

Auth tests use mocked clients/storage and the same observer invoked by the React
effect. They cover initialization, events, cleanup/remount races, and redacted failures
without real keys or network calls. They do not replace mounted browser tests.
Later manual checks should confirm unchanged demo pages without configuration,
browser session-storage behavior, and restoration/refresh with the connected forms.

To validate without loading actual `.env` files, run `npm test` and `npm run lint`.
For the build, use the existing temporary-config approach from `frontend/`:

```sh
set -e
validation_dir=$(mktemp -d /tmp/marketsim-vite.XXXXXX)
validation_config="$validation_dir/vite.config.mjs"
cat > "$validation_config" <<'CONFIG'
import config from '/Users/irvin/Documents/MarketSim/frontend/vite.config.ts'
export default { ...config, envDir: false }
CONFIG
env -i PATH="$PATH" HOME="$HOME" npm run build -- --config "$validation_config"
```

Use a clean validation shell without exported application credentials: `envDir: false`
disables environment-file loading, but Vite still sees exported shell variables.


## Login, signup, confirmation and local sign-out

Forms reuse the single client and call `signInWithPassword` or `signUp`. Existing
name, email, password, confirmation, educational acknowledgment, and visibility
controls remain. Submission disables fields and uses a synchronous request gate;
password fields clear immediately after starting a valid submission. Unmounted
pages ignore late results. Raw provider errors never enter UI messages or logs.
Successful password login navigates to `/dashboard` with history replacement.
Signup/callback success retains its fixed dashboard link; no external redirect
or query-supplied destination is used. No-session signup results use a
neutral check-email message, including obfuscated existing-user responses. They
do not establish that an account was created. `full_name` is sent as user metadata:
it is user-editable display data, never authorization. There is no profile table.

The client explicitly retains the browser implicit flow. The trusted public
`VITE_AUTH_CALLBACK_URL` must be an absolute same-origin `/auth/callback` URL,
without credentials, query or fragment. HTTPS is required except for loopback
localhost/127.0.0.1/IPv6 development. Missing/invalid callback configuration blocks
signup, while configured password login still works. The callback removes the
query and fragment from browser history before processing; it accepts only signup
bearer-token fragments and calls SDK `setSession` once per page mount, sharing the
promise during Strict Mode effect replay. Automatic URL detection stays disabled,
so the SDK cannot process the same tokens twice. PKCE codes, recovery callbacks,
missing/duplicate token fields, provider errors, and query redirects fail safely.
The SDK validates/restores the session and publishes auth events to the provider.
Reloading a consumed callback shows a safe failure; use the login link to continue.
Tokens are never placed in UI messages or custom storage. Implicit callback tokens
exist briefly in the browser fragment; keep this page free of third-party scripts.

Signed-in dashboard visitors can sign out with `signOut({ scope: 'local' })`.
Success navigates to `/login` with history replacement and router state carrying
a fixed “Signed out successfully.” status announcement. A new login attempt clears
both the announcement and its router state, even if form validation fails.
Sign-out failures stay on the dashboard with a safe retryable error.
Signed-out demo visitors retain navigation.
Existing access tokens can remain valid until expiry, even after local sign-out.
Dashboard balances remain fictional and are not a user's personal portfolio.
Password recovery is explicitly unavailable. The educational acknowledgment is
not presented as a legal terms or privacy policy.

### Supabase dashboard setup for a later manual test

1. Use a hosted project with Email provider/signup enabled. Enable Confirm email
   to test the confirmation path. No service-role or signing secret is needed.
2. Under Authentication → URL Configuration, set Site URL to
   `http://localhost:5173` and add the exact redirect
   `http://localhost:5173/auth/callback`. Use this origin consistently. If using
   `127.0.0.1`, use its corresponding Site URL, allowlist entry and frontend setting;
   the callback setting must match the browser origin.
3. Keep the standard confirmation email link using `{{ .ConfirmationURL }}`.
   Custom token-hash/PKCE/recovery templates are not this callback's contract.
4. Default SMTP is restricted to organization-team addresses and currently two
   emails/hour; configure custom SMTP for other recipients. Do not share SMTP
   passwords or other secret values. Email delivery/account configuration are not
   verified by mocked tests.
5. Locally configure the public project URL and publishable key plus
   `VITE_AUTH_CALLBACK_URL=http://localhost:5173/auth/callback`, then restart Vite.
   The tracked example intentionally contains blank placeholders. Never paste
   passwords, session tokens or secret keys into chat or frontend configuration.

Manual checks: pending signup/email delivery, confirmation success and expired
links, incorrect-password errors, login and session restoration after reload,
local sign-out success/failure, duplicate-click/loading behavior, keyboard focus,
password visibility and mobile layout. Check unconfigured forms and anonymous
demo access too. Auto-confirm projects can return a signup session directly; that
branch is mocked without changing hosted project settings. No live requests were
made during implementation.

Official references consulted for this integration:
[signup](https://supabase.com/docs/reference/javascript/auth-signup),
[password login](https://supabase.com/docs/reference/javascript/auth-signinwithpassword),
[implicit flow](https://supabase.com/docs/guides/auth/sessions/implicit-flow),
[setSession](https://supabase.com/docs/reference/javascript/auth-setsession),
[redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls),
[sign-out](https://supabase.com/docs/guides/auth/signout), and
[SMTP restrictions](https://supabase.com/docs/guides/auth/auth-smtp).
Installed SDK 2.118.0 was inspected; no dependency changes were needed.

`auth-forms.test.mjs` covers mocked SDK outcomes, trusted redirect validation,
callback cleanup/deduplication, local sign-out and duplicate submission gating.
It also renders actual form/dashboard components to static HTML, checking visible
controls and demo wording. These are helper and server-rendered HTML tests, not
mounted browser interaction tests; manual checks above remain necessary.


Authentication feedback separates generic login rejection from connection/service
failures and missing configuration. It never echoes provider messages or reveals
whether an account exists. Expired/used confirmation-link wording appears only
on the callback page. Signup pending behavior and sessionStorage are unchanged.
The navigation regressions execute actual component handlers with mocked React
hooks/router/SDK responses; they are handler-level interaction tests, not mounted
React DOM/browser tests. Helper and static HTML checks remain separate. Manually
verify replacement navigation/Back behavior, screen-reader sign-out feedback,
notice clearing on a new attempt, and staying on the dashboard after failed logout.


## Protected account page

`/account` is the first frontend-only protected route. `RequireAuth` uses the
existing provider: loading renders a polite status without redirecting or mounting
account content; signed-out state replaces the route with `/login`; unavailable
state renders safe login/demo links without a redirect loop. Signed-in state renders
the account page. Every auth state change re-evaluates the guard, withholding the
account page on session loss or sign-out. It never caches a previous user's details.

The page displays the email as escaped React text, never tokens or session objects.
Saved research and portfolios are not connected; personal saved symbols are now available at `/watchlist`. It links
back to the public demo dashboard, which shows an Account link only when signed in.
The existing dashboard, research and stock-history routes remain public and fictional
labels are unchanged. Existing dashboard sign-out and its login success notice remain.

A guard redirect preserves exactly `/account` or `/watchlist` in router state `returnTo`. Successful password
login returns there with replacement only for those exact strings; missing, external,
encoded, query/fragment-bearing or other destinations fall back to `/dashboard`.
Ordinary login still goes to `/dashboard`. Signup/confirmation behavior is unchanged.

This guard is UI behavior, not backend authorization. Browser sessions can be
modified, and public APIs remain directly callable. Future private endpoints must
independently verify tokens and enforce ownership. No database or profile records,
new dependencies, backend changes, or persistence changes are included.

Validation uses mocked SDK/auth state and the existing environment-isolated build.
Account tests statically render actual components and check redirect intent, loading,
unavailable state, escaped email, and subsequent renders after session loss. Login
return tests execute component handlers with mocked hooks/router. These are not
mounted React DOM/browser tests. Manually check direct signed-out `/account` access,
login return and Back behavior, refresh while session initialization is pending,
unavailable configuration, session loss, email wrapping, keyboard focus, and continued
anonymous access to `/dashboard`, `/research`, and `/stocks/AAPL`.

## Explicit backend identity check

On `/account`, **Verify backend identity** performs one GET `/api/me`. Nothing
runs on mount and there is no polling or automatic retry. The helper reuses
`VITE_API_BASE_URL` and its path-prefix convention, requiring HTTPS except exact
localhost, 127.0.0.1, or IPv6 loopback hosts. It obtains the current session from
the existing SDK client; SDK refresh and sessionStorage behavior are unchanged.
Only the access token is sent in Authorization, with cookies omitted, caching
disabled, and redirects rejected. Never place a token in a URL.

A ten-second overall timeout bounds session acquisition, fetch, and body reading.
SDK session acquisition cannot itself be cancelled, but its late result cannot
start a fetch after cancellation/timeout. Checks are cancelled on unmount, sign-out,
or account replacement. The keyed per-user check clears old verification immediately.
A synchronous gate prevents duplicate submissions. Success requires a valid UUID
matching both the requested session user and the backend result; the UUID is not
shown. Success is a completed check, not permanent authorization. Each future
private request must authenticate independently.

Feedback distinguishes 401/login required, 503/service unavailable, configuration,
network/redirect failure, timeout, malformed data, and identity mismatch. Failures
do not sign the user out. Retry is explicit. Existing demo access stays public.

Manual verification (not performed automatically):
1. Keep the existing frontend Supabase URL, publishable key and callback URL for
   the same project. Set `VITE_API_BASE_URL=http://127.0.0.1:8000` locally.
2. In backend local configuration set `SUPABASE_URL=https://<project-ref>.supabase.co`
   and `SUPABASE_PUBLISHABLE_KEY` to that project's publishable key, never a secret
   or service-role key. Stop an old backend before restarting. From `backend/`,
   if using your local `.env`, run:
   `MARKET_DATA_PROVIDER=demo RESEARCH_ENABLED=false .venv/bin/python -m uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8000`
3. From `frontend/`, run `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort`.
   Restart Vite after configuration changes. Log in through the existing form,
   visit `/account`, and click Verify backend identity. No copying of tokens is
   needed. Expect accessible progress followed by Backend identity verified.
4. Check keyboard operation, explicit retry after stopping/restarting the backend,
   and removal of feedback after sign-out or switching accounts. Confirm public
   demos still work. Do not share network headers, tokens, or session storage.

Tests mock session access and fetch, exercise the actual helper and cancellation/
submission controller, and statically render the account page. They are not mounted
browser tests. Real Supabase verification, CORS, and browser interactions still
require the manual check. Use the environment-isolated build procedure above.


## Personal watchlist

`/watchlist` is protected by the existing session guard and linked as **My watchlist**
from Account and the signed-in dashboard. The dashboard's fictional sample watchlist
is unchanged. Saved symbols are not holdings or recommendations. Stock links open
the existing fictional historical charts. Creation dates display in UTC.

Use the existing frontend Supabase public configuration and `VITE_API_BASE_URL`;
no new settings or keys are needed. The backend must use the same personal Supabase
project and its publishable key, with the reviewed watchlist migration deployed,
Data API enabled and public exposed. Never use administrative credentials in React.
The backend remains responsible for identity verification and database RLS for ownership.

The page loads once per authenticated mount and supports explicit Refresh/retry,
Add AAPL/MSFT/NVDA, and Remove. Each operation obtains a current SDK session and sends
only its access token in Authorization, never a user_id or a token in a URL/body.
The helper reuses the identity helper's trusted backend URL validation: HTTPS except
explicit loopback development hosts. Requests omit cookies, reject redirects, and
use no-store. A 12-second total deadline includes session lookup, fetch and body reading,
slightly longer than the backend's ten-second deadline. DELETE 204 is not parsed as JSON.
Responses validate supported symbols, unique list entries, and timezone-aware timestamps.

One synchronous gate serializes reads and writes; no polling or automatic write retries
are used. Confirmed mutations update the list. POST 409 says already saved and requests
an explicit refresh. A timed-out or otherwise uncertain write may have completed;
further mutations remain blocked until Refresh succeeds. Refresh failures preserve that
warning. Authentication, permission, configuration, malformed-response, network and service
failures have safe feedback; they never trigger automatic global sign-out.

Per-user keyed content and cleanup remove old rows on identity changes. Synchronous SDK
subscriptions cancel pending work on sign-out/account changes, preventing a delayed session
lookup from sending an old token. Cleanup aborts work and unsubscribes; Strict Mode effect
replay creates a fresh controller. Requests already sent before cancellation cannot be
undone; the next mount reloads server state. SessionStorage and SDK refresh remain unchanged.

Tests use mocked session/fetch calls, controller lifecycle tests, actual static React HTML,
and existing login handler tests with mocked hooks/router. They do not mount a browser DOM
or prove live Data API integration. Run `npm test`, `npm run lint`, and the fail-fast,
environment-isolated production build documented above. No live requests are part of tests.

### Manual personal-watchlist checks (not run automatically)

1. Use the existing local frontend configuration for personal project
   `qptlizibcvoswotrdhrh` and `VITE_API_BASE_URL=http://127.0.0.1:8000`. Keep the backend
   configured for that same project using its publishable key. Stop any old backend;
   from `backend/`, start it with
   `MARKET_DATA_PROVIDER=demo RESEARCH_ENABLED=false .venv/bin/python -m uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8000`.
   From `frontend/`, run `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort`.
   These are manual commands only; automated validation never loads environment files.
2. Signed out, visit `http://127.0.0.1:5173/watchlist`. Log in through the existing form;
   confirm return to `/watchlist` and replacement navigation. Normal login still opens
   `/dashboard`; `/account` return and public demo routes still work.
3. With an existing test account, confirm empty state if nothing is saved. Add AAPL,
   Refresh and reload to confirm persistence. Add AAPL again for friendly duplicate
   feedback, Refresh, remove it, and reload to confirm removal persists. Follow a stock
   link and verify that the chart is clearly fictional.
4. Using two existing test accounts, verify separate saved items; each can independently
   save AAPL. Sign out through the dashboard between accounts. Confirm previous account
   rows never flash on the new account, including with network throttling and a pending
   request. Do not copy tokens or headers into chat, shell commands, or logs.
5. Stop the backend and test safe failure and explicit retry after restarting. For an
   uncertain mutation, confirm the warning and that changes stay disabled until a
   successful Refresh. A lost response can leave a completed write: inspect the refreshed
   list before repeating it. Use browser mocks/throttling to exercise this reliably.
6. Check Tab/Enter operation, visible focus, loading and error announcements, per-symbol
   Remove labels, and a narrow mobile layout. Verify Account/My watchlist navigation and
   that the dashboard sample list remains fictional and separate.

## Quotes on the personal watchlist

Each saved symbol mounts its own quote panel after membership loads. A confirmed Add
mounts the new symbol's panel; unrelated renders and changes to other symbols keep
existing panels mounted without refetching. **Refresh saved symbols** reloads membership
only. Use **Refresh quote** (or **Retry quote**) on an individual item to request its
quote again. There is no polling, automatic retry, or persistent frontend quote cache.
Leaving the page or switching accounts discards the component's displayed quotes.

Quotes come only from the public backend `GET /api/stocks/{symbol}/quote`, using the
existing `VITE_API_BASE_URL` and trusted HTTPS/explicit-loopback URL validation.
Quote requests contain no user token, cookies, or provider key, reject redirects,
and use no-store. A twelve-second total deadline includes response-body reading.
Each panel permits only one active request; removal, unmount, or account replacement
aborts it and ignores late completion. Strict Mode cleanup/replay cancels the first
request and creates a fresh controller. Already-sent public requests may still finish
on the backend, which shares in-flight provider work between callers.

The full quote contract is checked: matching supported symbol, USD currency, finite
numbers, positive ordered low/price/high, integer nonnegative volume, real dates,
timezone-aware fetch time, boolean cache flag, and recognized provenance pairs.
Volumes beyond JavaScript's safe integer range are rejected rather than rounded.
`change_percent=2.5` displays as `+2.5%`, not 250%; changes carry explicit signs and
zero remains zero. Error/missing values are never replaced with zero or demo data.

Demo responses prominently say **Fictional demo quote**. Provider responses say
**Provider quote — end-of-day data**, not live or real-time. The trading date and
backend fetch timestamp are separately labeled: fetch time does not establish market
freshness. Standalone demo quotes and fictional historical chart fixtures are separate
and need not reconcile. Saved symbols are not holdings or trading recommendations.

The existing backend caches successful quotes for six hours per process and shares
concurrent requests for a symbol. Its live-provider attempt budget is twenty per rolling
24 hours per process; failed attempts count. Refresh can therefore return a cached
quote with its original fetch timestamp. The UI displays the backend cache-hit flag
and does not bypass that cache or change provider behavior.

Quote failures, including rate limits, affect only the corresponding panel. Membership,
Remove, and other symbols' successful quotes remain usable. Refresh clears old quote
values before requesting again; a refresh failure shows a safe error and explicit Retry,
not previously fetched numbers. Saved-symbol persistence, authentication, uncertain-write
recovery, historical links, and the dashboard's fictional sample watchlist are unchanged.

### Manual quote checks

1. Use the existing personal-watchlist setup above, restarting the backend with
   `MARKET_DATA_PROVIDER=demo RESEARCH_ENABLED=false` while retaining its existing
   Supabase configuration. Start the frontend as documented and log in normally;
   no copying tokens is necessary. Save AAPL, MSFT, and NVDA on `/watchlist`.
2. Confirm all three show fictional labels, reported USD prices and signed daily
   amount/percentage changes, a trading date, source, and a separately labeled backend
   fetch timestamp. AAPL's fixture change is +2.5%, MSFT's is -1%, and NVDA's is +10%.
3. Refresh one quote; cached data is allowed and may retain its fetch timestamp.
   Refresh saved symbols and confirm unchanged symbols do not refetch quotes. Add/remove
   symbols, reload the page, and switch between existing accounts; verify saved membership
   and that previous account panels disappear. Chart links must retain fictional-history
   labels. Under throttling, remove a pending item or sign out and check for stale flashes.
4. For a real local outage check, stop the backend after membership loads, refresh a quote,
   and verify safe error/retry. Restart and retry. Removal cannot succeed during a backend
   outage, but a quote failure must not itself disable the Remove control.
5. Separately use browser request mocks to fail only one quote (429, 502/503, malformed
   response, or a stalled body). Verify other panels still display, saved membership stays,
   and Remove remains enabled unless a membership operation itself is busy or uncertain.
   These partial-failure scenarios are mocked, not live-provider verification.
6. Check keyboard access, visible focus, status/error announcements, per-symbol refresh
   labels, and 320px layout. No provider request is needed to verify the demo presentation.

Automated quote tests use mocked fetches, parser/controller tests, static React HTML,
and a mocked-hook effect harness for cleanup/replay and unchanged-symbol renders.
Watchlist static tests inject a quote error while asserting membership and Remove remain.
These are not mounted browser interaction tests and do not establish live-provider
freshness or browser accessibility. Use the existing fail-fast environment-isolated
build procedure; actual environment files are not loaded during automated validation.

## Confirmed save from research

Research results now offer one **Save an analyzed stock** panel below the evidence.
Choices come only from the validated quote evidence's symbol and historical evidence's
provenance symbol, deduplicated in AAPL/MSFT/NVDA order. Questions, model prose, errors,
and tool arguments never supply choices. Valid evidence remains eligible even when
explanation generation failed or historical observations/metrics were unavailable;
the panel retains fictional, empty-history, partial-coverage and unavailable-analysis
notices. Saving a symbol is not a trade, recommendation, or claim of complete analysis.

Select a symbol, choose **Review save**, then explicitly choose **Confirm add**.
Result arrival, selection, Review and Cancel cause no write and no membership fetch.
Cancel restores focus to Review. Confirmation focuses its heading; completion/error
feedback is announced. Saving disables duplicate confirmation and selection changes.
Only a validated 201 response announces saved; 409 reports already saved. My watchlist
links to the existing personal list. Research evidence remains visible after save failures.

The action is bound to the current research generation, result object, selected symbol,
and internal account identity. Every new research submission increments the generation,
including repeated identical questions and invalid submissions. New results, account
changes, sign-out and unmount invalidate confirmation, abort pending requests, and ignore
late responses. Synchronous SDK auth callbacks invalidate without additional auth calls;
Confirm rechecks its binding and reuses requestWatchlist's independent SDK session check.
The existing helper's safe URL validation, twelve-second total deadline, per-request Bearer
header and response validation are unchanged. Tokens/account details never go to Gemini,
URLs, logs or custom storage. There is no model write tool or changed agent loop.

Signed-out visitors see a login link with no saved/resumed action. Loading/unavailable auth
states cannot save; public research stays usable. Login still uses the existing navigation
rules and does not automatically return to or execute a research action.

Definite failures require another Review and Confirm. Uncertain writes (including a sent
request timing out or returning an unverifiable result) block that symbol's action for the
current result/account. Open My watchlist and **Refresh saved symbols** to check whether it
completed before deciding to retry there. Changing selection away and back does not clear
the block. There are no automatic retries or automatic global sign-outs. A new research
result or a remount starts a fresh UI context, not proof that an earlier write failed.
After Confirm, browser cancellation/navigation is not rollback: the server may have completed
the save. No obsolete success is displayed in another account or research result.

### Manual confirmation checks

Use the existing personal project/frontend/backend setup documented above, with demo market
data and the already configured research service. These checks are manual, not executed by
the test suite; research submission may call Gemini.

1. Signed out, collect research and verify the login message. Log in normally: no save
   should resume. Check authentication loading/unavailable states with browser mocks while
   research remains public. Return to research and submit again if needed.
2. Collect quote-only, historical-only and mixed evidence, including overlapping symbols.
   Verify choices come from evidence and appear once each. Check fictional labels and
   unavailable/empty/partial-history notices; do not treat missing metrics as analysis.
3. Select a symbol, Review, then Cancel. Verify no POST in browser request counts (do not
   copy headers/tokens). Review again and Confirm; verify one POST and saved feedback,
   then visit My watchlist and refresh. Repeat for friendly already-saved feedback.
4. Open a confirmation and change selection or submit another research question, including
   the identical question. Verify the old confirmation cannot submit. With two existing
   accounts, check sign-out/account switching and that confirmation never transfers.
5. Use mocked delayed session/fetch responses for account changes, new results and unmount
   during a pending save. Confirm late completion cannot announce success for another
   context. A real submitted write may still finish; inspect My watchlist before retrying.
6. Use browser response mocks for 401/403, 503, malformed 201 and timeout. Research evidence
   must remain visible. Definite failures require re-review; uncertain writes show no success,
   block immediate retry for that symbol, and direct to My watchlist. These mocked scenarios
   are separate from real persistence checks.
7. Check Tab/Enter navigation, confirmation heading focus, Cancel focus restoration, status
   announcements and narrow mobile layout. New research/account changes must not pull focus
   back into a removed confirmation.

Tests cover eligibility/controller behavior, mocked real request helpers, static HTML,
component handlers with mocked hooks, and ResearchPage submission generation wiring. They
are not mounted browser interaction tests, do not establish live database isolation, and do
not replace the manual accessibility/persistence checks. Run frontend tests/lint and the
existing fail-fast environment-isolated build; backend/database contracts are unchanged.


## Private end-of-day quote readiness

Use the [backend's free, private manual quote procedure](../backend/README.md#private-free-end-of-day-quote-check)
for the first Alpha Vantage check. Keep `RESEARCH_ENABLED=false`, use one backend
worker, and do not open quote panels during its bounded curl sequence. No paid plan,
billing setup, subscription, or frontend provider key is needed or permitted for this
milestone. Automated tests use mocks; live-provider compatibility remains unverified.

The research parser now requires coherent `demo/fictional` or
`alpha_vantage/end_of_day` provenance, matching fictional flags and bundle data mode,
and preserves the backend cache-hit flag alongside source and both dates. This does
not add a live badge or a freshness guarantee. Existing watchlist quote panels distinguish
provider EOD data from fictional quotes and display the trading date, original backend
fetch time and cache status. Refresh may return the six-hour cached quote; recent retrieval
does not make an old trading date current. Do not infer market-calendar completeness.

Backend quote mode does not change the fictional historical charts, historical research
fixtures, or sample dashboard portfolio. Keep public demos in fictional mode until public
display rights are resolved. Do not send real provider evidence to Gemini during the first
quote check; real-evidence agent verification is a separate, later authorization.

## Opt-in real-history chart (private local development)

The `/stocks/:symbol` page still starts with **fictional demo history**, even when
provider history is enabled. The existing 1W/1M/3M/1Y demo controls and fixed fixtures
remain available. Only literal `VITE_REAL_HISTORY_ENABLED=true` shows the extra
mode controls; the example defaults to false. Choosing **Provider history (private
local)** does not fetch. Choose AAPL, MSFT or NVDA, enter dates, then explicitly
press **Load provider history**. Provider mode has no 1Y/full-history preset.

The initial provider range is calculated locally from UTC calendar dates: the
previous 30 dates ending yesterday (on October 30, 2026: September 30–October 29).
This requires no network and does not guarantee snapshot availability or market
session completion. Dates must be exact YYYY-MM-DD, ordered, at most 90 calendar
dates inclusive (January 1–March 31, 2026 is 90; April 1 would exceed the limit).
Changing provider dates or stock clears obsolete results and requires another Load.
Changing mode/unmount cancels pending work and discards late results. Returning to
provider mode starts a fresh form. Duplicate submissions are blocked synchronously.

The provider request uses the same `VITE_API_BASE_URL`, with
`GET /api/stocks/{symbol}/history/provider?start_date=...&end_date=...`. It requires
separate backend `REAL_HISTORY_ENABLED=true` and the backend-only Alpha Vantage key.
No Supabase token, cookies or provider key is sent by this frontend helper. It uses
`credentials: omit`, `cache: no-store`, rejects redirects, and shares the existing
ten-second timeout/cancellation mechanism. No polling, prefetch or automatic retry
is added. A range error shows validated available snapshot bounds; provider error
text is never displayed. Missing/disabled configuration, quota, timeout, network,
and malformed responses produce safe feedback with an explicit Load action.

Provider responses have a separate typed validator. It checks matching symbol and
requested range, alpha_vantage/end_of_day/unadjusted provenance, actual/available
bounds, ordered unique valid dates, finite positive consistent OHLC, nullable
nonnegative integer volume, status/coverage, timezone, retrieval time and cache flag.
Unsafe-integer volumes are rejected rather than rounded. No malformed observations
are repaired or missing dates filled; fictional metadata is rejected on real results.
Unknown timezone remains explicit. A browser unable to recognize supplied timezone
metadata rejects that response rather than inventing a timezone.

The chart and accessible expandable table use UTC date-only observations, with
mode-specific captions. Provider results show Alpha Vantage end-of-day source,
raw/unadjusted limitations, requested/available/returned ranges, count, retrieval
(not freshness) timestamp, cache status, timezone and backend limitations. Empty
results show a message; a single observation remains a visible chart point/table row.
Splits and dividends are not handled. These are descriptive prices, not predictions
or recommendations. Real history remains excluded from metrics and Gemini research.

**Neither flag is authentication or public-display permission.** Keep public demos
fictional with both flags disabled. This opt-in is for private local testing only;
keep the backend bound to `127.0.0.1`, use one worker, and do not expose it through a
tunnel. Provider display, cache-retention and external-LLM rights remain unresolved.
The existing shared process-local quote/history budget and cache are unchanged.

### Later manual browser check

No live check was run during this frontend milestone. After opting in locally:

1. Start the backend using its documented silent-key-prompt procedure, with
   `REAL_HISTORY_ENABLED=true`, `MARKET_DATA_PROVIDER=demo`, `RESEARCH_ENABLED=false`,
   one worker and `--host 127.0.0.1`. Keep the key only in backend configuration.
2. In a local frontend dev process, set `VITE_REAL_HISTORY_ENABLED=true` and
   `VITE_API_BASE_URL=http://127.0.0.1:8000`; restart Vite after changing configuration.
   The existing environment-isolated Vite config procedure above can also be used
   for dev (`npm run dev -- --config "$validation_config" --host 127.0.0.1`), passing
   those two public variables explicitly in the otherwise clean environment.
3. Open `/stocks/AAPL`. Confirm demo is still selected. In browser Network tools,
   select provider mode and edit dates: there must be no `/history/provider` call.
4. Use an explicit supported recent range, for example October 1–23, 2026, then
   click Load once. That window moves out of the compact snapshot over time. Stop
   on quota/provider errors; review available bounds on a range error before retrying.
5. Verify source/adjustment/range/count labels, expand the table and compare tooltip
   date/close values. If successful, a deliberate repeat may verify cached data and
   unchanged retrieval time. Never assume retrieval time means fresh market data.
6. Check keyboard focus, loading/disabled feedback, status announcements and a 320px
   viewport. Return to demo and confirm its fictional labels/ranges remain intact.
   Disable the frontend flag and confirm provider controls disappear.
7. Use browser mocks for delayed responses, mode/input changes during loading,
   disabled backend, quota, malformed/range errors, empty/single observations and
   stale completions. These failure scenarios need not spend real provider quota.

Tests use self-authored fixtures and mocked fetch. They cover helpers, the controller
used by form handlers, actual component handlers with mocked hooks, and static
chart/table renders with mocked Recharts. These are not mounted browser tests and
do not establish live prices, browser accessibility or provider permissions.
Validation uses `npm test`, `npm run lint`, and the fail-fast environment-isolated
production build documented above. No backend/database files or dependencies change.
