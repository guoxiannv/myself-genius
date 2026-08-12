#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
LOG_DIR="$ROOT/data/logs"
mkdir -p "$LOG_DIR"

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8080}"
export CLOUDFLARED_PROTOCOL="${CLOUDFLARED_PROTOCOL:-http2}"

cd "$ROOT"
exec sh scripts/run_tunnel.sh >> "$LOG_DIR/public-tunnel-recover.log" 2>&1
