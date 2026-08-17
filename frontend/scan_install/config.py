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


def resolve_app_executable(value: str) -> str:
    value = value.strip()
    if not value or "/" not in value:
        return value
    path = Path(value).expanduser()
    return str(path if path.is_absolute() else APP_ROOT / path)


load_env_file(DEPLOY_DIR / "server.env")
load_env_file(Path(os.environ.get("HP_REMOTE_UI_ENV", str(APP_ROOT / ".env.local"))).expanduser())

# Values loaded from a repository-local env file must keep the same meaning even
# when a child process changes cwd to runner/, a generated workspace, or tmux.
if os.environ.get("CLAUDE_CONFIG_DIR", "").strip():
    os.environ["CLAUDE_CONFIG_DIR"] = str(resolve_app_path(os.environ["CLAUDE_CONFIG_DIR"]))
for command_path_key in ("HP_CAPTURE_PYTHON_BIN", "HP_HPACK_BIN", "HP_HPACK_PYTHON_BIN"):
    command_path = os.environ.get(command_path_key, "").strip()
    if "/" in command_path:
        os.environ[command_path_key] = resolve_app_executable(command_path)

DATA_DIR = APP_ROOT / "data"
RUNS_DIR = DATA_DIR / "runs"
DEFAULT_ARTIFACTS_DIR = DATA_DIR / "artifacts"
LOG_DIR = DATA_DIR / "logs"

TMUX_RUNNER_PATH = (
    resolve_app_path(os.environ["HP_TMUX_RUNNER"])
    if os.environ.get("HP_TMUX_RUNNER", "").strip()
    else Path()
)
TARGET_WORKSPACE = (
    resolve_app_path(os.environ["HP_TARGET_WORKSPACE"])
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
EXPO_PUBLIC_SERVE_PORT = int(os.environ.get("HP_EXPO_PUBLIC_SERVE_PORT", "3353"))
EXPO_PUBLIC_ORIGIN = (
    os.environ.get("HP_EXPO_PUBLIC_ORIGIN", "https://version2app.bitfun-platform.com/").strip().rstrip("/")
)
EXPO_PUBLIC_SERVE_STATE_PATH = resolve_app_path(
    os.environ.get("HP_EXPO_PUBLIC_SERVE_STATE_PATH") or "data/expo-publications.json"
)

DEFAULT_VARIANT = os.environ.get("HP_TMUX_VARIANT", "autopilot-html-tmux-team-split")
DEFAULT_POLL_INTERVAL_MS = int(os.environ.get("HP_POLL_INTERVAL_MS", "3000"))
MEDIA_DIR = resolve_app_path(
    os.environ.get("HP_MEDIA_DIR", str(DEFAULT_ARTIFACTS_DIR / "videos"))
)

EXPECTED_HAP_RELATIVE_PATH = Path("entry/build/default/outputs/default/entry-default-unsigned.hap")
HDC_CAPTURE_SCRIPT_PATH = APP_ROOT / "scripts" / "hdc_runtime_capture.py"
HPACK_PACKAGER_SCRIPT_PATH = APP_ROOT / "scripts" / "hpack_packager.py"

HPACK_ENABLED = os.environ.get("HP_HPACK_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}
HPACK_PYTHON_BIN = (
    resolve_app_executable(os.environ.get("HP_HPACK_PYTHON_BIN", sys.executable)) or sys.executable
)
HPACK_STATIC_ROOT = (
    resolve_app_path(os.environ.get("HP_HPACK_STATIC_ROOT", ""))
    if os.environ.get("HP_HPACK_STATIC_ROOT", "")
    else None
)
if HPACK_STATIC_ROOT is not None:
    HPACK_STATIC_ROOT.mkdir(parents=True, exist_ok=True)

HDC_CAPTURE_TARGET = os.environ.get("HP_HDC_TARGET", "").strip()
HDC_DESKTOP_TARGET = os.environ.get("HP_HDC_DESKTOP_TARGET", "").strip() or HDC_CAPTURE_TARGET
HDC_PHONE_TARGET = os.environ.get("HP_HDC_PHONE_TARGET", "").strip()


def parse_target_pool(value: str, fallback: str = "") -> tuple[str, ...]:
    targets = [target.strip() for target in value.replace(",", " ").split() if target.strip()]
    if not targets and fallback:
        targets = [fallback]
    return tuple(dict.fromkeys(targets))


HDC_DESKTOP_TARGETS = parse_target_pool(os.environ.get("HP_HDC_DESKTOP_TARGETS", ""), HDC_DESKTOP_TARGET)
HDC_PHONE_TARGETS = parse_target_pool(os.environ.get("HP_HDC_PHONE_TARGETS", ""), HDC_PHONE_TARGET)
PREVIEW_DEVICE_POOL_ROOT = Path(
    os.environ.get("EXPO_FAST_DEVICE_POOL_ROOT")
    or os.environ.get("HP_PREVIEW_DEVICE_POOL_ROOT")
    or "/private/tmp/genius-expo-preview-pool"
).expanduser().resolve()
PREVIEW_LEASE_SECONDS = max(15, int(os.environ.get("EXPO_FAST_PREVIEW_LEASE_SECONDS", "90")))
PREVIEW_WAIT_SECONDS = max(1, int(os.environ.get("HP_PHONE_PREVIEW_WAIT_SECONDS", "120")))
PREVIEW_IDLE_SECONDS = max(30, int(os.environ.get("HP_PREVIEW_IDLE_SECONDS", "90")))
PREVIEW_HIDDEN_GRACE_SECONDS = max(
    5,
    int(os.environ.get("HP_PREVIEW_HIDDEN_GRACE_SECONDS", "30")),
)
PREVIEW_MAX_SESSION_SECONDS = max(
    PREVIEW_IDLE_SECONDS,
    int(os.environ.get("HP_PREVIEW_MAX_SESSION_SECONDS", "600")),
)
DEFAULT_CAPTURE_PYTHON_BIN = APP_ROOT / ".venv" / "bin" / "python3"
CAPTURE_PYTHON_CONFIG = os.environ.get("HP_CAPTURE_PYTHON_BIN", "").strip()
CAPTURE_PYTHON_BIN = resolve_app_executable(CAPTURE_PYTHON_CONFIG) or (
    str(DEFAULT_CAPTURE_PYTHON_BIN) if DEFAULT_CAPTURE_PYTHON_BIN.is_file() else sys.executable
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
