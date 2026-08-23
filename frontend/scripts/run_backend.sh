#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="${HP_REMOTE_UI_ENV:-$ROOT/deploy/server.env}"
LOCAL_ENV="$ROOT/.env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE"
  echo "Copy deploy/server.env.example to deploy/server.env and fill in values first."
  exit 1
fi

set -a
. "$ENV_FILE"
if [ -f "$LOCAL_ENV" ]; then
  . "$LOCAL_ENV"
fi
set +a

cd "$ROOT"
export PYTHONPATH="$ROOT/.venv/deps${PYTHONPATH:+:$PYTHONPATH}"
PYTHON_BIN="${PYTHON_BIN:-$ROOT/.venv/bin/python3}"
if [ ! -x "$PYTHON_BIN" ]; then
  PYTHON_BIN=python3
fi
echo "Backend-only entrypoint. For the public React UI stack use: scripts/restart_dev.sh"
exec "$PYTHON_BIN" app.py
