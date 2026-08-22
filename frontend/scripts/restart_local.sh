#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="${HP_REMOTE_UI_ENV:-$ROOT/deploy/server.env}"
LOCAL_ENV="$ROOT/.env.local"

HOST="${HOST:-127.0.0.1}"
FRONTEND_PORT="${FRONTEND_PORT:-8180}"
BACKEND_PORT="${BACKEND_PORT:-8181}"
FOREGROUND=0
TMUX_MODE=0
STOP_ONLY=0
INTERNAL_SERVICE=""
OPENBITFUN_PROXY_SESSION="${OPENBITFUN_PROXY_SESSION:-openbitfun-proxy}"
OPENBITFUN_PROXY_PORT="${OPENBITFUN_PROXY_PORT:-40363}"
OPENBITFUN_PROXY_ROOT="${OPENBITFUN_PROXY_ROOT:-$ROOT}"
OPENBITFUN_PROXY_COMMAND="${OPENBITFUN_PROXY_COMMAND:-node scripts/openbitfun-usage-proxy.mjs}"
OPENBITFUN_PROXY_HEALTH_URL="http://127.0.0.1:${OPENBITFUN_PROXY_PORT}/health"

usage() {
  cat <<'EOF'
Usage: scripts/restart_local.sh [--foreground | --tmux | --stop]

Restarts the local-only dev stack:
  frontend: http://127.0.0.1:8180/
  backend:  http://127.0.0.1:8181/
Only the managed tmux session and process trees recorded in
data/pids/local-*.pid are stopped. If a port is occupied by another process,
the script exits without killing it.
If ANTHROPIC_BASE_URL points to the local openbitfun proxy, the proxy is started
in its own tmux session first.

Options:
  --foreground   Keep a local supervisor in the current terminal.
  --tmux         Run backend and frontend in separate windows of one tmux session.
  --stop         Stop the managed local stack and remove its PID files.
  -h, --help     Show this help.

Environment overrides:
  FRONTEND_PORT=8180 BACKEND_PORT=8181 HOST=127.0.0.1
  HP_EXPO_PUBLIC_SERVE_PORT=3353 HP_EXPO_PUBLIC_SERVE_ENABLED=1
  LOCAL_TMUX_SESSION=remote-ui-local
  OPENBITFUN_PROXY_ROOT=/path/to/Genius/frontend
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --foreground)
      FOREGROUND=1
      ;;
    --tmux)
      TMUX_MODE=1
      ;;
    --stop)
      STOP_ONLY=1
      ;;
    --serve-backend)
      INTERNAL_SERVICE="backend"
      ;;
    --serve-frontend)
      INTERNAL_SERVICE="frontend"
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

selected_modes=$((FOREGROUND + TMUX_MODE + STOP_ONLY))
if [ "$selected_modes" -gt 1 ] || { [ -n "$INTERNAL_SERVICE" ] && [ "$selected_modes" -gt 0 ]; }; then
  echo "Choose only one of --foreground, --tmux, or --stop." >&2
  exit 2
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi
if [ -f "$LOCAL_ENV" ]; then
  set -a
  . "$LOCAL_ENV"
  set +a
fi

HOST="${HOST:-127.0.0.1}"
FRONTEND_PORT="${FRONTEND_PORT:-8180}"
BACKEND_PORT="${BACKEND_PORT:-8181}"
HP_EXPO_PUBLIC_SERVE_ENABLED="${HP_EXPO_PUBLIC_SERVE_ENABLED:-1}"
HP_EXPO_PUBLIC_SERVE_PORT="${HP_EXPO_PUBLIC_SERVE_PORT:-3353}"
FRONTEND_URL="http://${HOST}:${FRONTEND_PORT}/"
FRONTEND_HEALTH_URL="http://${HOST}:${FRONTEND_PORT}/api/health"
BACKEND_HEALTH_URL="http://${HOST}:${BACKEND_PORT}/api/health"
EXPO_GATEWAY_HEALTH_URL="http://127.0.0.1:${HP_EXPO_PUBLIC_SERVE_PORT}/health"
LOG_DIR="$ROOT/data/logs"
PID_DIR="$ROOT/data/pids"
LOCAL_TMUX_SESSION="${LOCAL_TMUX_SESSION:-remote-ui-local}"

