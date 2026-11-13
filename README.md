# MarketSim

MarketSim is a full-stack stock analysis and paper-trading application. Users will be able to view stock information, analyze market trends, maintain a watchlist, and practice buying and selling stocks with virtual money.

## Planned Features

- User registration, login, and logout
- Stock search
- Current price, daily high, daily low, and price change
- Historical stock charts
- Personal watchlist
- Top gainers and losers
- Paper-trading simulator
- Portfolio profit and loss tracking
- Transaction history
- Custom stock alerts
- Explainable bullish, bearish, and neutral trend signals
- Currency conversion

## Technology Stack

### Frontend

- React
- TypeScript
- Vite
- Tailwind CSS
- Recharts

### Backend

- Python
- FastAPI

### Database and Services

- PostgreSQL
- Supabase
- Twelve Data market API

## Project Status

The project is currently in the setup and planning stage.

## Disclaimer

MarketSim is an educational project. Its market signals are not financial advice.
## Continuous integration

`.github/workflows/ci.yml` runs separate **Backend checks** and **Frontend checks**
on pull requests and pushes to `main`. Obsolete runs for the same PR are cancelled.
Permissions are limited to `contents: read`; checkout does not persist credentials.
No secrets, deployments, Supabase services, Docker or database access are required.

Backend uses Python 3.13 (the existing validation family), installs both existing
requirements files, then runs Ruff, all standard-library unittest tests and
`pip check`. Demo quotes are selected and research, real history and real research
are explicitly disabled outside isolated mocked tests; service credentials are
blank. Existing test transport mocks/network guards remain in use.

Frontend uses supported Node 22 (Vite 8.3.0 requires `^20.19.0 || >=22.12.0`),
`npm ci`, the complete frontend tests, lint and production build. The build writes
a temporary Vite config with `envDir: false` and uses a clean environment with
real-data flags disabled; it never loads local environment files. Build failures
are fatal. The existing non-failing bundle-size warning remains visible.
Download caches are keyed by the requirements files and npm lockfile.

For local equivalents, use the existing backend virtual environment from
`backend/` to run `python -m ruff check app tests`,
`python -m unittest discover -s tests -v`, and `python -m pip check`, with the same
explicit safe environment settings shown in the workflow. From `frontend/`, run
`npm test`, `npm run lint`, and the workflow's environment-isolated build block
(or the equivalent documented in `frontend/README.md`). Do not use an ordinary
Vite build when local environment files must stay unread.

Official action commits were verified against their repository tags on
November 12, 2026: [checkout v6.1.0](https://github.com/actions/checkout/releases/tag/v6.1.0),
[setup-python v6.3.0](https://github.com/actions/setup-python/releases/tag/v6.3.0),
and [setup-node v6.5.0](https://github.com/actions/setup-node/releases/tag/v6.5.0).
The workflow pins their full commit hashes. Node support is listed in the
[official release schedule](https://nodejs.org/en/about/previous-releases).

These checks establish mocked contract behavior, lint/build success and installed
Python dependency consistency. They do not verify live provider availability,
credentials, hosted Supabase configuration, or public-display permission. These
jobs do not run the PostgreSQL/pgTAP isolation suite. Frontend tests include
helpers, controllers and static rendering, not full browser automation; existing
manual browser checks do not replace browser automation. Branch protection and
required-check selection are separate GitHub settings and are not changed here.
A locally passing run is not proof of a successful hosted GitHub Actions run.
