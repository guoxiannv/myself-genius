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

# Corepack is not bundled with every Node installation, so resolve a pnpm runner
# the same way sdk/tools/harmony/prepare-app.mjs does: an explicit override, then
# Corepack beside Node, then Corepack on PATH, then pnpm on PATH, and finally
# npm's on-demand runner for the SDK's pinned package manager.
resolve_pnpm_command() {
  local node_dir=${NODE_RUNTIME:h}
  local candidate
  if [[ -n "${EXPO_HARMONY_PNPM_BIN:-}" ]]; then
    if [[ ! -x "$EXPO_HARMONY_PNPM_BIN" ]]; then
      print -u2 "EXPO_HARMONY_PNPM_BIN is not executable: $EXPO_HARMONY_PNPM_BIN"
      return 1
    fi
    PNPM_COMMAND=("$EXPO_HARMONY_PNPM_BIN")
    return 0
  fi
  if [[ -x "$node_dir/corepack" ]]; then
    PNPM_COMMAND=("$node_dir/corepack" pnpm)
    return 0
  fi
  candidate=$(command -v corepack 2>/dev/null || true)
  if [[ -n "$candidate" ]]; then
    PNPM_COMMAND=("$candidate" pnpm)
    return 0
  fi
  candidate=$(command -v pnpm 2>/dev/null || true)
  if [[ -n "$candidate" ]]; then
    PNPM_COMMAND=("$candidate")
    return 0
  fi
  candidate=$(command -v npm 2>/dev/null || true)
  if [[ -n "$candidate" ]]; then
    local pinned
    pinned=$("$NODE_RUNTIME" -e "process.stdout.write(require(process.argv[1] + '/package.json').packageManager || 'pnpm')" "$SDK_ROOT" 2>/dev/null || print -r -- pnpm)
    PNPM_COMMAND=("$candidate" exec --yes "--package=${pinned:-pnpm}" -- pnpm)
    return 0
  fi
  return 1
}

if ! "$NODE_RUNTIME" -e "require.resolve('typescript', { paths: [process.argv[1]] })" "$SDK_ROOT" >/dev/null 2>&1; then
  typeset -a PNPM_COMMAND
  if ! resolve_pnpm_command; then
    print -u2 "SDK dependencies are missing and no pnpm runner was found."
    print -u2 "Install pnpm, provide Corepack, set EXPO_HARMONY_PNPM_BIN, or install the SDK workspace dependencies manually."
    exit 1
  fi
  print "Installing the minimal SDK workspace dependencies required by Harmony pool preparation via ${PNPM_COMMAND[1]}"
  (
    cd "$SDK_ROOT"
    PATH="${NODE_RUNTIME:h}:$PATH" "${PNPM_COMMAND[@]}" install \
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
