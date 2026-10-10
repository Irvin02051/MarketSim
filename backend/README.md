# MarketSim API

Minimal FastAPI backend with one application endpoint: `GET /health`.
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
.venv/bin/python -m ruff check app
.venv/bin/python -m compileall -q app
.venv/bin/python -m pip check
```

There is no automated backend test suite yet. HTTP smoke checks against a
running Uvicorn server verify basic routing and responses, not a full test suite.
Virtual environments, bytecode, Ruff caches, and `.env`/`.env.*` files are ignored.
A future `.env.example` may be tracked with placeholders only.

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
