# MAREC STORE

Game marketplace for Malawi and Africa, by MAREC STUDIOS. *Play Local. Think Global.*

## Status: milestone M0 + start of M1 (backend core)

**Honest status:** this code was written and syntax-checked, but the tests have NOT been run yet.
The first real run happens in GitHub Actions on your first push. If CI is red, paste the log to
Claude and it will be fixed before anything is built on top.

What exists now:

- FastAPI service with health endpoints and a consistent error format (code, message, request ID)
- PostgreSQL schema through Alembic migrations: `users`, `user_sessions`
- Registration, login, refresh-token rotation with replay detection, logout, session list and revoke
- argon2id password hashing, short-lived access tokens, account lockout after repeated failures
- Tests (SQLite locally, PostgreSQL in CI), lint, secret scan, migration up/down check

Not built yet (on purpose): email verification (needs an email provider), IP-based rate limiting,
roles, audit log, catalog, website, launcher, payments, SDK. See the blueprint for the order.

## Layout

```
.devcontainer/devcontainer.json   Cloud dev environment (Codespaces)
.github/workflows/ci.yml          Lint, migrations, tests, secret scan
docs/DECISIONS.md                 Confirmed decisions
infra/docker-compose.yml          Local PostgreSQL + API
services/api/
  app/main.py                     App factory, middleware
  app/core/                       config, db, security, errors
  app/modules/auth/               models, schemas, service, router, deps
  app/modules/health.py           /v1/health, /v1/health/db
  alembic/                        Migrations (0001_users_sessions)
  tests/                          pytest suite
  .env.example                    Variable names, no secrets
```

## Run it (Codespaces or any machine with Docker)

```
cd infra
docker compose up --build
```

API docs: http://localhost:8000/docs (disabled when `ENVIRONMENT=production`).

Smoke test:

```
curl -s localhost:8000/v1/health

curl -s -X POST localhost:8000/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"a-long-test-password","display_name":"Me"}'

curl -s -X POST localhost:8000/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"a-long-test-password"}'
```

Copy the `access_token` from the login response, then:

```
curl -s localhost:8000/v1/me -H 'Authorization: Bearer PASTE_ACCESS_TOKEN'
```

## Run the tests (no Docker or PostgreSQL needed)

```
cd services/api
pip install -r requirements-dev.txt
pytest -q
```

To test against PostgreSQL, set `TEST_DATABASE_URL` to a database whose name contains `test`
(the tests drop and recreate all tables, so never point it at real data).

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| ENVIRONMENT | local, test, staging, production | local |
| DATABASE_URL | SQLAlchemy URL (`postgresql+psycopg://...`) | required |
| JWT_SECRET | Signs access tokens. 32+ random characters outside local/test | required |
| ACCESS_TOKEN_MINUTES | Access token lifetime | 15 |
| REFRESH_TOKEN_DAYS | Refresh token lifetime (slides on each refresh) | 30 |
| MAX_FAILED_LOGINS | Failures before lockout | 5 |
| LOCKOUT_MINUTES | Lockout length | 15 |
| CORS_ORIGINS | Comma-separated website origins | empty |

Generate a real secret: `python -c "import secrets; print(secrets.token_urlsafe(48))"`

## Database migrations

```
cd services/api
alembic upgrade head      # apply
alembic downgrade base    # roll everything back (local only)
```

Never change production tables by hand. Add a new migration file instead.

## Known limitations (to fix in later milestones)

- Registering with an existing email returns 409, which reveals that the email is registered.
  An enumeration-safe flow needs email delivery.
- Lockout is per account, so an attacker could lock out a known email. IP-based limits (Cloudflare
  and/or Redis) come next.
- No breached-password check yet. Behind a proxy, client IPs need forwarded-header handling.
- Dependency versions are ranges. Pin them with a lock file after the first green CI run.
- `.devcontainer` and `docker-compose.yml` are untested.
