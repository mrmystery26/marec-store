#!/bin/sh
# Start command for hosted deployments (see render.yaml and docs/DEPLOY_RENDER.md).
# Runs the database migrations, optionally loads the demo games, then starts the API.
set -e
alembic upgrade head
if [ "${SEED_DEMO:-false}" = "true" ]; then
  python -m app.seed
fi
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
