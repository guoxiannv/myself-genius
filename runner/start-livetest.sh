#!/bin/zsh
set -euo pipefail

ORCH_ROOT=${0:A:h}
LOCAL_ENV=${EXPO_FAST_ENV_FILE:-$ORCH_ROOT/.env}

if [[ -f "$LOCAL_ENV" ]]; then
  set -a
  source "$LOCAL_ENV"
  set +a
  export EXPO_FAST_ENV_FILE=$LOCAL_ENV
fi

NODE_RUNTIME=${EXPO_FAST_NODE:-$(command -v node 2>/dev/null || true)}
if [[ -z "$NODE_RUNTIME" ]]; then
  print -u2 "Expo Harmony Fast requires Node.js 22.13 or newer. Set EXPO_FAST_NODE in $LOCAL_ENV."
  exit 1
fi
if [[ "$NODE_RUNTIME" != /* ]]; then
  NODE_RUNTIME=$(command -v "$NODE_RUNTIME" 2>/dev/null || true)
fi
if [[ -z "$NODE_RUNTIME" || ! -x "$NODE_RUNTIME" ]]; then
  print -u2 "Configured Node runtime is not executable: ${EXPO_FAST_NODE:-<not set>}"
  exit 1
fi

exec "$NODE_RUNTIME" "$ORCH_ROOT/scripts/start-livetest.mjs" "$@"
