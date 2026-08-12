#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="${HP_REMOTE_UI_ENV:-$ROOT/deploy/server.env}"
LOCAL_ENV="$ROOT/.env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE"
  echo "Copy deploy/server.env.example to deploy/server.env and fill in signing + tunnel values first."
  exit 1
fi

set -a
. "$ENV_FILE"
if [ -f "$LOCAL_ENV" ]; then
  . "$LOCAL_ENV"
fi
set +a

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8080}"
HEALTH_URL="http://${HOST}:${PORT}/api/health"

APP_PID=""
TUNNEL_PID=""

stop_children() {
  if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
}

trap stop_children INT TERM EXIT

cd "$ROOT"
export PATH="$ROOT/.venv/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PYTHONPATH="$ROOT/.venv/deps${PYTHONPATH:+:$PYTHONPATH}"
PYTHON_BIN="${PYTHON_BIN:-$ROOT/.venv/bin/python3}"
if [ ! -x "$PYTHON_BIN" ]; then
  PYTHON_BIN=python3
fi

echo "Legacy Python-only UI entrypoint. For bitfun-platform.com use: scripts/restart_dev.sh"
echo "Running preflight..."
"$PYTHON_BIN" scripts/preflight_verify.py

echo "Starting Remote UI on $HEALTH_URL ..."
"$PYTHON_BIN" app.py &
APP_PID=$!

ready=0
attempt=0
while [ "$attempt" -lt 30 ]; do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.5
done

if [ "$ready" -ne 1 ]; then
  echo "Remote UI did not become ready at $HEALTH_URL"
  exit 1
fi

echo "Remote UI is ready."
sh "$ROOT/scripts/run_tunnel.sh" &
TUNNEL_PID=$!

echo "Dev stack running. Press Ctrl+C to stop app + tunnel."
wait "$TUNNEL_PID"