PYTHON_BIN="${PYTHON_BIN:-$ROOT/.venv/bin/python3}"
if [ ! -x "$PYTHON_BIN" ]; then
  PYTHON_BIN=python3
fi

mkdir -p "$LOG_DIR" "$PID_DIR"

run_backend_service() {
  cd "$ROOT"
  export PATH="$ROOT/.venv/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
  export PYTHONPATH="$ROOT/.venv/deps${PYTHONPATH:+:$PYTHONPATH}"
  export HOST
  PORT="$BACKEND_PORT"
  export PORT
  exec "$PYTHON_BIN" app.py
}

run_frontend_service() {
  cd "$ROOT/web"
  VITE_API_TARGET="http://${HOST}:${BACKEND_PORT}"
  export VITE_API_TARGET
  exec npm run dev -- --host "$HOST" --port "$FRONTEND_PORT"
}

if [ "$INTERNAL_SERVICE" = "backend" ]; then
  run_backend_service
fi
if [ "$INTERNAL_SERVICE" = "frontend" ]; then
  run_frontend_service
fi

port_pids() {
  port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
  else
    return 0
  fi
}

check_port_free() {
  port="$1"
  label="$2"
  pids="$(port_pids "$port")"
  if [ -z "$pids" ]; then
    echo "$label port $port is free."
    return 0
  fi

  echo "$label port $port is still in use:" >&2
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
  echo "Refusing to kill unrelated processes. Stop the process above manually if it is not this local dev stack." >&2
  exit 1
}

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

expo_gateway_enabled() {
  case "$(printf '%s' "$HP_EXPO_PUBLIC_SERVE_ENABLED" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
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
    echo "Set OPENBITFUN_PROXY_ROOT in deploy/server.env when using the local proxy." >&2
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
  tmux new-session -d -s "$OPENBITFUN_PROXY_SESSION" "cd '$OPENBITFUN_PROXY_ROOT' && set -a; if [ -f '$ENV_FILE' ]; then . '$ENV_FILE'; fi; if [ -f '$LOCAL_ENV' ]; then . '$LOCAL_ENV'; fi; set +a; OPENBITFUN_PROXY_ENV_FILE='$ENV_FILE' exec $OPENBITFUN_PROXY_COMMAND"

  if ! wait_for_url "$OPENBITFUN_PROXY_HEALTH_URL" 20; then
    echo "openbitfun proxy did not become ready at $OPENBITFUN_PROXY_HEALTH_URL" >&2
    echo "Attach with: tmux attach -t $OPENBITFUN_PROXY_SESSION" >&2
    exit 1
  fi
}

start_backend() {
  echo "Starting backend on ${BACKEND_HEALTH_URL}"
  nohup sh -c '
    cd "$1" || exit 1
    export PATH="$1/.venv/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
    export PYTHONPATH="$1/.venv/deps${PYTHONPATH:+:$PYTHONPATH}"
    exec env HOST="$2" PORT="$3" "$4" app.py
  ' sh "$ROOT" "$HOST" "$BACKEND_PORT" "$PYTHON_BIN" >"$LOG_DIR/local-backend-${BACKEND_PORT}.log" 2>&1 < /dev/null &
  BACKEND_PID=$!
  echo "$BACKEND_PID" >"$PID_DIR/local-backend.pid"
}

