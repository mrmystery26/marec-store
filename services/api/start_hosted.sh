#!/bin/sh
# Start command for hosted deployments (see render.yaml and docs/DEPLOY_RENDER.md).
# Runs the database migrations, makes sure the store's categories exist, removes the made-up
# placeholder games that older versions loaded (it does nothing when there are none), then
# starts the API.
set -e
alembic upgrade head
python -m app.seed
python -m app.seed --remove-placeholders
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
