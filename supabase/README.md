# Local watchlist schema and isolation tests

This milestone adds only a database schema and real PostgreSQL/pgTAP tests.
There are no watchlist endpoints, UI changes, or agent actions. The dashboard's
fictional sample watchlist remains separate from personal saved symbols.

## Schema and access

`public.watchlist_items` contains an owner `user_id` referencing `auth.users(id)`
with `ON DELETE CASCADE`, an exact uppercase AAPL/MSFT/NVDA `symbol`, and a
non-null `timestamptz created_at` defaulting to `now()`. Its composite primary key
`(user_id, symbol)` prevents duplicates per user while allowing different users
to save the same symbol. No sequence, profile table, or UPDATE operation is needed.

The migration explicitly enables RLS and revokes table privileges from PUBLIC,
anon, and authenticated before granting only SELECT, INSERT, and DELETE to
authenticated. It ensures authenticated has USAGE on public without revoking
unrelated schema access or changing project-wide default privileges.

Grants permit an operation; RLS restricts its rows. SELECT and DELETE use
`(select auth.uid()) = user_id`; INSERT uses the same expression as WITH CHECK.
All three policies target authenticated only. There is no UPDATE policy,
TRUNCATE grant, anonymous table access, or security-definer helper.
Exposed Data API requests can bypass FastAPI, so ownership and symbol constraints
must be enforced independently in the database. Administrative roles can bypass
RLS; they must not be used for runtime user-scoped watchlist requests.

## Local prerequisites

Validated with Supabase CLI 2.121.0, Docker client/server 29.9.2, PostgreSQL 17.11,
and the Supabase `pg_prove:3.36` test-runner image. Install the CLI and a compatible
container runtime separately and start the runtime yourself. The CLI may download
images on first use. No application dependencies or hosted credentials are required.

This directory uses project ID `marketsim-watchlist-tests`, database port 55432,
and shadow port 55430. Only `supabase db start` is needed; Auth, API, Studio,
storage, realtime, analytics, mail, and edge services are disabled. Supabase's
Postgres bootstrap supplies auth.users, auth.uid(), and database roles even without
starting the Auth HTTP service. This is not an end-to-end Auth test environment.
The CLI may publish the database port on all host interfaces; use a trusted local
machine/network and stop this test database when finished.

From the repository root, first inspect Docker containers, volumes, and listening
ports. If this project ID, its database volume, or the chosen ports already exist
with unknown work, stop and investigate; do not reset or delete them. Docker Desktop's
CLI may need `/Applications/Docker.app/Contents/Resources/bin` added to PATH:

```sh
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
docker ps -a
docker volume ls
lsof -nP -iTCP:55432 -iTCP:55430 -sTCP:LISTEN
supabase db start
supabase test db --local
```

These commands use local configuration, not application `.env` files. Never run
`supabase link`, a linked reset, or a remote database URL for these tests.

## Safe fresh migration replay

Migration files are versioned under migrations. First startup applies them to a
new local database. To prove reconstruction, the following destructive command
is allowed **only after confirming this project's database is disposable and
contains no unknown work**:

```sh
supabase db reset --local --no-seed
supabase test db --local
```

Do not reset an existing database merely to run tests. Tests themselves use one
transaction and rollback all synthetic users and watchlist records. To stop this
project without discarding its volume, run `supabase stop` from this repository;
do not use `--all` or `--no-backup`.

## What the tests establish

The SQL file runs actual PostgreSQL assertions. Privileged setup creates two
synthetic UUID-only auth users, with no passwords or tokens. Ownership and
permission checks run under SET LOCAL ROLE authenticated or anon. Both the JSON
request claims and legacy request.jwt.claim.sub are set explicitly because the
database-only bootstrap's auth.uid() reads the latter. The no-subject cases clear
both, rather than accidentally retaining a previous user.

The suite verifies owner-only visibility, independent AAPL saves, rejected forged
ownership, cross-user reads/deletes, owner deletion, missing-subject denial,
anonymous denial, duplicate/invalid/null constraints, timestamp defaults,
UPDATE/TRUNCATE denial, RLS activation, exact policy operations/roles, and grants.
Foreign-key and null-owner constraints are tested separately under setup privileges
with exact SQLSTATE checks, so an RLS rejection cannot falsely prove a constraint.
Deleting synthetic user A must cascade only A's rows and preserve B's rows.

Validation on October 22, 2026: all 36 assertions passed before and after fresh
migration replay. Early test-harness failures (pgTAP text collation, an expected
JSON literal, nested modifying CTEs, and bootstrap claim-setting differences) were
corrected without weakening or changing the migration's policies.

These tests do not verify JWT cryptography, Auth/Data API token propagation,
or the hosted project's schema/configuration. Hosted migration deployment is a
later reviewed step, after reconciling remote schema, migration history, exposed
schemas, and privileges. Nothing here links to or deploys to that project.

Official references consulted:
- [Local configuration](https://supabase.com/docs/guides/local-development/cli/config)
- [Versioned migrations](https://supabase.com/docs/guides/local-development/database-migrations)
- [PostgreSQL/pgTAP testing](https://supabase.com/docs/guides/local-development/testing/overview)
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
