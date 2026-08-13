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

resolve_runner_path() {
  local value=$1
  if [[ "$value" == /* ]]; then
    print -r -- "$value"
  else
    print -r -- "$ORCH_ROOT/$value"
  fi
}

NODE_RUNTIME=${EXPO_FAST_NODE:-$(command -v node 2>/dev/null || true)}
SDK_ROOT=$(resolve_runner_path "${EXPO_HARMONY_SDK_ROOT:-../sdk}")
POOL_ROOT=$(resolve_runner_path "${EXPO_HARMONY_POOL_ROOT:-../harmony-pool}")
POOL_SIZE=${EXPO_HARMONY_POOL_SIZE:-4}
POOL_SCRIPT="$SDK_ROOT/tools/harmony/full-profile-pool.mjs"
WARM=1
FORCE_WARM=0

for arg in "$@"; do
  case "$arg" in
    --no-warm) WARM=0 ;;
    --force) FORCE_WARM=1 ;;
    -h|--help)
      print "Usage: ./setup-harmony-pool.sh [--no-warm] [--force]"
      exit 0
      ;;
    *) print -u2 "Unknown option: $arg"; exit 2 ;;
  esac
done

if [[ -z "$NODE_RUNTIME" || ! -x "$NODE_RUNTIME" ]]; then
  print -u2 "Expo Harmony pool setup requires an executable Node.js runtime."
  exit 1
fi
if [[ ! "$POOL_SIZE" =~ '^[1-4]$' ]]; then
  print -u2 "EXPO_HARMONY_POOL_SIZE must be between 1 and 4: $POOL_SIZE"
  exit 1
fi
if [[ ! -f "$POOL_SCRIPT" ]]; then
  print -u2 "Harmony pool SDK entrypoint is missing: $POOL_SCRIPT"
  exit 1
fi

if ! "$NODE_RUNTIME" -e "require.resolve('typescript', { paths: [process.argv[1]] })" "$SDK_ROOT" >/dev/null 2>&1; then
  COREPACK_RUNTIME="${NODE_RUNTIME:h}/corepack"
  if [[ ! -x "$COREPACK_RUNTIME" ]]; then
    print -u2 "SDK dependencies are missing and Corepack was not found beside Node: $COREPACK_RUNTIME"
    print -u2 "Install the SDK workspace dependencies before initializing the Harmony pool."
    exit 1
  fi
  print "Installing the minimal SDK workspace dependencies required by Harmony pool preparation"
  (
    cd "$SDK_ROOT"
    PATH="${NODE_RUNTIME:h}:$PATH" "$COREPACK_RUNTIME" pnpm install \
      --frozen-lockfile \
      --ignore-scripts \
      --filter @expo/expo
  )
fi

"$NODE_RUNTIME" "$POOL_SCRIPT" init --pool "$POOL_ROOT" --size "$POOL_SIZE"
if (( WARM )); then
  warm_args=(warm --pool "$POOL_ROOT")
  if (( FORCE_WARM )); then
    warm_args+=(--force)
  fi
  "$NODE_RUNTIME" "$POOL_SCRIPT" "${warm_args[@]}"
fi
"$NODE_RUNTIME" "$POOL_SCRIPT" status --pool "$POOL_ROOT" --json
