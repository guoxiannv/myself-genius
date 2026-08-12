#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
GENIUS_ROOT="$(CDPATH= cd -- "$ROOT/.." && pwd)"
ENV_FILE="${HP_REMOTE_UI_ENV:-$ROOT/deploy/server.env}"
LOCAL_ENV="$ROOT/.env.local"

BACKGROUND=1
SKIP_PREFLIGHT=0
SERVE_STACK=0
TMUX_SESSION="${TMUX_SESSION:-remote-ui-dev}"
OPENBITFUN_PROXY_SESSION="${OPENBITFUN_PROXY_SESSION:-openbitfun-proxy}"
OPENBITFUN_PROXY_PORT="${OPENBITFUN_PROXY_PORT:-40363}"
OPENBITFUN_PROXY_ROOT="${OPENBITFUN_PROXY_ROOT:-$GENIUS_ROOT/runner}"
OPENBITFUN_PROXY_HEALTH_URL="http://127.0.0.1:${OPENBITFUN_PROXY_PORT}/health"

usage() {
  cat <<'EOF'
Usage: scripts/restart_dev.sh [--foreground] [--background] [--skip-preflight]

Stops only the managed Bitfun UI tmux session, waits for the frontend/backend
ports to be free, runs preflight checks, then starts the React frontend, Python
backend, and Cloudflare tunnel.
If ANTHROPIC_BASE_URL points to the local openbitfun proxy, the proxy is started
in its own tmux session first.

Options:
  --background       Start the stack in a persistent tmux session and verify /api/health (default).
  --foreground       Run the stack in the current terminal; Ctrl+C stops web + app + tunnel.
  --skip-preflight   Skip the explicit preflight step before startup.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --background)
      BACKGROUND=1
      ;;
    --foreground)
      BACKGROUND=0
      ;;
    --skip-preflight)
      SKIP_PREFLIGHT=1
      ;;
    --serve)
      SERVE_STACK=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  if [ -f "$LOCAL_ENV" ]; then
    . "$LOCAL_ENV"
  fi
  set +a
fi

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8080}"
BACKEND_PORT="${BACKEND_PORT:-8081}"
HEALTH_URL="http://${HOST}:${PORT}/api/health"
BACKEND_HEALTH_URL="http://${HOST}:${BACKEND_PORT}/api/health"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-${HP_PUBLIC_HEALTH_URL:-}}"
if [ -z "$PUBLIC_HEALTH_URL" ] && [ -n "${HP_HPACK_DEPLOY_DOMAIN:-}" ]; then
  PUBLIC_HEALTH_URL="https://${HP_HPACK_DEPLOY_DOMAIN}/api/health"
fi
PYTHON_BIN="${PYTHON_BIN:-$ROOT/.venv/bin/python3}"
if [ ! -x "$PYTHON_BIN" ]; then
  PYTHON_BIN=python3
fi