start_frontend() {
  echo "Starting frontend on ${FRONTEND_URL}"
  nohup sh -c '
    cd "$1/web" || exit 1
    exec env VITE_API_TARGET="http://$2:$3" npm run dev -- --host "$2" --port "$4"
  ' sh "$ROOT" "$HOST" "$BACKEND_PORT" "$FRONTEND_PORT" >"$LOG_DIR/local-frontend-${FRONTEND_PORT}.log" 2>&1 < /dev/null &
  FRONTEND_PID=$!
  echo "$FRONTEND_PID" >"$PID_DIR/local-frontend.pid"
}

child_pids() {
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -P "$1" 2>/dev/null || true
  fi
}

stop_pid_tree() {
  descendants="$(child_pids "$1")"
  for child_pid in $descendants; do
    stop_pid_tree "$child_pid"
  done
  if kill -0 "$1" 2>/dev/null; then
    kill "$1" 2>/dev/null || true
  fi
}

stop_recorded_processes() {
  for pid_file in "$PID_DIR/local-frontend.pid" "$PID_DIR/local-backend.pid"; do
    if [ -f "$pid_file" ]; then
      pid="$(cat "$pid_file" 2>/dev/null || true)"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "Stopping recorded local dev process tree $pid from $pid_file"
        stop_pid_tree "$pid"
      fi
      rm -f "$pid_file"
    fi
  done
}

stop_tmux_stack() {
  if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$LOCAL_TMUX_SESSION" 2>/dev/null; then
    echo "Stopping local tmux session: $LOCAL_TMUX_SESSION"
    tmux kill-session -t "$LOCAL_TMUX_SESSION"
  fi
}

stop_local_stack() {
  stop_tmux_stack
  stop_recorded_processes
}

