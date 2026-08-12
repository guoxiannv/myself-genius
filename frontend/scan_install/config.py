from __future__ import annotations

import os
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
DEPLOY_DIR = APP_ROOT / "deploy"
MONOREPO_ROOT = APP_ROOT.parent
DEFAULT_EXPO_FAST_ROOT = (MONOREPO_ROOT / "runner").resolve()
DEFAULT_EXPO_FAST_APP_ROOT = (MONOREPO_ROOT / "expo-app").resolve()


def load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def resolve_app_path(value: str) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path.resolve()
    return (APP_ROOT / path).resolve()


load_env_file(DEPLOY_DIR / "server.env")
load_env_file(Path(os.environ.get("HP_REMOTE_UI_ENV", str(APP_ROOT / ".env.local"))).expanduser())

DATA_DIR = APP_ROOT / "data"
RUNS_DIR = DATA_DIR / "runs"
DEFAULT_ARTIFACTS_DIR = DATA_DIR / "artifacts"
LOG_DIR = DATA_DIR / "logs"

TMUX_RUNNER_PATH = (
    Path(os.environ["HP_TMUX_RUNNER"]).expanduser().resolve()
    if os.environ.get("HP_TMUX_RUNNER", "").strip()
    else Path()
)
TARGET_WORKSPACE = (
    Path(os.environ["HP_TARGET_WORKSPACE"]).expanduser().resolve()
    if os.environ.get("HP_TARGET_WORKSPACE", "").strip()
    else Path()
)

EXPO_FAST_ROOT = (
    resolve_app_path(os.environ["HP_EXPO_FAST_ROOT"])
    if os.environ.get("HP_EXPO_FAST_ROOT", "").strip()
    else DEFAULT_EXPO_FAST_ROOT
)
EXPO_FAST_LAUNCHER = EXPO_FAST_ROOT / "start-livetest.sh" if EXPO_FAST_ROOT else None
EXPO_FAST_APP_ROOT = (
    resolve_app_path(
        os.environ.get("HP_EXPO_FAST_APP_ROOT")
        or os.environ.get("EXPO_FAST_APP_ROOT")
        or str(DEFAULT_EXPO_FAST_APP_ROOT)
    )
)
EXPO_FAST_ENV_FILE = (
    resolve_app_path(os.environ["HP_EXPO_FAST_ENV_FILE"])
    if os.environ.get("HP_EXPO_FAST_ENV_FILE", "").strip()
    else EXPO_FAST_ROOT / ".env"
)

EXPO_PUBLIC_SERVE_ENABLED = os.environ.get("HP_EXPO_PUBLIC_SERVE_ENABLED", "1").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
EXPO_PUBLIC_SERVE_HOST = os.environ.get("HP_EXPO_PUBLIC_SERVE_HOST", "127.0.0.1").strip() or "127.0.0.1"
EXPO_PUBLIC_SERVE_PORT = int(os.environ.get("HP_EXPO_PUBLIC_SERVE_PORT", "3456"))
EXPO_PUBLIC_ORIGIN = (
    os.environ.get("HP_EXPO_PUBLIC_ORIGIN", "https://devkit-go.yorha2b.cc/").strip().rstrip("/")
)
EXPO_PUBLIC_SERVE_STATE_PATH = resolve_app_path(
    os.environ.get("HP_EXPO_PUBLIC_SERVE_STATE_PATH") or "data/expo-publications.json"
)

DEFAULT_VARIANT = os.environ.get("HP_TMUX_VARIANT", "autopilot-html-tmux-team-split")
DEFAULT_POLL_INTERVAL_MS = int(os.environ.get("HP_POLL_INTERVAL_MS", "3000"))
MEDIA_DIR = Path(
    os.environ.get("HP_MEDIA_DIR", str(DEFAULT_ARTIFACTS_DIR / "videos"))
).resolve()

EXPECTED_HAP_RELATIVE_PATH = Path("entry/build/default/outputs/default/entry-default-unsigned.hap")
HDC_CAPTURE_SCRIPT_PATH = APP_ROOT / "scripts" / "hdc_runtime_capture.py"
HPACK_PACKAGER_SCRIPT_PATH = APP_ROOT / "scripts" / "hpack_packager.py"

HPACK_ENABLED = os.environ.get("HP_HPACK_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}
HPACK_PYTHON_BIN = os.environ.get("HP_HPACK_PYTHON_BIN", sys.executable).strip() or sys.executable
HPACK_STATIC_ROOT = (
    Path(os.environ.get("HP_HPACK_STATIC_ROOT", "")).expanduser().resolve()
    if os.environ.get("HP_HPACK_STATIC_ROOT", "")
    else None
)
if HPACK_STATIC_ROOT is not None:
    HPACK_STATIC_ROOT.mkdir(parents=True, exist_ok=True)

HDC_CAPTURE_TARGET = os.environ.get("HP_HDC_TARGET", "").strip()
DEFAULT_CAPTURE_PYTHON_BIN = APP_ROOT / ".venv" / "bin" / "python3"
CAPTURE_PYTHON_BIN = (
    os.environ.get("HP_CAPTURE_PYTHON_BIN", "").strip()
    or (str(DEFAULT_CAPTURE_PYTHON_BIN) if DEFAULT_CAPTURE_PYTHON_BIN.is_file() else sys.executable)
)
CAPTURE_POLL_INTERVAL_SEC = float(os.environ.get("HP_CAPTURE_POLL_INTERVAL_SEC", "5"))
CAPTURE_WAIT_TIMEOUT_SEC = float(os.environ.get("HP_CAPTURE_WAIT_TIMEOUT_SEC", "9800"))
HPACK_WAIT_TIMEOUT_SEC = float(os.environ.get("HP_HPACK_WAIT_TIMEOUT_SEC", "9800"))

PROFILE_POOL_SCRIPT_PATH = APP_ROOT / "scripts" / "profile_pool_manager.py"
PROFILE_POOL_CONFIG_PATH = resolve_app_path(
    os.environ.get("HP_PROFILE_POOL_CONFIG")
    or os.environ.get("HP_SIGNING_POOL_CONFIG")
    or "deploy/profile-pool.json"
)
PROFILE_POOL_STATE_PATH = resolve_app_path(
    os.environ.get("HP_PROFILE_POOL_STATE")
    or os.environ.get("HP_SIGNING_POOL_STATE")
    or "deploy/profile-pool-state.json"
)


def profile_pool_flag_enabled() -> bool:
    flag = (
        os.environ.get("HP_PROFILE_POOL_ENABLED")
        or os.environ.get("HP_SIGNING_POOL_ENABLED")
        or "auto"
    ).strip().lower()
    if flag in {"1", "true", "yes", "on"}:
        return True
    if flag in {"0", "false", "no", "off"}:
        return False
    return PROFILE_POOL_CONFIG_PATH.is_file()


PROFILE_POOL_ENABLED = profile_pool_flag_enabled()
PROFILE_POOL_ISOLATE_WORKSPACE = (
    os.environ.get("HP_PROFILE_POOL_ISOLATE_WORKSPACE")
    or os.environ.get("HP_SIGNING_POOL_ISOLATE_WORKSPACE")
    or "1"
).strip().lower() in {"1", "true", "yes", "on"}

ALLOWED_MEDIA_EXTENSIONS = {".gif", ".webp", ".mp4", ".png", ".jpg", ".jpeg"}

RUNS_DIR.mkdir(parents=True, exist_ok=True)
MEDIA_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)