wait_for_url() {
  url="$1"
  attempts="$2"
  attempt=0
  while [ "$attempt" -lt "$attempts" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  return 1
}

uses_local_openbitfun_proxy() {
  [ "${ANTHROPIC_BASE_URL:-}" = "http://127.0.0.1:${OPENBITFUN_PROXY_PORT}" ] \
    || [ "${ANTHROPIC_BASE_URL:-}" = "http://localhost:${OPENBITFUN_PROXY_PORT}" ]
}

ensure_openbitfun_proxy() {
  if ! uses_local_openbitfun_proxy; then
    return 0
  fi

  if curl -fsS "$OPENBITFUN_PROXY_HEALTH_URL" >/dev/null 2>&1; then
    echo "openbitfun proxy is ready: $OPENBITFUN_PROXY_HEALTH_URL"
    return 0
  fi

  if [ ! -d "$OPENBITFUN_PROXY_ROOT" ]; then
    echo "Missing OPENBITFUN_PROXY_ROOT: $OPENBITFUN_PROXY_ROOT" >&2
    exit 1
  fi
  if ! command -v tmux >/dev/null 2>&1; then
    echo "tmux is required to start openbitfun proxy." >&2
    exit 1
  fi

  if tmux has-session -t "$OPENBITFUN_PROXY_SESSION" 2>/dev/null; then
    echo "openbitfun proxy session exists but health is not ready: $OPENBITFUN_PROXY_SESSION" >&2
    echo "Refusing to restart it automatically because active builds may depend on the proxy." >&2
    echo "Inspect it manually with: tmux attach -t $OPENBITFUN_PROXY_SESSION" >&2
    exit 1
  fi

  echo "Starting openbitfun proxy in tmux session: $OPENBITFUN_PROXY_SESSION"
  tmux new-session -d -s "$OPENBITFUN_PROXY_SESSION" "cd '$OPENBITFUN_PROXY_ROOT' && npm run openbitfun:proxy"

  if ! wait_for_url "$OPENBITFUN_PROXY_HEALTH_URL" 20; then
    echo "openbitfun proxy did not become ready at $OPENBITFUN_PROXY_HEALTH_URL" >&2
    echo "Attach with: tmux attach -t $OPENBITFUN_PROXY_SESSION" >&2
    exit 1
  fi
}

serve_stack() {
  RUN_ROOT="${RUN_ROOT:-$ROOT}"
  if [ ! -d "$RUN_ROOT" ]; then
    echo "Missing RUN_ROOT: $RUN_ROOT" >&2
    exit 1
  fi

  LOG_DIR="$RUN_ROOT/data/logs"
  mkdir -p "$LOG_DIR"

  export PATH="$ROOT/.venv/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
  export PYTHONPATH="$ROOT/.venv/deps${PYTHONPATH:+:$PYTHONPATH}"
  export HP_CAPTURE_PYTHON_BIN="${HP_CAPTURE_PYTHON_BIN:-$PYTHON_BIN}"
  export HP_TARGET_WORKSPACE="$RUN_ROOT/workspace"
  export HP_PROFILE_POOL_CONFIG="${HP_PROFILE_POOL_CONFIG:-$ROOT/deploy/profile-pool.json}"
  export HP_PROFILE_POOL_STATE="${HP_PROFILE_POOL_STATE:-$ROOT/deploy/profile-pool-state.json}"
  export HP_HPACK_ENABLED="${BITFUN_HPACK_ENABLED:-${HP_HPACK_ENABLED:-1}}"

  BACKEND_PID=""
  WEB_PID=""
  TUNNEL_PID=""

  stop_children() {
    for pid in "$TUNNEL_PID" "$WEB_PID" "$BACKEND_PID"; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
      fi
    done
  }

  trap stop_children INT TERM EXIT

  echo "Starting backend on 127.0.0.1:${BACKEND_PORT}"
  (
    cd "$RUN_ROOT"
    HOST=127.0.0.1 PORT="$BACKEND_PORT" "$PYTHON_BIN" app.py
  ) >"$LOG_DIR/bitfun-backend-${BACKEND_PORT}.log" 2>&1 &
  BACKEND_PID=$!

  if ! wait_for_url "http://127.0.0.1:${BACKEND_PORT}/api/health" 60; then
    echo "Backend did not become ready. See $LOG_DIR/bitfun-backend-${BACKEND_PORT}.log" >&2
    exit 1
  fi

  echo "Starting React frontend on 127.0.0.1:${PORT}"
  (
    cd "$RUN_ROOT/web"
    VITE_API_TARGET="http://127.0.0.1:${BACKEND_PORT}" npm run dev -- --host 127.0.0.1 --port "$PORT"
  ) >"$LOG_DIR/bitfun-web-${PORT}.log" 2>&1 &
  WEB_PID=$!

  if ! wait_for_url "http://127.0.0.1:${PORT}/api/health" 60; then
    echo "Frontend did not become ready. See $LOG_DIR/bitfun-web-${PORT}.log" >&2
    exit 1
  fi

  echo "Starting Cloudflare tunnel for bitfun-platform.com -> 127.0.0.1:${PORT}"
  (
    cd "$ROOT"
    while :; do
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Cloudflare tunnel supervisor attempt."
      if HOST=127.0.0.1 PORT="$PORT" sh scripts/run_tunnel.sh; then
        status=0
      else
        status=$?
      fi
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Cloudflare tunnel exited with status ${status}; retrying in ${TUNNEL_RETRY_DELAY:-5}s."
      sleep "${TUNNEL_RETRY_DELAY:-5}"
    done
  ) >"$LOG_DIR/bitfun-tunnel.log" 2>&1 &
  TUNNEL_PID=$!

  echo "Bitfun UI stack is running."
  echo "Local frontend: http://127.0.0.1:${PORT}/"
  echo "Backend health: http://127.0.0.1:${BACKEND_PORT}/api/health"
  echo "Logs: $LOG_DIR"

  while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
    sleep 2
  done

  echo "Backend or frontend exited; stopping stack." >&2
  exit 1
}

if [ "$SERVE_STACK" -eq 1 ]; then
  cd "$ROOT"
  ensure_openbitfun_proxy
  serve_stack
  exit 0
fi

echo "Project: $ROOT"
echo "Stopping existing dev stack..."

if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "Stopping tmux session: $TMUX_SESSION"
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  sleep 2
fi

echo "Checking port ${PORT}..."
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${PORT} is still in use:" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
  echo "Refusing to kill unrelated processes. Stop the process above manually if it is not $TMUX_SESSION." >&2
  exit 1
fi
echo "Port ${PORT} is free."

echo "Checking backend port ${BACKEND_PORT}..."
if lsof -nP -iTCP:"$BACKEND_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Backend port ${BACKEND_PORT} is still in use:" >&2
  lsof -nP -iTCP:"$BACKEND_PORT" -sTCP:LISTEN >&2 || true
  echo "Refusing to kill unrelated processes. Stop the process above manually if it is not $TMUX_SESSION." >&2
  exit 1
fi
echo "Backend port ${BACKEND_PORT} is free."

cd "$ROOT"

if [ "$SKIP_PREFLIGHT" -ne 1 ]; then
  echo "Running preflight..."
  "$PYTHON_BIN" scripts/preflight_verify.py
fi

ensure_openbitfun_proxy

if [ "$BACKGROUND" -eq 1 ]; then
  if ! command -v tmux >/dev/null 2>&1; then
    echo "tmux is required for --background mode. Install tmux or run without --background." >&2
    exit 1
  fi

  echo "Starting Bitfun UI stack in tmux session: $TMUX_SESSION"
  LOG_DIR="$ROOT/data/logs"
  LOG_PATH="$LOG_DIR/dev-stack.log"
  mkdir -p "$LOG_DIR"
  tmux new-session -d -s "$TMUX_SESSION" "cd '$ROOT' && sh scripts/restart_dev.sh --serve 2>&1 | tee '$LOG_PATH'"
  echo "Log: $LOG_PATH"
  echo "Attach: tmux attach -t $TMUX_SESSION"

  if ! wait_for_url "$BACKEND_HEALTH_URL" 40; then
    echo "Backend did not become ready at $BACKEND_HEALTH_URL" >&2
    exit 1
  fi

  if ! wait_for_url "$HEALTH_URL" 40; then
    echo "Frontend did not become ready at $HEALTH_URL" >&2
    exit 1
  fi

  echo "Bitfun UI is ready:"
  curl -fsS "$HEALTH_URL" | head -c 120
  echo

  if [ -n "$PUBLIC_HEALTH_URL" ]; then
    echo "Waiting for public tunnel: $PUBLIC_HEALTH_URL"
    if ! wait_for_url "$PUBLIC_HEALTH_URL" 90; then
      echo "Warning: public tunnel did not become ready at $PUBLIC_HEALTH_URL" >&2
      echo "Local Remote UI is healthy; tunnel will keep retrying in tmux session: $TMUX_SESSION" >&2
      echo "Check tunnel logs with: tail -f $ROOT/data/logs/bitfun-tunnel.log" >&2
      exit 0
    fi
    echo "Public tunnel is ready:"
    curl -fsS "$PUBLIC_HEALTH_URL" | head -c 120
    echo
  fi
else
  echo "Starting Bitfun UI stack in foreground. Press Ctrl+C to stop web + app + tunnel."
  exec sh scripts/restart_dev.sh --serve
fi