wait_for_managed_ports_to_stop() {
  attempts=0
  while [ "$attempts" -lt 10 ]; do
    if [ -z "$(port_pids "$FRONTEND_PORT")" ] && [ -z "$(port_pids "$BACKEND_PORT")" ]; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  return 1
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

tmux_service_command() {
  service_flag="$1"
  printf 'exec env HP_REMOTE_UI_ENV=%s HOST=%s FRONTEND_PORT=%s BACKEND_PORT=%s PYTHON_BIN=%s LOCAL_TMUX_SESSION=%s' \
    "$(shell_quote "$ENV_FILE")" \
    "$(shell_quote "$HOST")" \
    "$(shell_quote "$FRONTEND_PORT")" \
    "$(shell_quote "$BACKEND_PORT")" \
    "$(shell_quote "$PYTHON_BIN")" \
    "$(shell_quote "$LOCAL_TMUX_SESSION")"
  if [ -n "${__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS:-}" ]; then
    printf ' __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=%s' \
      "$(shell_quote "$__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS")"
  fi
  printf ' %s %s' "$(shell_quote "$ROOT/scripts/restart_local.sh")" "$service_flag"
}

start_tmux_stack() {
  if ! command -v tmux >/dev/null 2>&1; then
    echo "tmux is required for --tmux mode." >&2
    exit 1
  fi

  backend_command="$(tmux_service_command --serve-backend)"
  frontend_command="$(tmux_service_command --serve-frontend)"

  echo "Starting tmux session $LOCAL_TMUX_SESSION with backend and frontend windows."
  tmux new-session -d -s "$LOCAL_TMUX_SESSION" -n backend "$backend_command"
  tmux set-window-option -t "$LOCAL_TMUX_SESSION:backend" remain-on-exit on

  if ! wait_for_url "$BACKEND_HEALTH_URL" 60; then
    echo "Backend did not become ready. Last tmux output:" >&2
    tmux capture-pane -pt "$LOCAL_TMUX_SESSION:backend" -S -80 >&2 || true
    tmux kill-session -t "$LOCAL_TMUX_SESSION" 2>/dev/null || true
    exit 1
  fi
  if expo_gateway_enabled && ! wait_for_url "$EXPO_GATEWAY_HEALTH_URL" 10; then
    echo "Expo Gateway did not become ready at $EXPO_GATEWAY_HEALTH_URL" >&2
    tmux capture-pane -pt "$LOCAL_TMUX_SESSION:backend" -S -80 >&2 || true
    tmux kill-session -t "$LOCAL_TMUX_SESSION" 2>/dev/null || true
    exit 1
  fi

  tmux new-window -d -t "$LOCAL_TMUX_SESSION:" -n frontend "$frontend_command"
  tmux set-window-option -t "$LOCAL_TMUX_SESSION:frontend" remain-on-exit on

  if ! wait_for_url "$FRONTEND_HEALTH_URL" 60; then
    echo "Frontend did not become ready. Last tmux output:" >&2
    tmux capture-pane -pt "$LOCAL_TMUX_SESSION:frontend" -S -80 >&2 || true
    tmux kill-session -t "$LOCAL_TMUX_SESSION" 2>/dev/null || true
    exit 1
  fi

  tmux select-window -t "$LOCAL_TMUX_SESSION:backend"
  echo "Local dev stack is ready in tmux."
  echo "Frontend: $FRONTEND_URL"
  echo "Backend:  $BACKEND_HEALTH_URL"
  if expo_gateway_enabled; then
    echo "Expo Gateway: $EXPO_GATEWAY_HEALTH_URL"
  fi
  echo "Attach:   tmux attach -t $LOCAL_TMUX_SESSION"
  echo "Windows:  backend, frontend"
}

stop_children() {
  stop_local_stack
}

echo "Project: $ROOT"

if [ "$STOP_ONLY" -eq 1 ]; then
  echo "Stopping local dev stack..."
  stop_local_stack
  if ! wait_for_managed_ports_to_stop; then
    echo "Managed processes stopped, but a configured port is still occupied:" >&2
    for port in "$FRONTEND_PORT" "$BACKEND_PORT"; do
      if [ -n "$(port_pids "$port")" ]; then
        lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
      fi
    done
    exit 1
  fi
  echo "Local dev stack is stopped."
  exit 0
fi

echo "Restarting local dev stack (${FRONTEND_PORT} -> ${BACKEND_PORT})..."

stop_local_stack
wait_for_managed_ports_to_stop || true
check_port_free "$FRONTEND_PORT" "frontend"
check_port_free "$BACKEND_PORT" "backend"
if expo_gateway_enabled; then
  check_port_free "$HP_EXPO_PUBLIC_SERVE_PORT" "Expo Gateway"
fi
ensure_openbitfun_proxy

if [ "$TMUX_MODE" -eq 1 ]; then
  start_tmux_stack
  exit 0
fi

if [ "$FOREGROUND" -eq 1 ]; then
  trap stop_children INT TERM EXIT
fi

start_backend
if ! wait_for_url "$BACKEND_HEALTH_URL" 60; then
  echo "Backend did not become ready. See $LOG_DIR/local-backend-${BACKEND_PORT}.log" >&2
  exit 1
fi
if expo_gateway_enabled && ! wait_for_url "$EXPO_GATEWAY_HEALTH_URL" 10; then
  echo "Expo Gateway did not become ready. See $LOG_DIR/local-backend-${BACKEND_PORT}.log" >&2
  exit 1
fi

start_frontend
if ! wait_for_url "$FRONTEND_HEALTH_URL" 60; then
  echo "Frontend did not become ready. See $LOG_DIR/local-frontend-${FRONTEND_PORT}.log" >&2
  exit 1
fi

echo "Local dev stack is ready."
echo "Frontend: $FRONTEND_URL"
echo "Backend:  $BACKEND_HEALTH_URL"
if expo_gateway_enabled; then
  echo "Expo Gateway: $EXPO_GATEWAY_HEALTH_URL"
fi
echo "Logs:"
echo "  $LOG_DIR/local-frontend-${FRONTEND_PORT}.log"
echo "  $LOG_DIR/local-backend-${BACKEND_PORT}.log"

if [ "$FOREGROUND" -eq 1 ]; then
  echo "Running in foreground. Press Ctrl+C to stop."
  wait
fi
