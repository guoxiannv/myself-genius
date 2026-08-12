#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="${HP_REMOTE_UI_ENV:-$ROOT/deploy/server.env}"
LOCAL_ENV="$ROOT/.env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE"
  echo "Copy deploy/server.env.example to deploy/server.env and set CLOUDFLARE_TUNNEL_TOKEN first."
  exit 1
fi

set -a
. "$ENV_FILE"
if [ -f "$LOCAL_ENV" ]; then
  . "$LOCAL_ENV"
fi
set +a

CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-cloudflared}"
if ! command -v "$CLOUDFLARED_BIN" >/dev/null 2>&1; then
  echo "cloudflared not found. Install it with: brew install cloudflared"
  exit 1
fi
CLOUDFLARED_PROTOCOL="${CLOUDFLARED_PROTOCOL:-http2}"

TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "CLOUDFLARE_TUNNEL_TOKEN is empty in $ENV_FILE"
  echo "Add your tunnel token from Cloudflare Zero Trust dashboard."
  exit 1
fi

echo "Starting Cloudflare Tunnel -> http://${HOST:-127.0.0.1}:${PORT:-8080} (protocol: $CLOUDFLARED_PROTOCOL)"
exec "$CLOUDFLARED_BIN" tunnel run --protocol "$CLOUDFLARED_PROTOCOL" --token "$TOKEN"
