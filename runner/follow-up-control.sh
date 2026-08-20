#!/bin/zsh
set -euo pipefail

ORCH_ROOT=${0:A:h}
LOCAL_ENV=${EXPO_FAST_ENV_FILE:-$ORCH_ROOT/.env}
if [[ "$LOCAL_ENV" != /* ]]; then
  LOCAL_ENV="$ORCH_ROOT/$LOCAL_ENV"
fi
if [[ -f "$LOCAL_ENV" ]]; then
  set -a
  source "$LOCAL_ENV"
  set +a
fi
NODE_RUNTIME=${EXPO_FAST_NODE:-$(command -v node 2>/dev/null || true)}
if [[ -z "$NODE_RUNTIME" || ! -x "$NODE_RUNTIME" ]]; then
  print -u2 "Expo Harmony Fast follow-up requires an executable Node runtime."
  exit 1
fi
exec "$NODE_RUNTIME" "$ORCH_ROOT/scripts/follow-up-control.mjs" "$@"
