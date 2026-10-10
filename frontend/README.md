# MarketSim frontend

React dashboard with static demo data and an API health connection indicator.
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
npm run build
```

No automated frontend test suite is configured. Backend HTTP/CORS smoke checks
are not a substitute for checking browser communication and UI behavior.
Stop each server with Control-C in its own terminal; run `deactivate` in the
backend terminal afterward.
