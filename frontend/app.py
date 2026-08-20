from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import signal
import shutil
import subprocess
import sys
import threading
import time
import zipfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlparse
from uuid import uuid4

LOCAL_DEPS = Path(__file__).resolve().parent / ".venv" / "deps"
if LOCAL_DEPS.is_dir():
    sys.path.insert(0, str(LOCAL_DEPS))

try:
    import qrcode
except ImportError:  # pragma: no cover - optional at runtime until deps are installed
    qrcode = None
DEFAULT_PLAN_SKILL = os.environ.get("HP_TMUX_PLAN_SKILL", "a2ui-pro")
SKIP_PIPELINE_QA = os.environ.get("HP_TMUX_SKIP_QA", "").strip().lower() in {"1", "true", "yes", "on"}
VISITOR_COOKIE_NAME = "harmony_pilot_visitor"
ROOT_SESSION_COOKIE_NAME = "harmony_pilot_root"
VISITOR_COOKIE_MAX_AGE_SEC = 365 * 24 * 60 * 60
ROOT_SESSION_MAX_AGE_SEC = 8 * 60 * 60
VISITOR_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
LOGIN_MAX_ATTEMPTS = 5
LOGIN_WINDOW_SEC = 10 * 60
LOGIN_ATTEMPTS: dict[str, list[float]] = {}
LOGIN_ATTEMPTS_LOCK = threading.Lock()
JSON_WRITE_LOCK = threading.RLock()
TMUX_SESSION_NAME_MAX_LENGTH = 48
from scan_install.config import (
    ALLOWED_MEDIA_EXTENSIONS,
    APP_ROOT,
    CAPTURE_POLL_INTERVAL_SEC,
    CAPTURE_PYTHON_BIN,
    CAPTURE_WAIT_TIMEOUT_SEC,
    DATA_DIR,
    DEFAULT_POLL_INTERVAL_MS,
    DEFAULT_VARIANT,
    EXPECTED_HAP_RELATIVE_PATH,
    EXPO_FAST_APP_ROOT,
    EXPO_FAST_ENV_FILE,
    EXPO_FAST_LAUNCHER,
    EXPO_FAST_ROOT,
    EXPO_PUBLIC_ORIGIN,
    EXPO_PUBLIC_SERVE_ENABLED,
    EXPO_PUBLIC_SERVE_HOST,
    EXPO_PUBLIC_SERVE_PORT,
    EXPO_PUBLIC_SERVE_STATE_PATH,
    HDC_CAPTURE_SCRIPT_PATH,
    HDC_CAPTURE_TARGET,
    HDC_DESKTOP_TARGET,
    HDC_DESKTOP_TARGETS,
    HDC_PHONE_TARGET,
    HDC_PHONE_TARGETS,
    HPACK_ENABLED,
    HPACK_PACKAGER_SCRIPT_PATH,
    HPACK_STATIC_ROOT,
    HPACK_WAIT_TIMEOUT_SEC,
    LOG_DIR,
    MEDIA_DIR,
    PROFILE_POOL_ISOLATE_WORKSPACE,
    PREVIEW_DEVICE_POOL_ROOT,
    PREVIEW_HIDDEN_GRACE_SECONDS,
    PREVIEW_IDLE_SECONDS,
    PREVIEW_LEASE_SECONDS,
    PREVIEW_MAX_SESSION_SECONDS,
    PREVIEW_WAIT_SECONDS,
    RUNS_DIR,
    TARGET_WORKSPACE,
    TMUX_RUNNER_PATH,
)
from scan_install.expo_gateway import (
    ExpoExportValidationError,
    ExpoGatewayError,
    ExpoPublicGateway,
)
from scan_install.hpack import (
    build_install_qr_content,
    build_install_store_url,
    content_type_for_path,
    hpack_manifest_path,
    load_hpack_manifest as _load_hpack_manifest,
    serve_hpack_static,
    summarize_hpack_events,
    wait_for_hap_and_package as _wait_for_hap_and_package,
)
from scan_install.live_preview import (
    LiveInputRateLimitError,
    LiveInputValidationError,
    LivePreviewError,
    LocalLivePreview,
)
try:
    from scan_install.webrtc_preview import WebRTCPreviewError, WebRTCPreviewManager
except ImportError:  # pragma: no cover - REST remains available without aiortc
    WebRTCPreviewError = RuntimeError  # type: ignore[assignment,misc]
    WebRTCPreviewManager = None  # type: ignore[assignment,misc]
from scan_install.profile_pool import (
    apply_signing_slot_to_record,
    build_signing_payload,
    build_tmux_env,
    get_signing_pool,
    maybe_release_signing_slot as _maybe_release_signing_slot,
    profile_pool_status_payload,
    release_signing_slot_for_record,
    signing_pool_status_payload,
)
from scan_install.time_utils import parse_iso, to_iso


LIVE_PREVIEW = LocalLivePreview(
    preferred_target=HDC_CAPTURE_TARGET,
)
LIVE_PREVIEW_LATENCY_LOG_PATH = LOG_DIR / "live-preview-latency.jsonl"
LIVE_PREVIEW_LOG_MAX_BYTES = 20 * 1024 * 1024
LIVE_PREVIEW_LOG_LOCK = threading.Lock()
WEBRTC_PREVIEW: Any = None
EXPO_TRACE_EVENT_LIMIT = 160
EXPO_TRACE_CACHE_LIMIT = 256
EXPO_TRACE_CACHE: dict[str, dict[str, Any]] = {}
EXPO_TRACE_CACHE_LOCK = threading.Lock()
EXPO_PUBLIC_GATEWAY = ExpoPublicGateway(
    enabled=EXPO_PUBLIC_SERVE_ENABLED,
    host=EXPO_PUBLIC_SERVE_HOST,
    port=EXPO_PUBLIC_SERVE_PORT,
    public_origin=EXPO_PUBLIC_ORIGIN,
    state_path=EXPO_PUBLIC_SERVE_STATE_PATH,
    allowed_root=EXPO_FAST_APP_ROOT,
)


def preview_server_timing(timings: dict[str, float | int]) -> str:
    metrics = []
    for name, value in timings.items():
        if not name.endswith("_ms") or isinstance(value, bool):
            continue
        metrics.append(f"{name[:-3].replace('_', '-')};dur={float(value):.3f}")
    return ", ".join(metrics)


def append_live_preview_log(payload: dict[str, Any]) -> None:
    try:
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with LIVE_PREVIEW_LOG_LOCK:
            if (
                LIVE_PREVIEW_LATENCY_LOG_PATH.is_file()
                and LIVE_PREVIEW_LATENCY_LOG_PATH.stat().st_size >= LIVE_PREVIEW_LOG_MAX_BYTES
            ):
                rotated_path = LIVE_PREVIEW_LATENCY_LOG_PATH.with_suffix(".jsonl.1")
                rotated_path.unlink(missing_ok=True)
                LIVE_PREVIEW_LATENCY_LOG_PATH.replace(rotated_path)
            with LIVE_PREVIEW_LATENCY_LOG_PATH.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
    except OSError:
        pass


def append_webrtc_preview_log(payload: dict[str, Any]) -> None:
    append_live_preview_log({"timestamp": to_iso(), **payload})


if WebRTCPreviewManager is not None:
    WEBRTC_PREVIEW = WebRTCPreviewManager(
        LIVE_PREVIEW,
        logger=append_webrtc_preview_log,
    )


def base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def base64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def root_auth_secret() -> bytes:
    return os.environ.get("HP_AUTH_SIGNING_SECRET", "").encode("utf-8")


def root_auth_enabled() -> bool:
    return bool(os.environ.get("HP_ROOT_PASSWORD_HASH", "").strip() and len(root_auth_secret()) >= 32)


def verify_root_password(password: str) -> bool:
    encoded = os.environ.get("HP_ROOT_PASSWORD_HASH", "").strip()
    try:
        algorithm, iterations, salt_text, digest_text = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        expected = base64url_decode(digest_text)
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt=base64url_decode(salt_text),
            iterations=int(iterations),
            dklen=len(expected),
        )
    except (TypeError, ValueError, UnicodeError):
        return False
    return hmac.compare_digest(actual, expected)


def create_root_session() -> str:
    payload = json.dumps(
        {"role": "root", "expires_at": int(time.time()) + ROOT_SESSION_MAX_AGE_SEC},
        separators=(",", ":"),
    ).encode("utf-8")
    encoded_payload = base64url_encode(payload)
    signature = hmac.new(root_auth_secret(), encoded_payload.encode("ascii"), hashlib.sha256).digest()
    return f"{encoded_payload}.{base64url_encode(signature)}"


def root_session_is_valid(value: str) -> bool:
    if not root_auth_enabled() or "." not in value:
        return False
    encoded_payload, encoded_signature = value.rsplit(".", 1)
    expected = hmac.new(root_auth_secret(), encoded_payload.encode("ascii"), hashlib.sha256).digest()
    try:
        signature = base64url_decode(encoded_signature)
        payload = json.loads(base64url_decode(encoded_payload).decode("utf-8"))
    except (ValueError, UnicodeError, json.JSONDecodeError):
        return False
    return (
        hmac.compare_digest(signature, expected)
        and isinstance(payload, dict)
        and payload.get("role") == "root"
        and int(payload.get("expires_at") or 0) > int(time.time())
    )


def login_is_limited(client_ip: str) -> bool:
    now = time.monotonic()
    with LOGIN_ATTEMPTS_LOCK:
        attempts = [item for item in LOGIN_ATTEMPTS.get(client_ip, []) if now - item < LOGIN_WINDOW_SEC]
        LOGIN_ATTEMPTS[client_ip] = attempts
        return len(attempts) >= LOGIN_MAX_ATTEMPTS


def record_failed_login(client_ip: str) -> None:
    now = time.monotonic()
    with LOGIN_ATTEMPTS_LOCK:
        attempts = [item for item in LOGIN_ATTEMPTS.get(client_ip, []) if now - item < LOGIN_WINDOW_SEC]
        attempts.append(now)
        LOGIN_ATTEMPTS[client_ip] = attempts


def clear_failed_logins(client_ip: str) -> None:
    with LOGIN_ATTEMPTS_LOCK:
        LOGIN_ATTEMPTS.pop(client_ip, None)


def safe_slug(value: str, fallback: str = "run") -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip().lower()).strip("-_")
    return slug[:TMUX_SESSION_NAME_MAX_LENGTH] or fallback


def build_tmux_session_name(run_id: str) -> str:
    """Build a short, stable runner name independent of user prompt text."""
    return f"hp-{run_id[:12]}"


def normalize_tmux_session_name(session_name: str) -> str:
    """Mirror tmux-runner's normalization for records created before the name fix."""
    normalized = re.sub(r"[^a-z0-9_-]+", "-", session_name.strip().lower()).strip("-")
    return normalized[:TMUX_SESSION_NAME_MAX_LENGTH].strip("-")


def relative_to_root(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.{uuid4().hex}.tmp")
    with JSON_WRITE_LOCK:
        try:
            temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def list_candidate_files(root: Path, suffixes: set[str]) -> list[Path]:
    if not root.exists():
        return []
    ignored = {".git", "node_modules", ".next", "dist", "build", "__pycache__"}
    results: list[Path] = []
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            entries = list(current.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.is_dir():
                if entry.name in ignored:
                    continue
                stack.append(entry)
                continue
            if entry.suffix.lower() in suffixes:
                results.append(entry)
    results.sort(key=lambda item: item.stat().st_mtime if item.exists() else 0, reverse=True)
    return results


def list_workspace_directories(root: Path, limit: int = 50) -> list[str]:
    if not root.is_dir():
        return []
    try:
        directories = sorted(
            entry.name for entry in root.iterdir() if entry.is_dir() and not entry.name.startswith(".")
        )
    except OSError:
        return []
    return directories[:limit]


def validate_workspace_cleanup_root(workspace: Path) -> None:
    workspace = workspace.expanduser().resolve()
    protected_paths = {Path("/"), Path.home().resolve(), APP_ROOT.resolve()}
    app_parent = APP_ROOT.resolve().parent
    while app_parent != app_parent.parent:
        protected_paths.add(app_parent)
        app_parent = app_parent.parent
    if TARGET_WORKSPACE.parts:
        target_root = TARGET_WORKSPACE.expanduser().resolve()
        protected_paths.add(target_root)
        parent = target_root.parent
        while parent != parent.parent:
            protected_paths.add(parent)
            parent = parent.parent
    if workspace in protected_paths:
        raise ValueError(f"拒绝清空受保护目录: {workspace}")
    if (workspace / ".git").exists():
        raise ValueError(f"拒绝清空 Git 仓库根目录: {workspace}")
    if len(workspace.parts) < 3:
        raise ValueError(f"拒绝清空路径层级过浅的目录: {workspace}")


def clear_workspace_contents(workspace: Path) -> None:
    validate_workspace_cleanup_root(workspace)
    if not workspace.exists():
        workspace.mkdir(parents=True, exist_ok=True)
        return
    if not workspace.is_dir():
        raise ValueError(f"目标工作目录不存在或不是文件夹: {workspace}")

    for entry in workspace.iterdir():
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink()


def iter_run_records() -> list[RunRecord]:
    records: list[RunRecord] = []
    for path in RUNS_DIR.glob("*.json"):
        payload = read_json(path)
        if not payload:
            continue
        try:
            records.append(RunRecord(**payload))
        except TypeError:
            continue
    return records


def stop_process_group_or_pid(pid: int | None, timeout_sec: float = 3.0) -> bool:
    if not pid:
        return True
    if not process_alive(pid):
        return True

    def send(sig: int) -> None:
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            return
        except OSError:
            os.kill(pid, sig)

    try:
        send(signal.SIGTERM)
    except (PermissionError, ProcessLookupError):
        return not process_alive(pid)
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        if not process_alive(pid):
            return True
        time.sleep(0.1)

    try:
        send(signal.SIGKILL)
    except (PermissionError, ProcessLookupError):
        return not process_alive(pid)
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if not process_alive(pid):
            return True
        time.sleep(0.1)
    return not process_alive(pid)


def stop_tmux_session(session_name: str) -> bool:
    if not session_name:
        return True
    try:
        result = subprocess.run(
            ["tmux", "kill-session", "-t", session_name],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return False
    return result.returncode == 0


def stop_existing_workspace_runs(workspace: Path) -> None:
    target_workspace = workspace.expanduser().resolve()
    failures: list[str] = []

    for record in iter_run_records():
        try:
            record_workspace = Path(record.workspace).expanduser().resolve()
        except OSError:
            continue
        if record_workspace != target_workspace:
            continue

        active_run = (
            record.status in {"queued", "running"}
            or record.capture_status in {"waiting_hap", "running"}
            or record.distribution_status in {"waiting_hap", "packaging"}
            or process_alive(record.process_pid)
            or process_alive(record.preview_refresh_process_pid)
            or process_alive(record.capture_process_pid)
            or process_alive(record.distribution_process_pid)
        )
        if not active_run:
            continue

        touched = False

        if record.capture_process_pid and process_alive(record.capture_process_pid):
            touched = True
            if stop_process_group_or_pid(record.capture_process_pid):
                pass
            else:
                failures.append(f"capture pid={record.capture_process_pid}")
            record.capture_process_pid = None
            if record.capture_status not in {"complete", "failed"}:
                record.capture_status = "failed"

        if record.process_pid and process_alive(record.process_pid):
            touched = True
            if stop_process_group_or_pid(record.process_pid):
                pass
            else:
                failures.append(f"tmux-runner pid={record.process_pid}")
            record.process_pid = None
            if record.status in {"queued", "running"}:
                record.status = "failed"

        if record.preview_refresh_process_pid and process_alive(record.preview_refresh_process_pid):
            touched = True
            if not stop_process_group_or_pid(record.preview_refresh_process_pid):
                failures.append(f"preview-refresh pid={record.preview_refresh_process_pid}")
            record.preview_refresh_process_pid = None
            if record.preview_refresh_status in {"queued", "building"}:
                record.preview_refresh_status = "failed"
                record.preview_refresh_error = "预览 HAP 后台构建已停止。"

        if record.distribution_process_pid and process_alive(record.distribution_process_pid):
            touched = True
            if stop_process_group_or_pid(record.distribution_process_pid):
                pass
            else:
                failures.append(f"hpack pid={record.distribution_process_pid}")
            record.distribution_process_pid = None
            if record.distribution_status not in {"ready", "failed", "disabled"}:
                record.distribution_status = "failed"

        if record.session_name:
            touched = stop_tmux_session(record.session_name) or touched

        if record.capture_status in {"waiting_hap", "running"}:
            touched = True
            record.capture_status = "failed"
        if record.distribution_status in {"waiting_hap", "packaging"}:
            touched = True
            record.distribution_status = "failed"
        if record.status in {"queued", "running"}:
            touched = True
            record.status = "failed"

        if touched:
            note = "检测到新的 Build 请求，已停止旧任务并准备清空工作目录。"
            if failures:
                note = f"{note} 停止过程中有失败项。"
            record.notes = note
            release_signing_slot_for_record(record)
            save_run(record)

    if failures:
        raise RuntimeError("；".join(failures))


def recent_threshold(created_at: str | None) -> datetime | None:
    timestamp = parse_iso(created_at)
    if not timestamp:
        return None
    return timestamp - timedelta(seconds=5)


def pick_recent_file(candidates: list[Path], created_at: str | None) -> Path | None:
    threshold = recent_threshold(created_at)
    if not threshold:
        return candidates[0] if candidates else None
    for candidate in candidates:
        try:
            modified_at = datetime.fromtimestamp(candidate.stat().st_mtime, tz=timezone.utc)
        except OSError:
            continue
        if modified_at >= threshold:
            return candidate
    return None


def extract_jsonl_text(entry: dict[str, Any]) -> str:
    message = entry.get("message", {})
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
        return "\n".join(part for part in parts if part)
    return ""


def is_assistant_entry(entry: dict[str, Any]) -> bool:
    if entry.get("type") == "assistant":
        return True
    message = entry.get("message", {})
    return message.get("role") == "assistant"


def extract_recent_transcript_events(transcript_path: Path, limit: int = 6) -> list[dict[str, Any]]:
    if not transcript_path.exists():
        return []
    events: list[dict[str, Any]] = []
    try:
        for raw_line in transcript_path.read_text(encoding="utf-8").splitlines():
            if not raw_line.strip():
                continue
            try:
                entry = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            if not is_assistant_entry(entry):
                continue
            text = extract_jsonl_text(entry).strip()
            if not text:
                continue
            text = re.sub(r"\s+", " ", text)
            events.append(
                {
                    "kind": "assistant",
                    "timestamp": entry.get("timestamp"),
                    "summary": text[:240],
                }
            )
    except OSError:
        return []
    return events[-limit:]


def extract_follow_up_trace_events(transcript_path: Path, limit: int = 60) -> list[dict[str, Any]]:
    """Return a safe, compact follow-up trace without exposing raw JSONL or tool inputs."""
    if not transcript_path.is_file():
        return []
    events: list[dict[str, Any]] = []
    try:
        with transcript_path.open(encoding="utf-8") as handle:
            for raw_line in handle:
                if not raw_line.strip():
                    continue
                try:
                    entry = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(entry, dict) or not is_assistant_entry(entry):
                    continue
                timestamp = str(entry.get("timestamp") or "")
                message = entry.get("message") if isinstance(entry.get("message"), dict) else {}
                content = message.get("content")
                if isinstance(content, str):
                    content = [{"type": "text", "text": content}]
                if not isinstance(content, list):
                    continue
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    item_type = str(item.get("type") or "")
                    if item_type == "text":
                        text = re.sub(r"\s+", " ", str(item.get("text") or "")).strip()
                        if text:
                            events.append({"kind": "assistant", "timestamp": timestamp, "summary": text[:800]})
    except OSError:
        return []
    return events[-limit:]


def load_follow_up_trace(follow_up: dict[str, Any]) -> list[dict[str, Any]]:
    """Resolve the trusted controller-provided path server-side; never send it to the browser."""
    transcript_path = str(follow_up.get("transcript_path") or "")
    return extract_follow_up_trace_events(Path(transcript_path)) if transcript_path else []


def redact_follow_up_transcript_path(follow_up: dict[str, Any]) -> dict[str, Any]:
    """The controller path is an implementation detail and must not reach the browser."""
    public = dict(follow_up)
    public.pop("transcript_path", None)
    return public


def redact_follow_up_response(response: dict[str, Any]) -> dict[str, Any]:
    public = dict(response)
    follow_up = public.get("follow_up")
    if isinstance(follow_up, dict):
        public["follow_up"] = redact_follow_up_transcript_path(follow_up)
    return public


def summarize_stage_history(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in history[-6:]:
        stage = str(item.get("stage") or "unknown")
        items.append(
            {
                "kind": "stage",
                "timestamp": item.get("at"),
                "summary": f"进入阶段: {stage}",
            }
        )
    return items


def summarize_compact_events(diagnostics: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not diagnostics:
        return []
    items: list[dict[str, Any]] = []
    for item in diagnostics.get("recent_events", [])[-6:]:
        stage = item.get("stage_id") or "unknown"
        source = item.get("source") or item.get("hook_event_name") or "compact"
        items.append(
            {
                "kind": "compact",
                "timestamp": item.get("compact_at"),
                "summary": f"{stage} 阶段发生 compact: {source}",
            }
        )
    return items


@dataclass
class RunRecord:
    run_id: str
    session_name: str
    prompt: str
    workspace: str
    variant: str
    created_at: str
    updated_at: str
    status: str = "queued"
    runtime: str = "arkpilot"
    plan_skill: str = DEFAULT_PLAN_SKILL
    interactive_questions: bool = False
    owner_id: str = ""
    share_token: str = ""
    process_pid: int | None = None
    command: list[str] = field(default_factory=list)
    capture_status: str = "waiting_hap"
    capture_process_pid: int | None = None
    capture_command: list[str] = field(default_factory=list)
    preview_targets: dict[str, str] = field(default_factory=dict)
    preview_sessions: dict[str, dict[str, Any]] = field(default_factory=dict)
    # 最近一次触发预览采集的 unsigned HAP 修改时间；用于续跑出新包后的重新采集。
    capture_hap_mtime: float = 0.0
    distribution_status: str = "waiting_hap"
    distribution_process_pid: int | None = None
    distribution_command: list[str] = field(default_factory=list)
    # 首版本扫码安装信息（首次签名成功时持久化，之后不再覆盖）
    first_install_url: str = ""
    first_install_store_url: str = ""
    first_manifest_url: str = ""
    first_ready_at: str = ""
    # Remote UI 成功提交的最近一次调整时间。即使控制器暂时不可用或服务重启，
    # 也能立即判定已有二维码过期，避免把首版本误显示为最新版本。
    latest_adjustment_at: str = ""
    # 当前正式 unsigned HAP 对应的最近一次调整。续跑后的 HAP 在独立临时目录
    # 构建，只有目标 revision 仍然最新时才会提升到 .expo-fast/hap。
    preview_source_adjustment_at: str = ""
    preview_refresh_target_at: str = ""
    preview_refresh_status: str = "idle"
    preview_refresh_process_pid: int | None = None
    preview_refresh_command: list[str] = field(default_factory=list)
    preview_refresh_error: str = ""
    # 最近一次签名任务启动时对应的调整版本。签名期间若又提交调整，
    # 即使新 manifest 完成时间更晚，也不能把该包误判为包含了新调整。
    package_source_adjustment_at: str = ""
    # 仅兼容旧 run JSON；新版续跑状态由各 Runtime 的 follow-up-control 管理。
    pending_follow_up_at: str = ""
    notes: str = ""
    prompt_file: str = ""
    expo_package_status: str = ""
    expo_package_updated_at: str = ""
    signing_slot_id: str = ""
    signing_bundle_name: str = ""
    signing_cert_path: str = ""
    signing_profile_path: str = ""
    signing_keystore_path: str = ""
    signing_alias: str = ""
    signing_leased_at: str = ""
    signing_released_at: str = ""

    @property
    def path(self) -> Path:
        return RUNS_DIR / f"{self.run_id}.json"


def load_run(run_id: str) -> RunRecord | None:
    payload = read_json(RUNS_DIR / f"{run_id}.json")
    return RunRecord(**payload) if payload else None


def save_run(record: RunRecord) -> RunRecord:
    record.updated_at = to_iso()
    write_json(record.path, asdict(record))
    return record


PREVIEW_KINDS = ("desktop", "phone")
PHONE_PREVIEW_IN_FLIGHT: set[str] = set()
PHONE_PREVIEW_LOCK = threading.Lock()
PHONE_PREVIEW_HEARTBEATS: dict[str, threading.Event] = {}
PHONE_PREVIEW_CANCELLED: set[str] = set()
PHONE_PREVIEW_MONITORS_IN_FLIGHT: set[str] = set()
DESKTOP_PREVIEW_IN_FLIGHT: set[str] = set()
DESKTOP_PREVIEW_LOCK = threading.Lock()
DESKTOP_PREVIEW_CANCELLED: set[str] = set()
PREVIEW_VIEWERS: dict[str, dict[str, float]] = {}
PREVIEW_VIEWERS_LOCK = threading.Lock()
PREVIEW_DEVICE_PROBE_TIMEOUT_SEC = 3


def preview_policy(record: RunRecord) -> dict[str, Any]:
    if getattr(record, "runtime", "arkpilot") == "expo":
        return {
            "default_kind": "desktop",
            "previews": {
                # PC and phone previews both install the generated HAP.  The
                # install links in the distribution panel are independent of
                # this policy and remain unchanged.
                "desktop": {"enabled": True, "transport": "hap_install", "start_mode": "automatic"},
                "phone": {"enabled": True, "transport": "hap_install", "start_mode": "on_demand"},
            },
        }
    return {
        "default_kind": "phone",
        "previews": {
            "phone": {"enabled": True, "transport": "hap_install", "start_mode": "automatic"},
        },
    }


def preview_session_defaults(record: RunRecord, kind: str) -> dict[str, Any]:
    config = preview_policy(record)["previews"].get(kind, {})
    return {
        "kind": kind,
        "transport": str(config.get("transport") or ""),
        "requested": False,
        "status": "idle",
        "target": "",
        "lease_id": "",
        "artifact_path": "",
        "artifact_digest": "",
        "bundle_name": "",
        "ability_name": "EntryAbility",
        "screenshot_path": "",
        "live_available": False,
        "error": "",
        "updated_at": getattr(record, "updated_at", getattr(record, "created_at", "")),
    }


def preview_sessions_payload(record: RunRecord) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    stored_sessions = getattr(record, "preview_sessions", None) or {}
    for kind in preview_policy(record)["previews"]:
        result[kind] = {**preview_session_defaults(record, kind), **stored_sessions.get(kind, {})}
        # Stored sessions from the previous PC shell implementation must adopt
        # the current policy when an existing task is reopened.
        result[kind]["transport"] = preview_session_defaults(record, kind)["transport"]
        lease = read_json(preview_lease_path(str(result[kind].get("target") or ""))) if result[kind].get("target") else None
        lease_current = bool(
            result[kind].get("lease_id")
            and lease
            and lease.get("lease_id") == result[kind].get("lease_id")
            and preview_lease_valid(lease)
        )
        status = str(result[kind].get("status") or "")
        worker_active = record.run_id in (
            DESKTOP_PREVIEW_IN_FLIGHT if kind == "desktop" else PHONE_PREVIEW_IN_FLIGHT
        )
        if status in {"queued", "allocating", "installing", "loading_bundle", "launching"} and not (
            worker_active or lease_current
        ):
            result[kind]["status"] = "released"
            result[kind]["live_available"] = False
        if result[kind]["status"] == "ready" and result[kind].get("live_available") and not lease_current:
            result[kind]["status"] = "released"
            result[kind]["live_available"] = False
    return result


def preview_sessions_api_payload(record: RunRecord) -> dict[str, dict[str, Any]]:
    sessions = preview_sessions_payload(record)
    source_outdated = expo_preview_source_outdated(record)
    hap_result = load_expo_hap_result(Path(record.workspace)) if record.runtime == "expo" else None
    current_digest = (
        str((hap_result or {}).get("hapSha256") or "")
        if record.runtime == "expo" and resolve_expo_hap_artifact(Path(record.workspace), hap_result)
        else ""
    )
    for kind, session in sessions.items():
        installed_digest = str(session.get("artifact_digest") or "")
        installed_outdated = bool(installed_digest and current_digest and installed_digest != current_digest)
        session["outdated"] = bool(source_outdated or installed_outdated)
        session["refresh_available"] = bool(
            kind == "phone" and installed_outdated and not source_outdated
        )
        session["refresh_status"] = str(record.preview_refresh_status or "idle")
        session["refresh_error"] = str(record.preview_refresh_error or "")
        has_screenshot = bool(session.get("screenshot_path"))
        session["screenshot_url"] = (
            f"/api/runs/{record.run_id}/media?preview={kind}" if has_screenshot else ""
        )
        session["screenshot_path"] = session["screenshot_url"]
        session["artifact_path"] = ""
    return sessions


def update_preview_session(record: RunRecord, kind: str, **changes: Any) -> RunRecord:
    sessions = dict(record.preview_sessions or {})
    current = {**preview_session_defaults(record, kind), **sessions.get(kind, {}), **changes, "updated_at": to_iso()}
    sessions[kind] = current
    record.preview_sessions = sessions
    if current.get("target"):
        record.preview_targets = {**(record.preview_targets or {}), kind: str(current["target"])}
    return save_run(record)


def configured_preview_targets() -> dict[str, str]:
    return {
        kind: target
        for kind, target in (("desktop", HDC_DESKTOP_TARGET), ("phone", HDC_PHONE_TARGET))
        if target
    }


def configured_preview_target_pools() -> dict[str, list[str]]:
    return {
        "desktop": list(HDC_DESKTOP_TARGETS),
        "phone": list(HDC_PHONE_TARGETS),
    }


def preview_targets_for_record(record: RunRecord) -> dict[str, str]:
    kinds = preview_policy(record)["previews"]
    targets = {kind: "" for kind in kinds}
    targets.update(
        {
            kind: str(target).strip()
            for kind, target in (record.preview_targets or {}).items()
            if kind in kinds and str(target).strip()
        }
    )
    if record.runtime == "expo":
        launch_state = read_json(Path(record.workspace) / ".expo-fast" / "launch-previews.json") or {}
        previews = launch_state.get("previews") if isinstance(launch_state.get("previews"), dict) else {}
        for kind, entry in previews.items():
            if kind in kinds and isinstance(entry, dict) and not targets[kind]:
                targets[kind] = str(entry.get("target") or "").strip()
    elif not targets.get("phone") and HDC_CAPTURE_TARGET:
        targets["phone"] = HDC_CAPTURE_TARGET
    return targets


def normalize_preview_kind(record: RunRecord, requested: str = "") -> str:
    kinds = preview_policy(record)["previews"]
    candidate = requested.strip().lower()
    if candidate in kinds:
        return candidate
    return str(preview_policy(record)["default_kind"])


def live_preview_session_id(record: RunRecord, preview_kind: str) -> str:
    if not record.preview_sessions and len(preview_policy(record)["previews"]) == 1:
        return record.run_id
    return f"{record.run_id}:{preview_kind}"


def bind_live_preview_target(record: RunRecord, preview_kind: str) -> str:
    session_id = live_preview_session_id(record, preview_kind)
    target = preview_targets_for_record(record).get(preview_kind, "")
    binder = getattr(LIVE_PREVIEW, "bind_target", None)
    if target and callable(binder):
        binder(session_id, target, preview_kind=preview_kind)
    return session_id


def preview_viewer_key(run_id: str, kind: str) -> str:
    return f"{run_id}:{kind}"


def mark_preview_viewer(run_id: str, kind: str, *, visible: bool) -> None:
    now = time.monotonic()
    key = preview_viewer_key(run_id, kind)
    with PREVIEW_VIEWERS_LOCK:
        state = PREVIEW_VIEWERS.setdefault(key, {})
        if visible:
            state["last_seen_at"] = now
            state["hidden_since"] = 0.0
        else:
            state.setdefault("last_seen_at", now)
            if not state.get("hidden_since"):
                state["hidden_since"] = now


def start_preview_viewer_session(run_id: str, kind: str) -> None:
    now = time.monotonic()
    key = preview_viewer_key(run_id, kind)
    with PREVIEW_VIEWERS_LOCK:
        state = PREVIEW_VIEWERS.setdefault(key, {})
        state.setdefault("last_seen_at", now)
        state["lease_started_at"] = now


def preview_viewer_release_reason(run_id: str, kind: str, *, now: float | None = None) -> str:
    checked_at = time.monotonic() if now is None else now
    key = preview_viewer_key(run_id, kind)
    with PREVIEW_VIEWERS_LOCK:
        state = dict(PREVIEW_VIEWERS.get(key) or {})
    lease_started_at = float(state.get("lease_started_at") or 0.0)
    hidden_since = float(state.get("hidden_since") or 0.0)
    last_seen_at = float(state.get("last_seen_at") or lease_started_at or 0.0)
    if lease_started_at and checked_at - lease_started_at >= PREVIEW_MAX_SESSION_SECONDS:
        return "max_session"
    if hidden_since and checked_at - hidden_since >= PREVIEW_HIDDEN_GRACE_SECONDS:
        return "hidden"
    if last_seen_at and checked_at - last_seen_at >= PREVIEW_IDLE_SECONDS:
        return "viewer_timeout"
    return ""


def clear_preview_viewer(run_id: str, kind: str) -> None:
    with PREVIEW_VIEWERS_LOCK:
        PREVIEW_VIEWERS.pop(preview_viewer_key(run_id, kind), None)


def safe_preview_target(target: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", target)


def preview_lease_path(target: str) -> Path:
    return PREVIEW_DEVICE_POOL_ROOT / "leases" / f"{safe_preview_target(target)}.json"


def preview_process_alive(pid: Any) -> bool:
    try:
        value = int(pid)
        if value <= 0:
            return False
        os.kill(value, 0)
        return True
    except (TypeError, ValueError, ProcessLookupError):
        return False
    except PermissionError:
        return True


def preview_queue_names(kind: str, *, priority: str) -> list[str]:
    queue_root = PREVIEW_DEVICE_POOL_ROOT / "queue"
    queue_root.mkdir(parents=True, exist_ok=True)
    names: list[str] = []
    now = datetime.now(timezone.utc)
    for path in queue_root.glob("*.json"):
        ticket = read_json(path)
        expires_at = parse_iso(str((ticket or {}).get("expires_at") or ""))
        if not ticket or not preview_process_alive(ticket.get("pid")) or (expires_at and expires_at <= now):
            path.unlink(missing_ok=True)
            continue
        ticket_priority = str(ticket.get("priority") or "build")
        if str(ticket.get("kind") or "") == kind and ticket_priority == priority:
            names.append(path.name)
    return sorted(names)


def create_live_preview_ticket(run_id: str, kind: str, wait_seconds: int) -> Path:
    now = datetime.now(timezone.utc)
    name = f"live-{time.time_ns():020d}-{os.getpid():010d}-{run_id}-{uuid4().hex}.json"
    path = PREVIEW_DEVICE_POOL_ROOT / "queue" / name
    write_json_atomic(path, {
        "schema_version": 1,
        "run_id": run_id,
        "pid": os.getpid(),
        "kind": kind,
        "priority": "live",
        "queued_at": now.isoformat(),
        "expires_at": (now + timedelta(seconds=max(1, wait_seconds) + 30)).isoformat(),
    })
    return path


def preview_lease_valid(payload: dict[str, Any] | None) -> bool:
    if not payload or not preview_process_alive(payload.get("pid")):
        return False
    expires_at = parse_iso(str(payload.get("expires_at") or ""))
    return bool(expires_at and expires_at > datetime.now(timezone.utc))


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.{uuid4().hex}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def with_preview_allocator_lock(action: Any) -> Any:
    PREVIEW_DEVICE_POOL_ROOT.mkdir(parents=True, exist_ok=True)
    for name in ("queue", "leases", "quarantine"):
        (PREVIEW_DEVICE_POOL_ROOT / name).mkdir(exist_ok=True)
    lock_path = PREVIEW_DEVICE_POOL_ROOT / ".allocator-lock"
    deadline = time.monotonic() + 30
    while True:
        try:
            lock_path.mkdir()
            break
        except FileExistsError:
            try:
                if time.time() - lock_path.stat().st_mtime > 30:
                    shutil.rmtree(lock_path)
                    continue
            except OSError:
                pass
            if time.monotonic() >= deadline:
                raise LivePreviewError("等待模拟器资源锁超时。")
            time.sleep(0.1)
    try:
        return action()
    finally:
        shutil.rmtree(lock_path, ignore_errors=True)


def connected_hdc_targets() -> list[str]:
    hdc_bin = LIVE_PREVIEW._resolve_hdc_bin()
    result = subprocess.run(
        [hdc_bin, "list", "targets"], capture_output=True, text=True, check=False, timeout=10
    )
    if result.returncode != 0:
        raise LivePreviewError("无法读取 HarmonyOS 设备列表。")
    return list(dict.fromkeys(
        item.strip()
        for item in re.split(r"\s+", result.stdout)
        if item.strip() and item.strip() != "[Empty]"
    ))


def discover_preview_targets(kind: str) -> list[str]:
    hdc_bin = LIVE_PREVIEW._resolve_hdc_bin()
    discovered: list[str] = []
    for target in connected_hdc_targets():
        try:
            result = subprocess.run(
                [hdc_bin, "-t", target, "shell", "param", "get", "const.product.devicetype"],
                capture_output=True,
                text=True,
                check=False,
                timeout=PREVIEW_DEVICE_PROBE_TIMEOUT_SEC,
            )
        except (OSError, subprocess.TimeoutExpired):
            # One busy or unhealthy emulator must not prevent another matching
            # target from serving the preview request.
            continue
        if result.returncode != 0:
            continue
        device_type = f"{result.stdout} {result.stderr}".strip().lower()
        if kind == "phone" and re.search(r"phone|mobile", device_type):
            discovered.append(target)
        elif kind == "desktop" and re.search(r"2in1|tablet|pc|desktop", device_type):
            discovered.append(target)
    preferred = configured_preview_target_pools().get(kind, [])
    return list(dict.fromkeys([target for target in preferred if target in discovered] + discovered))


def acquire_preview_lease(run_id: str, kind: str, *, wait_seconds: int = PREVIEW_WAIT_SECONDS) -> dict[str, Any]:
    deadline = time.monotonic() + max(1, wait_seconds)
    ticket_path = create_live_preview_ticket(run_id, kind, wait_seconds)
    try:
        while time.monotonic() < deadline:
            candidates = discover_preview_targets(kind)

            def allocate() -> dict[str, Any] | None:
                if preview_queue_names(kind, priority="build"):
                    return None
                live_queue = preview_queue_names(kind, priority="live")
                if not live_queue or live_queue[0] != ticket_path.name:
                    return None
                now = datetime.now(timezone.utc)
                for target in candidates:
                    path = preview_lease_path(target)
                    current = read_json(path)
                    if current and preview_lease_valid(current):
                        continue
                    path.unlink(missing_ok=True)
                    quarantine = read_json(PREVIEW_DEVICE_POOL_ROOT / "quarantine" / path.name)
                    quarantine_until = parse_iso(str((quarantine or {}).get("expires_at") or ""))
                    if quarantine_until and quarantine_until > now:
                        continue
                    lease_id = uuid4().hex
                    payload = {
                        "schema_version": 1,
                        "lease_id": lease_id,
                        "run_id": run_id,
                        "pid": os.getpid(),
                        "target": target,
                        "kind": kind,
                        "leased_at": to_iso(),
                        "heartbeat_at": to_iso(),
                        "expires_at": (now + timedelta(seconds=PREVIEW_LEASE_SECONDS)).isoformat(),
                    }
                    write_json_atomic(path, payload)
                    ticket_path.unlink(missing_ok=True)
                    return payload
                return None

            lease = with_preview_allocator_lock(allocate)
            if lease:
                return lease
            time.sleep(1)
        raise LivePreviewError(f"等待可用的{('手机' if kind == 'phone' else '桌面')}模拟器超时。")
    finally:
        ticket_path.unlink(missing_ok=True)


def start_preview_lease_heartbeat(record_id: str, kind: str, lease_id: str, target: str) -> None:
    key = f"{record_id}:{kind}"
    previous = PHONE_PREVIEW_HEARTBEATS.pop(key, None)
    if previous:
        previous.set()
    stop = threading.Event()
    PHONE_PREVIEW_HEARTBEATS[key] = stop
    start_preview_viewer_session(record_id, kind)

    def heartbeat() -> None:
        refresh_interval = max(5.0, PREVIEW_LEASE_SECONDS / 3)
        next_refresh_at = time.monotonic() + refresh_interval
        while not stop.wait(5):
            try:
                record = load_run(record_id)
                session = (record.preview_sessions or {}).get(kind, {}) if record else {}
                release_reason = preview_viewer_release_reason(record_id, kind)
                if record and session.get("status") in {
                    "installing", "loading_bundle", "launching", "ready"
                } and release_reason:
                    release_preview_lease(record, kind)
                    return
            except (OSError, LivePreviewError):
                pass

            if time.monotonic() < next_refresh_at:
                continue
            next_refresh_at = time.monotonic() + refresh_interval

            def refresh() -> None:
                path = preview_lease_path(target)
                current = read_json(path)
                if not current or current.get("lease_id") != lease_id:
                    stop.set()
                    return
                now = datetime.now(timezone.utc)
                current.update(
                    heartbeat_at=to_iso(),
                    expires_at=(now + timedelta(seconds=PREVIEW_LEASE_SECONDS)).isoformat(),
                )
                write_json_atomic(path, current)
            try:
                with_preview_allocator_lock(refresh)
            except (OSError, LivePreviewError):
                continue

    threading.Thread(target=heartbeat, name=f"preview-lease-{record_id[:8]}-{kind}", daemon=True).start()


def release_preview_lease(record: RunRecord, kind: str) -> RunRecord:
    if kind == "phone":
        PHONE_PREVIEW_CANCELLED.add(record.run_id)
    elif kind == "desktop":
        DESKTOP_PREVIEW_CANCELLED.add(record.run_id)
    session = preview_sessions_payload(record).get(kind, {})
    lease_id = str(session.get("lease_id") or "")
    target = str(session.get("target") or "")
    stop = PHONE_PREVIEW_HEARTBEATS.pop(f"{record.run_id}:{kind}", None)
    if stop:
        stop.set()
    clear_preview_viewer(record.run_id, kind)
    if lease_id and target:
        def release() -> None:
            path = preview_lease_path(target)
            current = read_json(path)
            if current and current.get("lease_id") == lease_id:
                path.unlink(missing_ok=True)
        with_preview_allocator_lock(release)
    releaser = getattr(LIVE_PREVIEW, "release_session", None)
    if callable(releaser):
        releaser(live_preview_session_id(record, kind))
    targets = dict(record.preview_targets or {})
    targets.pop(kind, None)
    record.preview_targets = targets
    return update_preview_session(
        record,
        kind,
        status="released",
        lease_id="",
        target="",
        live_available=False,
        error="",
    )


def preempt_owner_preview_leases(record: RunRecord, kind: str) -> list[str]:
    owner_id = str(record.owner_id or "").strip()
    if not owner_id:
        return []
    released: list[str] = []
    active_statuses = {"queued", "allocating", "installing", "loading_bundle", "launching", "ready"}
    for candidate in iter_run_records():
        if candidate.run_id == record.run_id or candidate.owner_id != owner_id:
            continue
        session = preview_sessions_payload(candidate).get(kind, {})
        if str(session.get("status") or "") not in active_statuses and not (
            session.get("target") or session.get("lease_id")
        ):
            continue
        release_preview_lease(candidate, kind)
        released.append(candidate.run_id)
    return released


def preview_hap_artifact(record: RunRecord) -> Path | None:
    workspace = Path(record.workspace)
    local_hap = resolve_expo_hap_artifact(workspace) if record.runtime == "expo" else find_latest_hap(workspace)
    if local_hap and local_hap.is_file():
        # HDC preview devices accept the local development HAP directly.  Do not
        # replace it with an internal-testing distribution HAP: that package can
        # install successfully but is blocked by HarmonyOS online verification.
        return local_hap.resolve()
    manifest = load_hpack_manifest(record.run_id)
    signed = Path(str((manifest or {}).get("signed_hap_path") or "")).expanduser()
    if signed.is_file():
        return signed.resolve()
    return None


def preview_hap_metadata(record: RunRecord, hap_path: Path) -> tuple[str, str]:
    bundle_name = record.signing_bundle_name
    ability_name = "EntryAbility"
    try:
        with zipfile.ZipFile(hap_path) as archive:
            module = json.loads(archive.read("module.json").decode("utf-8"))
        bundle_name = bundle_name or str((module.get("app") or {}).get("bundleName") or "")
        module_data = module.get("module") or {}
        abilities = module_data.get("abilities") or []
        if abilities and isinstance(abilities[0], dict):
            ability_name = str(abilities[0].get("name") or ability_name)
    except (OSError, KeyError, zipfile.BadZipFile, json.JSONDecodeError):
        pass
    if not bundle_name:
        app_config = Path(record.workspace) / "AppScope" / "app.json5"
        if app_config.is_file():
            match = re.search(r'"bundleName"\s*:\s*"([^"]+)"', app_config.read_text(encoding="utf-8"))
            bundle_name = match.group(1) if match else ""
    return bundle_name, ability_name


def run_phone_preview(record_id: str) -> None:
    lease: dict[str, Any] | None = None
    try:
        record = load_run(record_id)
        if not record:
            return
        hap_path = preview_hap_artifact(record)
        if not hap_path:
            raise LivePreviewError("当前任务还没有可安装的 HAP。")
        digest = hashlib.sha256(hap_path.read_bytes()).hexdigest()
        bundle_name, ability_name = preview_hap_metadata(record, hap_path)
        record = update_preview_session(
            record, "phone", requested=True, status="allocating", artifact_path=str(hap_path),
            artifact_digest=digest, bundle_name=bundle_name, ability_name=ability_name, error="",
        )
        lease = acquire_preview_lease(record.run_id, "phone")
        record = load_run(record_id) or record
        record = update_preview_session(
            record, "phone", status="installing", target=lease["target"], lease_id=lease["lease_id"]
        )
        if record_id in PHONE_PREVIEW_CANCELLED:
            release_preview_lease(record, "phone")
            return
        start_preview_lease_heartbeat(record.run_id, "phone", lease["lease_id"], lease["target"])
        session_id = live_preview_session_id(record, "phone")
        LIVE_PREVIEW.bind_target(session_id, lease["target"], preview_kind="phone")
        frame = LIVE_PREVIEW.install_and_launch(
            session_id, hap_path=hap_path, bundle_name=bundle_name, ability_name=ability_name
        )
        if record_id in PHONE_PREVIEW_CANCELLED:
            record = load_run(record_id) or record
            release_preview_lease(record, "phone")
            return
        screenshot_path = MEDIA_DIR / record.run_id / "preview-phone.jpeg"
        screenshot_path.parent.mkdir(parents=True, exist_ok=True)
        screenshot_path.write_bytes(frame.data)
        record = load_run(record_id) or record
        update_preview_session(
            record, "phone", status="ready", screenshot_path=str(screenshot_path),
            live_available=True, error="",
        )
    except Exception as exc:
        record = load_run(record_id)
        if record:
            if lease:
                record = release_preview_lease(record, "phone")
            update_preview_session(record, "phone", status="failed", live_available=False, error=str(exc))
    finally:
        with PHONE_PREVIEW_LOCK:
            PHONE_PREVIEW_IN_FLIGHT.discard(record_id)


def start_phone_preview(record: RunRecord, *, automatic: bool = False) -> tuple[RunRecord, bool]:
    current = preview_sessions_payload(record)["phone"]
    if current.get("status") in {"queued", "allocating", "installing", "launching"}:
        return record, False
    if record.runtime == "expo" and expo_preview_source_outdated(record):
        if automatic:
            return record, False
        raise LivePreviewError("最新修改的 HAP 正在构建，请完成后再刷新手机预览。")
    hap_path = preview_hap_artifact(record)
    if not hap_path:
        if automatic:
            return record, False
        raise LivePreviewError("当前任务还没有可安装的 HAP。")
    digest = hashlib.sha256(hap_path.read_bytes()).hexdigest()
    if current.get("status") == "ready" and current.get("artifact_digest") == digest and current.get("live_available"):
        return record, False
    with PHONE_PREVIEW_LOCK:
        if record.run_id in PHONE_PREVIEW_IN_FLIGHT:
            return record, False
        PHONE_PREVIEW_CANCELLED.discard(record.run_id)
        PHONE_PREVIEW_IN_FLIGHT.add(record.run_id)
    record = update_preview_session(record, "phone", requested=True, status="queued", error="")
    threading.Thread(target=run_phone_preview, args=(record.run_id,), daemon=True).start()
    return record, True


def run_desktop_preview(record_id: str) -> None:
    lease: dict[str, Any] | None = None
    try:
        record = load_run(record_id)
        if not record:
            return
        hap_path = preview_hap_artifact(record)
        if not hap_path:
            raise LivePreviewError("当前任务还没有可安装的 HAP。")
        digest = hashlib.sha256(hap_path.read_bytes()).hexdigest()
        bundle_name, ability_name = preview_hap_metadata(record, hap_path)
        record = update_preview_session(
            record,
            "desktop",
            requested=True,
            status="allocating",
            artifact_path=str(hap_path),
            artifact_digest=digest,
            bundle_name=bundle_name,
            ability_name=ability_name,
            error="",
        )
        lease = acquire_preview_lease(record.run_id, "desktop")
        record = load_run(record_id) or record
        record = update_preview_session(
            record,
            "desktop",
            status="installing",
            target=lease["target"],
            lease_id=lease["lease_id"],
        )
        if record_id in DESKTOP_PREVIEW_CANCELLED:
            release_preview_lease(record, "desktop")
            return
        start_preview_lease_heartbeat(record.run_id, "desktop", lease["lease_id"], lease["target"])
        session_id = live_preview_session_id(record, "desktop")
        LIVE_PREVIEW.bind_target(session_id, lease["target"], preview_kind="desktop")
        frame = LIVE_PREVIEW.install_and_launch(
            session_id,
            hap_path=hap_path,
            bundle_name=bundle_name,
            ability_name=ability_name,
        )
        if record_id in DESKTOP_PREVIEW_CANCELLED:
            record = load_run(record_id) or record
            release_preview_lease(record, "desktop")
            return
        screenshot_path = MEDIA_DIR / record.run_id / "preview-desktop.jpeg"
        screenshot_path.parent.mkdir(parents=True, exist_ok=True)
        screenshot_path.write_bytes(frame.data)
        record = load_run(record_id) or record
        update_preview_session(
            record,
            "desktop",
            status="ready",
            artifact_digest=digest,
            screenshot_path=str(screenshot_path),
            live_available=True,
            error="",
        )
    except Exception as exc:
        record = load_run(record_id)
        if record:
            if record_id in DESKTOP_PREVIEW_CANCELLED:
                if lease:
                    release_preview_lease(record, "desktop")
                return
            if lease:
                record = release_preview_lease(record, "desktop")
            update_preview_session(
                record,
                "desktop",
                status="failed",
                live_available=False,
                error=str(exc) or "PC 实时预览启动失败。",
            )
    finally:
        with DESKTOP_PREVIEW_LOCK:
            DESKTOP_PREVIEW_IN_FLIGHT.discard(record_id)


def start_desktop_preview(record: RunRecord, *, automatic: bool = False) -> tuple[RunRecord, bool]:
    current = preview_sessions_payload(record)["desktop"]
    if record.runtime == "expo" and expo_preview_source_outdated(record):
        if automatic:
            return record, False
        raise LivePreviewError("最新修改的 HAP 正在构建，请完成后再刷新 PC 预览。")
    current_status = str(current.get("status") or "").strip().lower()
    if current_status in {"queued", "allocating", "installing", "loading_bundle", "launching"}:
        # A daemon preview worker can disappear during a backend restart or an
        # unexpected exception. Recover only sessions that never acquired a
        # target/lease; an active leased worker remains authoritative.
        with DESKTOP_PREVIEW_LOCK:
            if record.run_id in DESKTOP_PREVIEW_IN_FLIGHT:
                return record, False
            current = preview_sessions_payload(record)["desktop"]
            current_status = str(current.get("status") or "").strip().lower()
            if current_status in {"queued", "allocating"} and not (
                str(current.get("target") or "").strip()
                or str(current.get("lease_id") or "").strip()
            ):
                record = update_preview_session(
                    record,
                    "desktop",
                    status="idle",
                    requested=False,
                    target="",
                    lease_id="",
                    live_available=False,
                    error="桌面预览会话已失联，正在重新连接。",
                )
            else:
                return record, False
    try:
        hap_path = preview_hap_artifact(record)
        if not hap_path:
            raise LivePreviewError("当前任务还没有可安装的 HAP。")
        digest = hashlib.sha256(hap_path.read_bytes()).hexdigest()
    except LivePreviewError:
        if automatic:
            return record, False
        raise
    if current.get("status") == "ready" and current.get("artifact_digest") == digest and current.get("live_available"):
        return record, False
    if current.get("lease_id") or current.get("target"):
        record = release_preview_lease(record, "desktop")
    with DESKTOP_PREVIEW_LOCK:
        if record.run_id in DESKTOP_PREVIEW_IN_FLIGHT:
            return record, False
        DESKTOP_PREVIEW_CANCELLED.discard(record.run_id)
        DESKTOP_PREVIEW_IN_FLIGHT.add(record.run_id)
    record = update_preview_session(record, "desktop", requested=True, status="queued", error="")
    threading.Thread(target=run_desktop_preview, args=(record.run_id,), daemon=True).start()
    return record, True


def maybe_refresh_desktop_preview(record: RunRecord, run_status: str) -> tuple[RunRecord, bool]:
    if record.runtime != "expo" or run_status != "completed":
        return record, False
    current = preview_sessions_payload(record)["desktop"]
    if not (current.get("requested") or current.get("screenshot_path")):
        return record, False
    return start_desktop_preview(record, automatic=True)


def monitor_hap_for_phone_preview(record_id: str) -> None:
    try:
        started_at = time.monotonic()
        while time.monotonic() - started_at < CAPTURE_WAIT_TIMEOUT_SEC:
            record = load_run(record_id)
            if not record:
                return
            if preview_sessions_payload(record)["phone"].get("status") != "idle":
                return
            if preview_hap_artifact(record):
                start_phone_preview(record, automatic=True)
                return
            time.sleep(CAPTURE_POLL_INTERVAL_SEC)
    finally:
        with PHONE_PREVIEW_LOCK:
            PHONE_PREVIEW_MONITORS_IN_FLIGHT.discard(record_id)


def start_phone_preview_monitor(record: RunRecord) -> bool:
    with PHONE_PREVIEW_LOCK:
        if record.run_id in PHONE_PREVIEW_MONITORS_IN_FLIGHT:
            return False
        PHONE_PREVIEW_MONITORS_IN_FLIGHT.add(record.run_id)
    threading.Thread(target=monitor_hap_for_phone_preview, args=(record.run_id,), daemon=True).start()
    return True


def build_tmux_command(record: RunRecord) -> list[str]:
    command = [
        "node",
        str(TMUX_RUNNER_PATH),
        "--cwd",
        record.workspace,
        "--session",
        record.session_name,
        "--variant",
        record.variant,
    ]
    if record.plan_skill:
        command.extend(["--plan-skill", record.plan_skill])
    # 本地续跑联调可跳过 UI/core-flow QA；默认关闭，不影响常规生成任务。
    if SKIP_PIPELINE_QA:
        command.extend(["--no-ui-qa", "--no-core-flow-qa"])
    command.append(record.prompt)
    return command


def build_expo_fast_command(
    record: RunRecord,
    *,
    action: str = "initial",
    launch: bool | None = None,
    hap: bool | None = None,
) -> list[str]:
    if EXPO_FAST_LAUNCHER is None:
        return []
    if action not in {"initial", "rebuild", "preview"}:
        raise ValueError(f"unsupported Expo Fast action: {action}")
    launch_enabled = True if launch is None else launch
    hap_enabled = action != "preview" if hap is None else hap
    command = [
        str(EXPO_FAST_LAUNCHER),
        "--project",
        record.workspace,
        "--prompt-file",
        record.prompt_file,
        "--session",
        record.session_name,
        "--hap",
        str(hap_enabled).lower(),
        "--launch",
        str(launch_enabled).lower(),
    ]
    if action == "rebuild":
        command.append("--rebuild")
    elif action == "preview":
        command.append("--preview-only")
    return command


def build_expo_fast_env(record: RunRecord) -> dict[str, str]:
    env = os.environ.copy()
    if EXPO_FAST_ENV_FILE is not None:
        env["EXPO_FAST_ENV_FILE"] = str(EXPO_FAST_ENV_FILE)
    if record.signing_bundle_name:
        env["EXPO_FAST_BUNDLE_IDENTIFIER"] = record.signing_bundle_name
    else:
        env.pop("EXPO_FAST_BUNDLE_IDENTIFIER", None)
    env["EXPO_FAST_VERSION_CODE"] = str(int(datetime.now(timezone.utc).timestamp()))
    return env


def expo_fast_state_path(workspace: Path) -> Path:
    return workspace / ".expo-fast" / "state.json"


def load_expo_fast_state(workspace: Path) -> dict[str, Any] | None:
    return read_json(expo_fast_state_path(workspace))


def expo_fast_run_status(record: RunRecord, state: dict[str, Any] | None) -> str:
    state_name = str((state or {}).get("state") or "").strip().lower()
    if state_name == "completed":
        return "completed"
    if state_name == "failed":
        return "failed"
    if record.status in {"failed", "error"}:
        return "failed"
    if state_name in {"generating_code", "repairing"} or record.status == "running":
        return "running"
    return "queued"


def expo_hap_result_path(workspace: Path) -> Path:
    return workspace / ".expo-fast" / "hap" / "build-result.json"


def load_expo_hap_result(workspace: Path) -> dict[str, Any] | None:
    result = read_json(expo_hap_result_path(workspace))
    return result if isinstance(result, dict) else None


def resolve_expo_hap_artifact(workspace: Path, result: dict[str, Any] | None = None) -> Path | None:
    payload = result or load_expo_hap_result(workspace)
    if str((payload or {}).get("status") or "").strip().lower() != "success":
        return None
    raw_path = str((payload or {}).get("hapPath") or "").strip()
    if not raw_path:
        return None
    allowed_root = (workspace / ".expo-fast" / "hap").resolve()
    candidate = Path(raw_path).expanduser().resolve()
    try:
        candidate.relative_to(allowed_root)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def expo_hap_error(result: dict[str, Any] | None) -> str:
    error = (result or {}).get("error")
    if isinstance(error, dict):
        return str(error.get("message") or "").strip()
    return str(error or "").strip()


def expo_hap_package_error(
    result: dict[str, Any] | None,
    status: str,
    artifact_ready: bool,
) -> str:
    result_status = str((result or {}).get("status") or "").strip().lower()
    if status == "failed" and result_status != "failed" and not artifact_ready:
        return "unsigned HAP 产物缺失或路径无效。"
    return expo_hap_error(result)


def expo_hap_status(
    state: dict[str, Any] | None,
    result: dict[str, Any] | None,
    run_status: str,
    artifact_ready: bool = False,
) -> str:
    result_status = str((result or {}).get("status") or "").strip().lower()
    if result_status == "success":
        return "ready" if artifact_ready else "failed"
    if result_status == "failed":
        return "failed"
    context_hap = ((state or {}).get("context") or {}).get("hap")
    context_status = str((context_hap or {}).get("status") or "").strip().lower()
    if context_status == "ready":
        return "ready" if artifact_ready else "failed"
    if context_status in {"failed", "skipped"}:
        return context_status
    if str((state or {}).get("detail") or "").strip().lower() == "hap_building":
        return "building"
    if run_status == "completed":
        return "skipped"
    return "waiting_generation"


def sync_expo_package_status(record: RunRecord, status: str, error: str = "") -> RunRecord:
    if record.expo_package_status == status:
        return record
    latest = load_run(record.run_id) or record
    latest.expo_package_status = status
    latest.expo_package_updated_at = to_iso()
    if status == "ready":
        latest.notes = "Expo bundle 与 unsigned HAP 已生成。"
    elif status == "failed":
        latest.notes = f"Expo bundle 已生成，但 unsigned HAP 构建失败：{error[:800] or '请查看构建日志。'}"
    elif status == "skipped":
        latest.notes = "Expo bundle 已生成，本次未启用 unsigned HAP 构建。"
    return save_run(latest)


def summarize_expo_fast_events(state: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not state:
        return []
    events: list[dict[str, Any]] = []
    for item in state.get("history") or []:
        if not isinstance(item, dict):
            continue
        detail_label = str(item.get("detailLabel") or "").strip()
        label = str(item.get("label") or "").strip()
        summary = detail_label or label or str(item.get("detail") or item.get("state") or "状态更新")
        if detail_label and label and detail_label != label:
            summary = f"{label}：{detail_label}"
        events.append(
            {
                "kind": "expo",
                "timestamp": item.get("at"),
                "summary": summary,
            }
        )
    error = str(state.get("error") or "").strip()
    if error:
        events.append(
            {
                "kind": "error",
                "timestamp": state.get("updatedAt"),
                "summary": error[:800],
            }
        )
    return events


def expo_trace_descriptor(path: Path) -> dict[str, Any] | None:
    name = path.name
    revision = re.fullmatch(r"(\d+)-follow-up", path.parent.name)
    revision_number = int(revision.group(1)) if revision else None
    if name == "agent-trace.jsonl":
        if revision_number is not None:
            return {
                "id": f"follow-up-{revision_number}",
                "label": f"续跑调整 #{revision_number}",
                "kind": "follow_up",
                "revision": revision_number,
                "order": 1000 + revision_number * 100,
            }
        return {"id": "generation", "label": "代码生成", "kind": "generation", "order": 0}
    repair = re.fullmatch(r"agent-repair-trace(?:-(\d+))?\.jsonl", name)
    if repair:
        attempt = int(repair.group(1) or "1")
        if revision_number is not None:
            return {
                "id": f"follow-up-{revision_number}-repair-{attempt}",
                "label": f"续跑调整 #{revision_number} · 自动修复 #{attempt}",
                "kind": "follow_up_repair",
                "revision": revision_number,
                "attempt": attempt,
                "order": 1000 + revision_number * 100 + attempt,
            }
        return {
            "id": f"repair-{attempt}",
            "label": f"自动修复 #{attempt}",
            "kind": "repair",
            "attempt": attempt,
            "order": 100 + attempt,
        }
    runtime_repair = re.fullmatch(r"agent-runtime-repair-trace(?:-(\d+))?\.jsonl", name)
    if runtime_repair:
        attempt = int(runtime_repair.group(1) or "1")
        return {
            "id": f"runtime-repair-{attempt}",
            "label": f"运行修复 #{attempt}",
            "kind": "runtime_repair",
            "attempt": attempt,
            "order": 200 + attempt,
        }
    if re.fullmatch(r"smoke-agent-trace(?:-resume)?\.jsonl", name):
        return {"id": name.removesuffix(".jsonl"), "label": "运行验收", "kind": "smoke", "order": 300}
    return None


def expo_trace_target(workspace: Path, tool_input: dict[str, Any]) -> str:
    raw_target = tool_input.get("file_path") or tool_input.get("path")
    if not isinstance(raw_target, str) or not raw_target.strip():
        return ""
    try:
        workspace_root = workspace.resolve()
        candidate = Path(raw_target).expanduser()
        if not candidate.is_absolute():
            candidate = workspace_root / candidate
        return candidate.resolve().relative_to(workspace_root).as_posix()
    except (OSError, RuntimeError, ValueError):
        return ""


def summarize_expo_claude_row(
    row: dict[str, Any],
    workspace: Path,
    trace_name: str,
    first_index: int,
) -> list[dict[str, Any]]:
    row_type = str(row.get("type") or "")
    timestamp = str(row.get("timestamp") or "")
    events: list[dict[str, Any]] = []

    def append(kind: str, summary: str, **extra: Any) -> None:
        index = first_index + len(events)
        events.append(
            {
                "id": f"{trace_name}:{index}",
                "kind": kind,
                "timestamp": timestamp,
                "summary": summary,
                **extra,
            }
        )

    if row_type == "system" and row.get("subtype") == "init":
        model = str(row.get("model") or "").strip()
        append(
            "session",
            f"Claude 会话已启动{f' · {model}' if model else ''}",
            model=model,
        )
        return events

    if row_type == "assistant":
        message = row.get("message") if isinstance(row.get("message"), dict) else {}
        content = message.get("content") or []
        if not isinstance(content, list):
            return events
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "tool_use":
                tool_name = str(block.get("name") or "Action").strip() or "Action"
                tool_input = block.get("input") if isinstance(block.get("input"), dict) else {}
                target = expo_trace_target(workspace, tool_input)
                action_label = {"Read": "读取", "Write": "写入", "Edit": "修改"}.get(tool_name, tool_name)
                append(
                    "action",
                    f"{action_label}{f' · {target}' if target else ''}",
                    tool_name=tool_name,
                    target=target,
                )
            elif block_type == "text":
                text = re.sub(r"\s+", " ", str(block.get("text") or "")).strip()
                if text:
                    append("assistant", text[:500])
        return events

    if row_type == "result":
        try:
            turns = int(row.get("num_turns") or 0)
        except (TypeError, ValueError):
            turns = 0
        try:
            duration_seconds = round(float(row.get("duration_ms") or 0) / 1000)
        except (TypeError, ValueError):
            duration_seconds = 0
        failed = bool(row.get("is_error")) or str(row.get("subtype") or "").lower() in {
            "error",
            "failed",
        }
        append(
            "result",
            f"Claude 会话{'失败' if failed else '完成'} · {turns} 轮 · {duration_seconds} 秒",
            status="failed" if failed else "completed",
        )
    return events


def read_expo_claude_trace(path: Path, workspace: Path) -> dict[str, Any]:
    key = str(path.resolve())
    try:
        stat = path.stat()
    except OSError:
        return {"events": [], "event_count": 0, "status": "waiting", "updated_at": ""}

    with EXPO_TRACE_CACHE_LOCK:
        cache = EXPO_TRACE_CACHE.get(key)
        identity = (stat.st_dev, stat.st_ino)
        if cache is None or cache.get("identity") != identity or stat.st_size < int(cache.get("offset") or 0):
            cache = {
                "identity": identity,
                "offset": 0,
                "pending": b"",
                "events": [],
                "event_count": 0,
                "status": "running",
                "updated_at": "",
                "last_access": time.monotonic(),
            }
            EXPO_TRACE_CACHE[key] = cache

        with path.open("rb") as stream:
            stream.seek(int(cache["offset"]))
            chunk = stream.read()
            cache["offset"] = stream.tell()

        data = bytes(cache.get("pending") or b"") + chunk
        lines = data.split(b"\n")
        cache["pending"] = lines.pop() if lines else b""
        for raw_line in lines:
            if not raw_line.strip():
                continue
            try:
                row = json.loads(raw_line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(row, dict):
                continue
            summarized = summarize_expo_claude_row(
                row,
                workspace,
                path.name,
                int(cache["event_count"]),
            )
            cache["event_count"] = int(cache["event_count"]) + len(summarized)
            cache["events"].extend(summarized)
            if summarized:
                cache["updated_at"] = next(
                    (event["timestamp"] for event in reversed(summarized) if event.get("timestamp")),
                    datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                )
            if len(cache["events"]) > EXPO_TRACE_EVENT_LIMIT:
                cache["events"] = cache["events"][-EXPO_TRACE_EVENT_LIMIT:]
            result = next((event for event in reversed(summarized) if event["kind"] == "result"), None)
            if result:
                cache["status"] = result.get("status") or "completed"

        cache["last_access"] = time.monotonic()
        if len(EXPO_TRACE_CACHE) > EXPO_TRACE_CACHE_LIMIT:
            stale_keys = sorted(
                EXPO_TRACE_CACHE,
                key=lambda item: float(EXPO_TRACE_CACHE[item].get("last_access") or 0),
            )[: len(EXPO_TRACE_CACHE) - EXPO_TRACE_CACHE_LIMIT]
            for stale_key in stale_keys:
                if stale_key != key:
                    EXPO_TRACE_CACHE.pop(stale_key, None)

        return {
            "events": [dict(event) for event in cache["events"]],
            "event_count": int(cache["event_count"]),
            "status": str(cache["status"]),
            "updated_at": str(cache.get("updated_at") or ""),
        }


def load_expo_claude_trace_groups(
    workspace: Path,
    state: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    trace_root = workspace / ".expo-fast"
    if not trace_root.is_dir():
        return []
    traces: list[tuple[dict[str, Any], Path]] = []
    for path in trace_root.rglob("*.jsonl"):
        descriptor = expo_trace_descriptor(path)
        if descriptor:
            traces.append((descriptor, path))
    traces.sort(key=lambda item: (int(item[0]["order"]), item[1].relative_to(trace_root).as_posix()))
    state_name = str((state or {}).get("state") or "").strip().lower()
    state_started_at = str((state or {}).get("startedAt") or "")
    groups: list[dict[str, Any]] = []
    for index, (descriptor, path) in enumerate(traces):
        trace = read_expo_claude_trace(path, workspace)
        status = trace["status"]
        if status == "running" and index < len(traces) - 1:
            status = "completed"
        elif status == "running" and state_name == "completed":
            status = "completed"
        elif status == "running" and state_name == "failed":
            status = "failed"

        events = trace["events"]
        actual_timestamps = [event["timestamp"] for event in events if event.get("timestamp")]
        first_timestamp = actual_timestamps[0] if actual_timestamps else state_started_at
        last_timestamp = actual_timestamps[-1] if actual_timestamps else trace["updated_at"]
        for event in events:
            if not event.get("timestamp"):
                event["timestamp"] = last_timestamp if event["kind"] == "result" else first_timestamp

        groups.append(
            {
                **{key: value for key, value in descriptor.items() if key != "order"},
                "trace_file": path.relative_to(trace_root).as_posix(),
                "status": status,
                "event_count": trace["event_count"],
                "action_count": sum(event["kind"] == "action" for event in events),
                "message_count": sum(event["kind"] == "assistant" for event in events),
                "truncated": trace["event_count"] > len(events),
                "updated_at": trace["updated_at"],
                "events": events,
            }
        )
    return groups


def build_capture_command(record: RunRecord) -> list[str]:
    capture_python = CAPTURE_PYTHON_BIN if Path(CAPTURE_PYTHON_BIN).is_file() else sys.executable
    command = [
        capture_python,
        str(HDC_CAPTURE_SCRIPT_PATH),
        "--workspace",
        record.workspace,
        "--run-id",
        record.run_id,
    ]
    if HDC_CAPTURE_TARGET:
        command.extend(["--target", HDC_CAPTURE_TARGET])
    return command


def find_latest_hap(workspace: Path, _created_at: str | None = None) -> Path | None:
    hap_path = workspace / EXPECTED_HAP_RELATIVE_PATH
    if hap_path.is_file():
        return hap_path
    expo_haps = sorted(
        (path for path in (workspace / ".expo-fast" / "hap").glob("*.hap") if path.is_file()),
        key=lambda path: path.stat().st_mtime_ns,
        reverse=True,
    )
    return expo_haps[0] if expo_haps else None


def file_mtime(path: Path | None) -> float:
    try:
        return path.stat().st_mtime if path else 0.0
    except OSError:
        return 0.0


def find_latest_media(run_id: str, workspace: Path, created_at: str | None = None) -> Path | None:
    expo_launch_screenshot = workspace / ".expo-fast" / "launch-screenshot.jpeg"
    if pick_recent_file([expo_launch_screenshot] if expo_launch_screenshot.is_file() else [], created_at):
        return expo_launch_screenshot
    run_dir = MEDIA_DIR / run_id
    local_media = pick_recent_file(list_candidate_files(run_dir, ALLOWED_MEDIA_EXTENSIONS), created_at)
    if local_media:
        return local_media
    return pick_recent_file(list_candidate_files(workspace, ALLOWED_MEDIA_EXTENSIONS), created_at)


def find_first_screenshot(run_id: str) -> Path | None:
    manifest = load_capture_manifest(run_id)
    manifest_paths: list[Any] = []
    if manifest:
        manifest_paths.extend(manifest.get("unique_screenshots") or [])
        manifest_paths.extend(manifest.get("screenshots") or [])

    for item in manifest_paths:
        path = Path(str(item))
        if path.is_file() and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
            return path

    screenshots_dir = MEDIA_DIR / run_id / "screenshots"
    if screenshots_dir.is_dir():
        screenshots = [
            item
            for item in sorted(screenshots_dir.iterdir(), key=lambda value: value.name)
            if item.is_file() and item.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
        ]
        if screenshots:
            return screenshots[0]

    return None


def state_root(workspace: Path) -> Path:
    return workspace / ".arkpilot" / "state"


def ask_user_question_dir(workspace: Path) -> Path:
    return state_root(workspace) / "ask-user-question"


def safe_question_id(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", str(value or "unknown"))


ASK_USER_QUESTION_TIMEOUT_SEC = int(os.environ.get("ASK_USER_WEB_HOOK_TIMEOUT_SEC", "600"))


def ask_user_question_deadline(request: dict[str, Any]) -> datetime | None:
    explicit = parse_iso(str(request.get("expiresAt") or ""))
    if explicit:
        if explicit.tzinfo is None:
            explicit = explicit.replace(tzinfo=timezone.utc)
        return explicit
    created_at = parse_iso(str(request.get("createdAt") or ""))
    if not created_at:
        return None
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    return created_at + timedelta(seconds=ASK_USER_QUESTION_TIMEOUT_SEC)


def load_ask_user_questions(workspace: Path) -> dict[str, Any]:
    directory = ask_user_question_dir(workspace)
    if not directory.is_dir():
        return {"pending": [], "answered": [], "stale": []}

    pending: list[dict[str, Any]] = []
    answered: list[dict[str, Any]] = []
    stale: list[dict[str, Any]] = []
    active = read_json(directory / "active.json") or {}
    active_id = safe_question_id(str(active.get("id") or active.get("toolUseId") or ""))
    now = datetime.now(timezone.utc)
    try:
        request_paths = sorted(directory.glob("request-*.json"), key=lambda item: item.stat().st_mtime)
    except OSError:
        return {"pending": [], "answered": [], "stale": []}

    for request_path in request_paths:
        request = read_json(request_path)
        if not request:
            continue
        question_id = safe_question_id(str(request.get("id") or request.get("toolUseId") or ""))
        if not question_id:
            continue
        response = read_json(directory / f"response-{question_id}.json")
        completed = read_json(directory / f"completed-{question_id}.json")
        deadline = ask_user_question_deadline(request)
        is_active = question_id == active_id
        is_expired = bool(deadline and deadline < now)
        is_stale = not response and (is_expired or (active_id and not is_active))
        status = "answered" if response else "stale" if is_stale else "pending"
        item = {
            "id": question_id,
            "toolUseId": request.get("toolUseId") or question_id,
            "sessionId": request.get("sessionId") or "",
            "agentId": request.get("agentId") or "",
            "agentType": request.get("agentType") or "",
            "audience": request.get("audience") or "end_user",
            "status": status,
            "active": is_active,
            "stale": is_stale,
            "createdAt": request.get("createdAt"),
            "expiresAt": request.get("expiresAt") or (deadline.isoformat() if deadline else None),
            "answeredAt": response.get("answeredAt") if response else None,
            "completedAt": completed.get("completedAt") if completed else None,
            "toolInput": request.get("toolInput") or {},
            "answers": response.get("answers") if response else {},
            "_sortAt": request_path.stat().st_mtime,
        }
        if response:
            answered.append(item)
        elif is_stale:
            stale.append(item)
        else:
            pending.append(item)

    pending.sort(key=lambda item: (0 if item.get("active") else 1, -float(item.get("_sortAt") or 0)))
    answered.sort(key=lambda item: float(item.get("_sortAt") or 0))
    stale.sort(key=lambda item: float(item.get("_sortAt") or 0))
    for collection in (pending, answered, stale):
        for item in collection:
            item.pop("_sortAt", None)

    return {
        "pending": pending[:5],
        "answered": answered[-10:],
        "stale": stale[-10:],
    }


def capture_run_dir(run_id: str) -> Path:
    return MEDIA_DIR / run_id


def capture_manifest_path(run_id: str) -> Path:
    return capture_run_dir(run_id) / "capture-manifest.json"


def load_capture_manifest(run_id: str) -> dict[str, Any] | None:
    return read_json(capture_manifest_path(run_id))


def effective_capture_status(
    record: RunRecord,
    capture_manifest: dict[str, Any] | None = None,
) -> str:
    manifest = capture_manifest if capture_manifest is not None else load_capture_manifest(record.run_id)
    manifest_current = bool(
        manifest
        and file_mtime(capture_manifest_path(record.run_id)) >= float(record.capture_hap_mtime or 0)
    )
    if manifest_current and manifest and manifest.get("status"):
        return str(manifest["status"])
    if record.capture_status == "running" and not process_alive(record.capture_process_pid):
        return "failed"
    return record.capture_status


def load_hpack_manifest(run_id: str) -> dict[str, Any] | None:
    return _load_hpack_manifest(run_id, read_json=read_json)


class FollowUpControlError(RuntimeError):
    def __init__(self, message: str, *, code: str = "internal_error", details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def follow_up_cli_path(record: RunRecord) -> Path:
    """Resolve the runtime-owned follow-up controller."""
    if record.runtime == "expo":
        if EXPO_FAST_ROOT is None:
            return Path("/__expo_fast_not_configured__/follow-up-control.sh")
        return EXPO_FAST_ROOT / "follow-up-control.sh"
    return TMUX_RUNNER_PATH.parent / "follow-up-control.cjs"


def call_follow_up_control(record: RunRecord, action: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    """Invoke the runtime's stable follow-up CLI without putting user text in argv."""
    cli_path = follow_up_cli_path(record)
    if not cli_path.is_file():
        raise FollowUpControlError("follow-up 控制器未部署", code="follow_up_unavailable")
    command = [str(cli_path), action, "--cwd", record.workspace, "--run", record.session_name]
    env = build_expo_fast_env(record) if record.runtime == "expo" else None
    cwd = str(EXPO_FAST_ROOT) if record.runtime == "expo" and EXPO_FAST_ROOT else None
    if record.runtime != "expo":
        command.insert(0, "node")
    payload_text = ""
    if body is not None:
        command.append("--json-stdin")
        payload_text = json.dumps(body, ensure_ascii=False)
    try:
        result = subprocess.run(
            command,
            input=payload_text,
            text=True,
            capture_output=True,
            check=False,
            timeout=15,
            env=env,
            cwd=cwd,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise FollowUpControlError("follow-up 控制器调用失败", code="control_unavailable") from exc
    try:
        response = json.loads(result.stdout.strip())
    except json.JSONDecodeError as exc:
        raise FollowUpControlError("follow-up 控制器返回无效响应") from exc
    if not isinstance(response, dict):
        raise FollowUpControlError("follow-up 控制器返回无效响应")
    if result.returncode == 0 and response.get("ok") is True:
        return response
    raise FollowUpControlError(
        str(response.get("error") or "follow-up 控制器请求失败"),
        code=str(response.get("code") or "internal_error"),
        details=response.get("details") if isinstance(response.get("details"), dict) else {},
    )


def unavailable_follow_up(message: str = "续跑会话尚未就绪") -> dict[str, Any]:
    return {
        "status": "unavailable",
        "queue_length": 0,
        "active_command_id": None,
        "interrupt_command_id": None,
        "last_error": message,
        "active_command": None,
        "interrupt_command": None,
        "queue": [],
    }


def load_follow_up_status(record: RunRecord, run_state: dict[str, Any] | None) -> dict[str, Any]:
    """Read the runtime status mirror through its CLI; never write state files directly."""
    if record.runtime == "expo":
        result = read_json(Path(record.workspace) / ".expo-fast" / "result.json")
        if not isinstance(result, dict) or not str(result.get("sessionId") or "").strip():
            return unavailable_follow_up()
    elif not isinstance(run_state, dict) or not isinstance(run_state.get("follow_up"), dict):
        return unavailable_follow_up()
    try:
        response = call_follow_up_control(record, "status")
        follow_up = response.get("follow_up")
        return follow_up if isinstance(follow_up, dict) else unavailable_follow_up("续跑状态响应无效")
    except FollowUpControlError as exc:
        return unavailable_follow_up(str(exc))


def newer_hap_available(run_id: str, workspace: Path, created_at: str | None = None) -> bool:
    """判断是否存在比当前已签名安装包（hpack manifest）更新的 HAP。"""
    manifest_path = hpack_manifest_path(run_id)
    if not manifest_path.is_file():
        return False
    hap_path = find_latest_hap(workspace, created_at)
    if not hap_path or not hap_path.is_file():
        return False
    try:
        return hap_path.stat().st_mtime > manifest_path.stat().st_mtime + 1.0
    except OSError:
        return False


def follow_up_changed_after_manifest(
    follow_up: dict[str, Any],
    hpack_manifest: dict[str, Any] | None,
    latest_adjustment_at: str | None = None,
) -> bool:
    """Return whether a submitted adjustment is newer than the signed package."""
    if not hpack_manifest or hpack_manifest.get("status") != "ready":
        return False
    packaged_at = parse_iso(str(hpack_manifest.get("created_at") or ""))
    if not packaged_at:
        return False
    persisted_adjustment_at = parse_iso(str(latest_adjustment_at or ""))
    if persisted_adjustment_at and persisted_adjustment_at > packaged_at:
        return True
    commands: list[dict[str, Any]] = []
    active = follow_up.get("active_command")
    if (
        isinstance(active, dict)
        and active.get("type") == "message"
        and not active.get("interrupted_before_assistant_activity")
    ):
        commands.append(active)
    for key in ("queue", "history"):
        items = follow_up.get(key)
        if isinstance(items, list):
            commands.extend(
                command
                for command in items
                if (
                    isinstance(command, dict)
                    and command.get("type") == "message"
                    and not command.get("interrupted_before_assistant_activity")
                )
            )
    for command in commands:
        command_at = parse_iso(str(command.get("created_at") or ""))
        if command_at and command_at > packaged_at:
            return True
    return False


def newest_follow_up_message_at(follow_up: dict[str, Any]) -> str:
    """Return the newest message timestamp from active, queue and history."""
    commands: list[dict[str, Any]] = []
    active = follow_up.get("active_command")
    if (
        isinstance(active, dict)
        and active.get("type") == "message"
        and not active.get("interrupted_before_assistant_activity")
    ):
        commands.append(active)
    for key in ("queue", "history"):
        items = follow_up.get(key)
        if isinstance(items, list):
            commands.extend(
                command
                for command in items
                if (
                    isinstance(command, dict)
                    and command.get("type") == "message"
                    and not command.get("interrupted_before_assistant_activity")
                )
            )
    newest_text = ""
    newest_at = None
    for command in commands:
        created_text = str(command.get("created_at") or "")
        created_at = parse_iso(created_text)
        if created_at and (newest_at is None or created_at > newest_at):
            newest_at = created_at
            newest_text = created_text
    return newest_text


def persist_latest_adjustment(
    record: RunRecord,
    response: dict[str, Any],
    *,
    replace_from_state: bool = False,
) -> RunRecord:
    """Persist the newest accepted message timestamp from a controller response."""
    command = response.get("command")
    candidate_text = (
        str(command.get("created_at") or "")
        if isinstance(command, dict) and command.get("type") == "message"
        else ""
    )
    follow_up = response.get("follow_up")
    state_text = newest_follow_up_message_at(follow_up) if isinstance(follow_up, dict) else ""
    candidate_at = parse_iso(candidate_text)
    state_at = parse_iso(state_text)
    if state_at and (not candidate_at or state_at > candidate_at):
        candidate_text = state_text
        candidate_at = state_at
    if not candidate_at and not replace_from_state:
        candidate_text = to_iso()
        candidate_at = parse_iso(candidate_text)
    latest = load_run(record.run_id) or record
    if replace_from_state:
        latest.latest_adjustment_at = state_text
        if latest.latest_adjustment_at == latest.preview_source_adjustment_at:
            latest.preview_refresh_status = "ready" if state_text else "idle"
            latest.preview_refresh_target_at = state_text
            latest.preview_refresh_error = ""
        elif latest.latest_adjustment_at:
            latest.preview_refresh_status = "queued"
            latest.preview_refresh_target_at = latest.latest_adjustment_at
        return save_run(latest)
    previous_at = parse_iso(latest.latest_adjustment_at)
    if candidate_at and (not previous_at or candidate_at > previous_at):
        latest.latest_adjustment_at = candidate_text
        latest.preview_refresh_status = "queued"
        latest.preview_refresh_target_at = candidate_text
        latest.preview_refresh_error = ""
        latest = save_run(latest)
    return latest


def package_revision_outdated(latest_adjustment_at: str, package_source_adjustment_at: str) -> bool:
    """Return whether code adjustments advanced after the signed build started."""
    return bool(
        (latest_adjustment_at or package_source_adjustment_at)
        and latest_adjustment_at != package_source_adjustment_at
    )


def package_qa_gate_ready(package_outdated: bool, qa_status: str) -> bool:
    """Only the automatic first package waits for QA; follow-up packages skip it."""
    return package_outdated or qa_status in {"complete", "disabled"}


HPACK_PACKAGE_LOCK = threading.Lock()
HPACK_PACKAGE_IN_FLIGHT: set[str] = set()
EXPO_RUN_OPERATION_LOCKS_GUARD = threading.Lock()
EXPO_RUN_OPERATION_LOCKS: dict[str, threading.RLock] = {}
EXPO_PREVIEW_REFRESH_LOCK = threading.Lock()
EXPO_PREVIEW_REFRESH_IN_FLIGHT: set[str] = set()
EXPO_PREVIEW_REFRESH_MONITORS_IN_FLIGHT: set[str] = set()


def expo_run_operation_lock(run_id: str) -> threading.RLock:
    """Serialize per-run follow-up, rebuild, and packaging state transitions."""
    with EXPO_RUN_OPERATION_LOCKS_GUARD:
        return EXPO_RUN_OPERATION_LOCKS.setdefault(run_id, threading.RLock())


def expo_runtime_operation_in_flight(record: RunRecord) -> bool:
    return record.status == "running" or process_alive(record.process_pid)


def expo_preview_source_outdated(record: RunRecord) -> bool:
    return bool(
        record.runtime == "expo"
        and record.latest_adjustment_at
        and record.latest_adjustment_at != record.preview_source_adjustment_at
    )


def expo_preview_refresh_in_flight(record: RunRecord) -> bool:
    return bool(
        record.run_id in EXPO_PREVIEW_REFRESH_IN_FLIGHT
        or record.run_id in EXPO_PREVIEW_REFRESH_MONITORS_IN_FLIGHT
        or process_alive(record.preview_refresh_process_pid)
    )


def follow_up_message_for_adjustment(
    follow_up: dict[str, Any],
    adjustment_at: str,
) -> dict[str, Any] | None:
    target_at = parse_iso(adjustment_at)
    if not target_at:
        return None
    commands: list[dict[str, Any]] = []
    active = follow_up.get("active_command")
    if isinstance(active, dict):
        commands.append(active)
    for key in ("queue", "history"):
        values = follow_up.get(key)
        if isinstance(values, list):
            commands.extend(value for value in values if isinstance(value, dict))
    message_commands: list[tuple[datetime, dict[str, Any]]] = []
    for command in commands:
        if command.get("type") != "message" or command.get("interrupted_before_assistant_activity"):
            continue
        command_at = parse_iso(str(command.get("created_at") or ""))
        if not command_at:
            continue
        if command_at == target_at:
            return command
        message_commands.append((command_at, command))
    # Older frontend builds persisted their own acceptance time when the
    # controller response had not yet mirrored the queued command. It differs
    # from command.created_at by only a few milliseconds; accept that legacy
    # record without weakening latest-revision selection.
    if message_commands:
        newest_at, newest_command = max(message_commands, key=lambda item: item[0])
        if abs((newest_at - target_at).total_seconds()) <= 5:
            return newest_command
    return None


def follow_up_ready_for_preview_refresh(
    record: RunRecord,
    follow_up: dict[str, Any],
) -> tuple[bool, str]:
    if not expo_preview_source_outdated(record):
        return False, ""
    if str(follow_up.get("status") or "").strip().lower() != "idle":
        return False, ""
    if follow_up.get("active_command") or int(follow_up.get("queue_length") or 0) > 0:
        return False, ""
    command = follow_up_message_for_adjustment(follow_up, record.latest_adjustment_at)
    if not command:
        return False, ""
    status = str(command.get("status") or "").strip().lower()
    if status == "completed":
        return True, ""
    if status in {"failed", "interrupted", "cancelled", "canceled"}:
        return False, str(command.get("error") or f"最近一次续跑状态为 {status}，未生成新预览。")
    return False, ""


def promote_preview_hap(
    record: RunRecord,
    output_root: Path,
    build_result: dict[str, Any],
) -> tuple[Path, str]:
    if str(build_result.get("status") or "").strip().lower() != "success":
        error = build_result.get("error")
        if isinstance(error, dict):
            error = error.get("message")
        raise RuntimeError(str(error or "后台 HAP 构建未发布成功产物。"))
    raw_hap = Path(str(build_result.get("hapPath") or "")).expanduser()
    if not raw_hap.is_file() or raw_hap.is_symlink():
        raise RuntimeError("后台 HAP 构建产物缺失或无效。")
    source_hap = raw_hap.resolve()
    try:
        source_hap.relative_to(output_root.resolve())
    except ValueError as exc:
        raise RuntimeError("后台 HAP 构建产物超出隔离输出目录。") from exc
    digest = hashlib.sha256(source_hap.read_bytes()).hexdigest()
    expected_digest = str(build_result.get("hapSha256") or "")
    if expected_digest and expected_digest != digest:
        raise RuntimeError("后台 HAP 构建产物摘要与结果元数据不一致。")

    canonical_root = Path(record.workspace) / ".expo-fast" / "hap"
    canonical_root.mkdir(parents=True, exist_ok=True)
    target_name = f"preview-{hashlib.sha256(record.latest_adjustment_at.encode()).hexdigest()[:12]}.hap"
    target_hap = canonical_root / target_name
    temporary_hap = canonical_root / f".{target_name}.{uuid4().hex}.tmp"
    try:
        shutil.copy2(source_hap, temporary_hap)
        temporary_hap.replace(target_hap)
    finally:
        temporary_hap.unlink(missing_ok=True)

    published = {
        **build_result,
        "status": "success",
        "hapPath": str(target_hap.resolve()),
        "hapSha256": digest,
        "productRoot": str(Path(record.workspace).resolve()),
        "resultPath": str(expo_hap_result_path(Path(record.workspace))),
        "logPath": str(build_result.get("logPath") or ""),
        "previewSourceAdjustmentAt": record.latest_adjustment_at,
    }
    write_json(expo_hap_result_path(Path(record.workspace)), published)
    for previous_hap in canonical_root.glob("preview-*.hap"):
        if previous_hap != target_hap:
            previous_hap.unlink(missing_ok=True)
    return target_hap.resolve(), digest


def run_expo_preview_hap_refresh(record_id: str, target_at: str, output_root: Path) -> None:
    should_reschedule = False
    log_path = LOG_DIR / f"{record_id}.preview-hap.log"
    try:
        record = load_run(record_id)
        if not record or EXPO_FAST_ROOT is None:
            return
        refresher = EXPO_FAST_ROOT / "refresh-preview-hap.sh"
        if not refresher.is_file():
            raise RuntimeError(f"预览 HAP 构建器不存在: {refresher}")
        command = [
            str(refresher),
            "--project", record.workspace,
            "--output", str(output_root),
            "--run-id", f"{record.run_id}-{hashlib.sha256(target_at.encode()).hexdigest()[:12]}",
        ]
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("ab") as log_stream:
            log_stream.write(f"$ {' '.join(command)}\n".encode("utf-8", errors="ignore"))
            log_stream.flush()
            process = subprocess.Popen(
                command,
                cwd=str(EXPO_FAST_ROOT),
                stdout=log_stream,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                env=build_expo_fast_env(record),
            )
            with expo_run_operation_lock(record_id):
                latest = load_run(record_id)
                if not latest:
                    stop_process_group_or_pid(process.pid)
                    return
                latest.preview_refresh_process_pid = process.pid
                latest.preview_refresh_command = command
                save_run(latest)
            return_code = process.wait()

        build_result = read_json(output_root / "build-result.json") or {}
        pool_log = output_root / "build.log"
        if pool_log.is_file():
            persistent_pool_log = LOG_DIR / f"{record_id}.preview-hap-build.log"
            shutil.copy2(pool_log, persistent_pool_log)
            build_result["logPath"] = str(persistent_pool_log)
        with expo_run_operation_lock(record_id):
            latest = load_run(record_id)
            if not latest:
                return
            latest.preview_refresh_process_pid = None
            if latest.latest_adjustment_at != target_at:
                latest.preview_refresh_status = "queued"
                latest.preview_refresh_target_at = latest.latest_adjustment_at
                latest.preview_refresh_error = ""
                save_run(latest)
                should_reschedule = True
                return
            if return_code != 0:
                error = build_result.get("error")
                if isinstance(error, dict):
                    error = error.get("message")
                raise RuntimeError(str(error or f"后台 HAP 构建退出码为 {return_code}，日志: {log_path}"))
            promote_preview_hap(latest, output_root, build_result)
            latest = load_run(record_id) or latest
            if latest.latest_adjustment_at != target_at:
                latest.preview_refresh_status = "queued"
                latest.preview_refresh_target_at = latest.latest_adjustment_at
                should_reschedule = True
            else:
                latest.preview_source_adjustment_at = target_at
                latest.preview_refresh_target_at = target_at
                latest.preview_refresh_status = "ready"
                latest.preview_refresh_error = ""
            latest.preview_refresh_process_pid = None
            latest = save_run(latest)
        if not should_reschedule:
            maybe_refresh_desktop_preview(latest, "completed")
    except Exception as exc:
        with expo_run_operation_lock(record_id):
            latest = load_run(record_id)
            if latest:
                latest.preview_refresh_process_pid = None
                if latest.latest_adjustment_at != target_at:
                    latest.preview_refresh_status = "queued"
                    latest.preview_refresh_target_at = latest.latest_adjustment_at
                    latest.preview_refresh_error = ""
                    should_reschedule = True
                else:
                    latest.preview_refresh_status = "failed"
                    latest.preview_refresh_error = str(exc)[:1000]
                save_run(latest)
    finally:
        shutil.rmtree(output_root, ignore_errors=True)
        with EXPO_PREVIEW_REFRESH_LOCK:
            EXPO_PREVIEW_REFRESH_IN_FLIGHT.discard(record_id)
        if should_reschedule:
            latest = load_run(record_id)
            if latest:
                start_expo_preview_refresh_monitor(latest)


def start_expo_preview_hap_refresh(
    record: RunRecord,
    follow_up: dict[str, Any] | None = None,
) -> bool:
    with expo_run_operation_lock(record.run_id):
        latest = load_run(record.run_id) or record
        current_follow_up = follow_up or load_follow_up_status(
            latest,
            load_expo_fast_state(Path(latest.workspace)),
        )
        ready, terminal_error = follow_up_ready_for_preview_refresh(latest, current_follow_up)
        if terminal_error:
            latest.preview_refresh_status = "failed"
            latest.preview_refresh_error = terminal_error[:1000]
            save_run(latest)
            return False
        if not ready:
            return False
        with EXPO_PREVIEW_REFRESH_LOCK:
            if latest.run_id in EXPO_PREVIEW_REFRESH_IN_FLIGHT:
                return False
            if process_alive(latest.preview_refresh_process_pid):
                return False
            EXPO_PREVIEW_REFRESH_IN_FLIGHT.add(latest.run_id)
        target_at = latest.latest_adjustment_at
        suffix = f"{hashlib.sha256(target_at.encode()).hexdigest()[:12]}-{uuid4().hex[:8]}"
        output_root = Path(latest.workspace) / ".expo-fast" / "preview-refresh" / suffix
        latest.preview_refresh_target_at = target_at
        latest.preview_refresh_status = "building"
        latest.preview_refresh_process_pid = None
        latest.preview_refresh_error = ""
        latest = save_run(latest)
    threading.Thread(
        target=run_expo_preview_hap_refresh,
        args=(latest.run_id, target_at, output_root),
        daemon=True,
    ).start()
    return True


def monitor_expo_preview_refresh(record_id: str) -> None:
    try:
        while True:
            latest = load_run(record_id)
            if not latest or latest.runtime != "expo" or not expo_preview_source_outdated(latest):
                return
            follow_up = load_follow_up_status(
                latest,
                load_expo_fast_state(Path(latest.workspace)),
            )
            ready, terminal_error = follow_up_ready_for_preview_refresh(latest, follow_up)
            if ready:
                start_expo_preview_hap_refresh(latest, follow_up)
                return
            if terminal_error:
                latest.preview_refresh_status = "failed"
                latest.preview_refresh_error = terminal_error[:1000]
                save_run(latest)
                return
            time.sleep(1)
    finally:
        with EXPO_PREVIEW_REFRESH_LOCK:
            EXPO_PREVIEW_REFRESH_MONITORS_IN_FLIGHT.discard(record_id)


def start_expo_preview_refresh_monitor(record: RunRecord) -> bool:
    if record.runtime != "expo" or not expo_preview_source_outdated(record):
        return False
    with EXPO_PREVIEW_REFRESH_LOCK:
        if (
            record.run_id in EXPO_PREVIEW_REFRESH_MONITORS_IN_FLIGHT
            or record.run_id in EXPO_PREVIEW_REFRESH_IN_FLIGHT
        ):
            return False
        EXPO_PREVIEW_REFRESH_MONITORS_IN_FLIGHT.add(record.run_id)
    threading.Thread(target=monitor_expo_preview_refresh, args=(record.run_id,), daemon=True).start()
    return True


def expo_package_operation_ready(
    record: RunRecord,
    run_status: str,
    follow_up: dict[str, Any],
) -> bool:
    return bool(
        run_status == "completed"
        and str(follow_up.get("status") or "").strip().lower() == "idle"
        and not expo_runtime_operation_in_flight(record)
    )


def start_hpack_packaging(
    record: RunRecord,
    *,
    replace_manifest: bool = False,
) -> bool:
    """Start one HPack build for the latest stable workspace state."""
    if not HPACK_ENABLED:
        return False
    if not find_latest_hap(Path(record.workspace), record.created_at):
        return False
    with expo_run_operation_lock(record.run_id):
        latest = load_run(record.run_id) or record
        if latest.runtime == "expo":
            if expo_preview_source_outdated(latest):
                return False
            state = load_expo_fast_state(Path(latest.workspace))
            follow_up = load_follow_up_status(latest, state)
            if not expo_package_operation_ready(
                latest,
                expo_fast_run_status(latest, state),
                follow_up,
            ):
                return False
        with HPACK_PACKAGE_LOCK:
            if latest.run_id in HPACK_PACKAGE_IN_FLIGHT or process_alive(latest.distribution_process_pid):
                return False
            manifest_path = hpack_manifest_path(latest.run_id)
            if manifest_path.is_file():
                if not replace_manifest:
                    return False
                try:
                    manifest_path.unlink()
                except OSError:
                    return False
            latest.distribution_status = "waiting_hap"
            latest.distribution_process_pid = None
            latest.distribution_command = []
            latest.package_source_adjustment_at = latest.latest_adjustment_at
            latest.notes = "正在编译、签名并生成安装二维码。"
            record = save_run(latest)
            HPACK_PACKAGE_IN_FLIGHT.add(record.run_id)

    def run() -> None:
        try:
            wait_for_hap_and_package(record)
        finally:
            with HPACK_PACKAGE_LOCK:
                HPACK_PACKAGE_IN_FLIGHT.discard(record.run_id)

    threading.Thread(target=run, daemon=True).start()
    return True


INITIAL_PACKAGE_MONITOR_LOCK = threading.Lock()
INITIAL_PACKAGE_MONITORS_IN_FLIGHT: set[str] = set()


def wait_for_initial_package(record: RunRecord) -> None:
    """Wait for HAP and QA, then sign the first version once.

    Device preview is deliberately not part of this gate. A disconnected or
    failed emulator must not prevent a usable HAP from entering the install
    flow.
    """
    started_at = time.monotonic()
    while time.monotonic() - started_at < HPACK_WAIT_TIMEOUT_SEC:
        latest = load_run(record.run_id)
        if not latest or latest.first_install_url:
            return
        workspace = Path(latest.workspace)
        hap_path = find_latest_hap(workspace, latest.created_at)
        qa_status = load_ui_qa_status(workspace, latest.session_name)
        if hap_path and qa_status in {"complete", "disabled"}:
            start_hpack_packaging(latest)
            return
        if qa_status in {"failed", "error", "cancelled", "canceled"}:
            return
        time.sleep(CAPTURE_POLL_INTERVAL_SEC)


def start_initial_package_monitor(record: RunRecord) -> bool:
    """Start exactly one automatic first-version signing monitor per run."""
    if not HPACK_ENABLED or record.first_install_url:
        return False
    with INITIAL_PACKAGE_MONITOR_LOCK:
        if record.run_id in INITIAL_PACKAGE_MONITORS_IN_FLIGHT:
            return False
        INITIAL_PACKAGE_MONITORS_IN_FLIGHT.add(record.run_id)

    def run() -> None:
        try:
            wait_for_initial_package(record)
        finally:
            with INITIAL_PACKAGE_MONITOR_LOCK:
                INITIAL_PACKAGE_MONITORS_IN_FLIGHT.discard(record.run_id)

    threading.Thread(target=run, daemon=True).start()
    return True


def process_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def maybe_release_signing_slot(record: RunRecord) -> None:
    _maybe_release_signing_slot(
        record,
        process_alive=process_alive,
        load_hpack_manifest=load_hpack_manifest,
        save_run=save_run,
    )


def wait_for_hap_and_package(record: RunRecord) -> None:
    _wait_for_hap_and_package(
        record,
        find_latest_hap=find_latest_hap,
        load_ui_qa_status=load_ui_qa_status,
        load_run=load_run,
        save_run=save_run,
        maybe_release_signing_slot=maybe_release_signing_slot,
        read_json=read_json,
    )


def load_tmux_run_state(workspace: Path, session_name: str) -> dict[str, Any] | None:
    tmux_runs_dir = state_root(workspace) / "tmux-runs"
    run_state = read_json(tmux_runs_dir / f"{session_name}.json")
    if run_state is not None:
        return run_state

    normalized_name = normalize_tmux_session_name(session_name)
    if normalized_name and normalized_name != session_name:
        return read_json(tmux_runs_dir / f"{normalized_name}.json")
    return None


def ui_qa_status(run_state: dict[str, Any] | None) -> str:
    """Return the tmux runner's UI QA state used to gate HPack signing."""
    if not run_state:
        return "waiting"
    ui_qa = run_state.get("ui_qa")
    if not isinstance(ui_qa, dict):
        return "waiting"
    if ui_qa.get("enabled") is False:
        return "disabled"
    return str(ui_qa.get("status") or "waiting").strip().lower()


def load_ui_qa_status(workspace: Path, session_name: str) -> str:
    return ui_qa_status(load_tmux_run_state(workspace, session_name))


def load_autopilot_state(workspace: Path, session_id: str | None) -> dict[str, Any] | None:
    if not session_id:
        return None
    return read_json(state_root(workspace) / "sessions" / session_id / "autopilot-state.json")


def load_compact_diagnostics(workspace: Path, session_id: str | None) -> dict[str, Any] | None:
    if not session_id:
        return None
    return read_json(state_root(workspace) / "sessions" / session_id / "compact-diagnostics.json")


def current_lane(run_state: dict[str, Any] | None) -> dict[str, Any]:
    if not run_state:
        return {}
    lanes = run_state.get("lanes") or {}
    lane = lanes.get(run_state.get("active_lane"))
    return lane if isinstance(lane, dict) else {}


def summarize_capture_events(capture_manifest: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not capture_manifest:
        return []
    items = [
        {
            "kind": "capture",
            "timestamp": capture_manifest.get("started_at"),
            "summary": "开始采集应用演示并生成预览渲染。",
        }
    ]
    screenshots = capture_manifest.get("screenshots") or []
    if capture_manifest.get("status") == "complete":
        items.append(
            {
                "kind": "capture",
                "timestamp": capture_manifest.get("completed_at"),
                "summary": f"预览渲染已生成，共采集 {len(screenshots)} 张截图。",
            }
        )
    elif capture_manifest.get("status") == "failed":
        items.append(
            {
                "kind": "capture",
                "timestamp": capture_manifest.get("completed_at"),
                "summary": f"预览渲染生成失败: {capture_manifest.get('error') or '未知错误'}",
            }
        )
    return items


def monitor_tmux_process(record: RunRecord, process: subprocess.Popen[Any], log_path: Path) -> None:
    exit_code = process.wait()
    for _ in range(3):
        if load_tmux_run_state(Path(record.workspace), record.session_name):
            return
        time.sleep(0.5)

    latest = load_run(record.run_id)
    if not latest or latest.status not in {"queued", "running"}:
        return
    latest.status = "failed"
    latest.notes = (
        f"tmux-runner 已退出，但没有生成状态文件。exit_code={exit_code}, log={log_path}"
    )
    save_run(latest)
    maybe_release_signing_slot(latest)


CAPTURE_MONITOR_LOCK = threading.Lock()
CAPTURE_MONITORS_IN_FLIGHT: set[str] = set()


def media_matches_capture_hap(record: RunRecord, workspace: Path) -> bool:
    media_path = find_latest_media(record.run_id, workspace, record.created_at)
    return bool(media_path and file_mtime(media_path) >= record.capture_hap_mtime)


def wait_for_hap_and_capture(record: RunRecord) -> None:
    workspace = Path(record.workspace)
    if not HDC_CAPTURE_SCRIPT_PATH.exists():
        latest = load_run(record.run_id)
        if latest:
            latest.capture_status = "failed"
            latest.notes = f"hdc_runtime_capture.py 不存在: {HDC_CAPTURE_SCRIPT_PATH}"
            save_run(latest)
        return

    started_at = time.monotonic()
    while time.monotonic() - started_at < CAPTURE_WAIT_TIMEOUT_SEC:
        latest = load_run(record.run_id)
        if not latest:
            return
        if media_matches_capture_hap(latest, workspace):
            latest.capture_status = "complete"
            save_run(latest)
            return
        if latest.capture_status in {"running", "complete"}:
            return
        hap_path = find_latest_hap(workspace, latest.created_at)
        if hap_path:
            latest.capture_hap_mtime = file_mtime(hap_path)
            command = build_capture_command(latest)
            latest.capture_status = "running"
            latest.capture_command = command
            save_run(latest)
            log_path = LOG_DIR / f"{latest.run_id}.capture.log"
            log_stream = None
            try:
                log_stream = log_path.open("ab")
                log_stream.write(f"$ {' '.join(command)}\n".encode("utf-8", errors="ignore"))
                log_stream.flush()
                process = subprocess.Popen(
                    command,
                    cwd=str(APP_ROOT),
                    stdout=log_stream,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                latest.capture_process_pid = process.pid
                latest.notes = f"已检测到 HAP，开始生成预览渲染。日志: {log_path}"
                save_run(latest)
                exit_code = process.wait()
            except OSError as exc:
                latest = load_run(record.run_id) or latest
                latest.capture_status = "failed"
                latest.capture_process_pid = None
                latest.notes = f"启动演示采集失败: {exc}"
                save_run(latest)
                return
            finally:
                if log_stream is not None and not log_stream.closed:
                    log_stream.close()

            latest = load_run(record.run_id) or latest
            latest.capture_process_pid = None
            # 采集脚本可能会自行重建 HAP。把最终 mtime 记录为本轮采集基线，
            # 避免将采集自身产生的包误判为“调整后的新版本”并再次触发采集。
            final_hap = find_latest_hap(workspace, latest.created_at)
            latest.capture_hap_mtime = max(
                latest.capture_hap_mtime,
                file_mtime(final_hap),
            )
            capture_manifest = load_capture_manifest(latest.run_id)
            if exit_code == 0 and capture_manifest and capture_manifest.get("status") == "complete":
                latest.capture_status = "complete"
                latest.notes = (
                    f"预览渲染已生成: "
                    f"{capture_manifest.get('video_path') or capture_manifest.get('media_path') or capture_run_dir(latest.run_id) / 'demo.mp4'}"
                )
            else:
                latest.capture_status = "failed"
                latest.notes = f"预览渲染生成失败: {capture_manifest.get('error') if capture_manifest else f'exit_code={exit_code}'}"
            save_run(latest)
            return
        time.sleep(CAPTURE_POLL_INTERVAL_SEC)

    latest = load_run(record.run_id)
    if latest and latest.capture_status not in {"complete", "failed"}:
        latest.capture_status = "failed"
        latest.notes = f"等待 HAP 超时，未启动演示采集。超时 {int(CAPTURE_WAIT_TIMEOUT_SEC)} 秒。"
        save_run(latest)


def run_capture_monitor(record: RunRecord) -> None:
    try:
        wait_for_hap_and_capture(record)
    finally:
        with CAPTURE_MONITOR_LOCK:
            CAPTURE_MONITORS_IN_FLIGHT.discard(record.run_id)


def maybe_start_capture_monitor(record: RunRecord, hap_path: Path | None = None) -> bool:
    """Start one capture monitor per run; restart only when a newer HAP is present."""
    latest = load_run(record.run_id) or record
    current_hap = hap_path or find_latest_hap(Path(latest.workspace), latest.created_at)
    current_mtime = file_mtime(current_hap)
    if current_mtime and current_mtime <= latest.capture_hap_mtime + 0.01:
        return False
    with CAPTURE_MONITOR_LOCK:
        if latest.run_id in CAPTURE_MONITORS_IN_FLIGHT or process_alive(latest.capture_process_pid):
            return False
        if current_mtime:
            latest.capture_hap_mtime = current_mtime
            latest.capture_status = "waiting_hap"
            latest.capture_process_pid = None
            latest.capture_command = []
            latest.notes = "检测到新 HAP，正在刷新预览截图。"
            latest = save_run(latest)
        CAPTURE_MONITORS_IN_FLIGHT.add(latest.run_id)
    threading.Thread(target=run_capture_monitor, args=(latest,), daemon=True).start()
    return True


def expo_preview_media_path(workspace: Path, preview_kind: str) -> Path | None:
    candidate = workspace / ".expo-fast" / f"launch-screenshot-{preview_kind}.jpeg"
    if candidate.is_file():
        return candidate
    legacy = workspace / ".expo-fast" / "launch-screenshot.jpeg"
    return legacy if preview_kind == "desktop" and legacy.is_file() else None


def build_expo_preview_payloads(
    record: RunRecord,
    workspace: Path,
    run_status: str,
) -> dict[str, dict[str, Any]]:
    launch_state = read_json(workspace / ".expo-fast" / "launch-previews.json") or {}
    launch_previews = launch_state.get("previews") if isinstance(launch_state.get("previews"), dict) else {}
    preview_sessions = preview_sessions_payload(record)
    payloads: dict[str, dict[str, Any]] = {}
    for preview_kind, target in preview_targets_for_record(record).items():
        entry = launch_previews.get(preview_kind) if isinstance(launch_previews.get(preview_kind), dict) else {}
        media_path = expo_preview_media_path(workspace, preview_kind)
        entry_status = str(entry.get("status") or "").strip().lower()
        capture_status = (
            "failed"
            if entry_status == "failed"
            else "queued"
            if entry_status == "queued"
            else "complete"
            if media_path and run_status == "completed"
            else "running"
            if run_status == "running"
            else "waiting_launch"
        )
        # A completed capture only guarantees a persisted screenshot. The runner
        # releases its device lease after completion, so live endpoints are valid
        # only while an explicit preview session still owns a live lease.
        preview_session = preview_sessions.get(preview_kind, {})
        live_ready = bool(
            preview_session.get("status") == "ready"
            and preview_session.get("live_available")
        )
        query = f"preview={preview_kind}"
        payloads[preview_kind] = {
            "kind": preview_kind,
            "target": target,
            "capture_status": capture_status,
            "media_ready": bool(media_path),
            "media_path": f"/api/runs/{record.run_id}/media?{query}" if media_path else "",
            "media_source_path": str(media_path) if media_path else "",
            "media_type": media_path.suffix.lower().lstrip(".") if media_path else "",
            "live_ready": live_ready,
            "live_frame_path": f"/api/runs/{record.run_id}/live/frame?{query}" if live_ready else "",
            "live_input_path": f"/api/runs/{record.run_id}/live/input?{query}" if live_ready else "",
            "live_webrtc_config_path": (
                f"/api/runs/{record.run_id}/live/webrtc/config?{query}"
                if live_ready and WEBRTC_PREVIEW is not None
                else ""
            ),
        }
    return payloads


def ensure_expo_publication(record: RunRecord, *, can_publish: bool) -> dict[str, Any]:
    """Publish a completed Harmony Go export once and return its current state."""
    serve_state = EXPO_PUBLIC_GATEWAY.describe(record.run_id, can_publish=can_publish)
    if not can_publish or serve_state.get("public_url") or not serve_state.get("can_publish"):
        return serve_state
    try:
        serve_state, _created = EXPO_PUBLIC_GATEWAY.publish(
            record.run_id,
            Path(record.workspace) / "dist" / "harmony-go",
        )
    except (ExpoExportValidationError, ExpoGatewayError) as exc:
        serve_state = EXPO_PUBLIC_GATEWAY.describe(record.run_id, can_publish=can_publish)
        serve_state["status"] = "failed"
        serve_state["error"] = str(exc)
    return serve_state


def build_expo_progress_payload(record: RunRecord) -> dict[str, Any]:
    workspace = Path(record.workspace)
    expo_state = load_expo_fast_state(workspace)
    run_status = expo_fast_run_status(record, expo_state)
    follow_up_private = load_follow_up_status(record, expo_state)
    if run_status == "completed" and expo_preview_source_outdated(record):
        start_expo_preview_refresh_monitor(record)
    hap_result = load_expo_hap_result(workspace)
    hap_path = resolve_expo_hap_artifact(workspace, hap_result)
    package_status = expo_hap_status(expo_state, hap_result, run_status, bool(hap_path))
    package_error = expo_hap_package_error(hap_result, package_status, bool(hap_path))
    if run_status == "completed":
        record = sync_expo_package_status(record, package_status, package_error)
        record, _preview_started = maybe_refresh_desktop_preview(record, run_status)

    preview_payloads = build_expo_preview_payloads(record, workspace, run_status)
    phone_session = preview_sessions_payload(record)["phone"]
    phone_query = "preview=phone"
    preview_payloads["phone"] = {
        **preview_payloads.get("phone", {}),
        **phone_session,
        "capture_status": phone_session["status"],
        "media_ready": bool(phone_session.get("screenshot_path")),
        "media_path": f"/api/runs/{record.run_id}/media?{phone_query}" if phone_session.get("screenshot_path") else "",
        "media_source_path": str(phone_session.get("screenshot_path") or ""),
        "media_type": "jpeg" if phone_session.get("screenshot_path") else "",
        "live_ready": bool(phone_session.get("live_available")),
        "live_frame_path": f"/api/runs/{record.run_id}/live/frame?{phone_query}" if phone_session.get("live_available") else "",
        "live_input_path": f"/api/runs/{record.run_id}/live/input?{phone_query}" if phone_session.get("live_available") else "",
        "live_webrtc_config_path": f"/api/runs/{record.run_id}/live/webrtc/config?{phone_query}" if phone_session.get("live_available") and WEBRTC_PREVIEW is not None else "",
    }
    primary_preview_kind = normalize_preview_kind(record)
    primary_preview = preview_payloads.get(primary_preview_kind, {})
    media_path = Path(str(primary_preview.get("media_source_path"))) if primary_preview.get("media_source_path") else None
    state_name = str((expo_state or {}).get("state") or "").strip().lower()
    detail = str((expo_state or {}).get("detail") or "").strip().lower()
    detail_label = str((expo_state or {}).get("detailLabel") or "").strip()
    trace_groups = load_expo_claude_trace_groups(workspace, expo_state)
    follow_up_trace = load_follow_up_trace(follow_up_private)
    follow_up = redact_follow_up_transcript_path(follow_up_private)
    hpack_manifest = load_hpack_manifest(record.run_id)
    record = load_run(record.run_id) or record
    if (
        run_status == "completed"
        and package_status == "ready"
        and hap_path
        and not hpack_manifest
        and not expo_preview_source_outdated(record)
    ):
        start_hpack_packaging(record)
        record = load_run(record.run_id) or record
    manifest_ready = bool(hpack_manifest and hpack_manifest.get("status") == "ready")
    newer_hap = newer_hap_available(record.run_id, workspace, record.created_at)
    follow_up_changed = follow_up_changed_after_manifest(
        follow_up_private,
        hpack_manifest,
        record.latest_adjustment_at,
    )
    package_outdated = bool(
        manifest_ready
        and (
            follow_up_changed
            or package_revision_outdated(
                record.latest_adjustment_at,
                record.package_source_adjustment_at,
            )
        )
    )
    package_in_flight = bool(
        record.run_id in HPACK_PACKAGE_IN_FLIGHT or process_alive(record.distribution_process_pid)
    )
    runtime_rebuild_in_flight = expo_runtime_operation_in_flight(record)
    preview_source_outdated = expo_preview_source_outdated(record)
    preview_refresh_in_flight = expo_preview_refresh_in_flight(record)
    preview_refresh_pending = bool(
        preview_source_outdated
        and (
            preview_refresh_in_flight
            or record.preview_refresh_status in {"queued", "building"}
        )
    )
    package_operation_ready = expo_package_operation_ready(record, run_status, follow_up_private)
    install_ready = manifest_ready and not package_outdated and not package_in_flight
    latest_unsigned_ready = bool(hap_path and (not manifest_ready or newer_hap))
    if not HPACK_ENABLED:
        distribution_status = "disabled"
    elif package_in_flight:
        distribution_status = "packaging"
    elif runtime_rebuild_in_flight or preview_refresh_pending:
        distribution_status = "building"
    elif install_ready:
        distribution_status = "ready"
    elif record.distribution_status == "failed" or (
        hpack_manifest and hpack_manifest.get("status") == "failed"
    ):
        distribution_status = "failed"
    elif package_outdated and not newer_hap:
        distribution_status = "waiting_update"
    elif hap_path:
        distribution_status = "ready_to_package"
    else:
        distribution_status = "waiting_hap"

    if manifest_ready and not record.first_install_url:
        first_url = str(hpack_manifest.get("install_url") or "")
        if first_url:
            record.first_install_url = first_url
            record.first_manifest_url = str(hpack_manifest.get("manifest_url") or "")
            record.first_install_store_url = (
                str(hpack_manifest.get("install_store_url") or "")
                or build_install_store_url(record.first_manifest_url)
            )
            record.first_ready_at = to_iso()
            record = save_run(record)

    serve_state = ensure_expo_publication(record, can_publish=run_status == "completed")
    events = [
        {
            "kind": "run",
            "timestamp": record.created_at,
            "summary": f"已提交 Expo 任务并启动后端会话: {record.session_name}",
        },
        *summarize_expo_fast_events(expo_state),
        *summarize_hpack_events(hpack_manifest),
    ]
    package_event = {
        "ready": "unsigned HAP 构建完成，可以下载。",
        "failed": "unsigned HAP 构建失败；bundle 仍可发布。",
        "skipped": "本次未启用 unsigned HAP 构建。",
    }.get(package_status)
    if package_event:
        events.append(
            {
                "kind": "package",
                "timestamp": (hap_result or {}).get("completedAt")
                or record.expo_package_updated_at
                or (expo_state or {}).get("updatedAt"),
                "summary": package_event,
            }
        )

    package_label = {
        "waiting_generation": "等待代码生成",
        "building": "正在构建 unsigned HAP",
        "ready": "unsigned HAP 已就绪",
        "failed": "unsigned HAP 构建失败",
        "skipped": "未启用 HAP 构建",
    }.get(package_status, package_status)
    waiting_message = {
        "preparing": "正在准备 Expo 工程与能力索引…",
        "model_generation": "Expo Runtime 正在生成应用代码…",
        "verification": "正在验证 Expo 生成结果…",
        "model_repair": "正在修复 Expo 应用…",
        "repair_verification": "正在验证修复结果…",
        "launching": "正在 Harmony Go 中启动并检查应用…",
        "preview_queued": "PC 预览正在等待可用的桌面模拟器，手机预览可按需启动…",
        "preview_failed": "生成产物已完成，设备预览失败，可稍后重新预览。",
        "hap_building": "正在等待空闲 slot 并构建 unsigned HAP…",
        "done": "Expo 生成流程已完成。",
        "error": "Expo 生成失败，请查看左侧状态。",
    }.get(detail, detail_label or "Expo Runtime 正在启动…")

    return {
        "run": asdict(record),
        "runtime": "expo",
        "preview_policy": preview_policy(record),
        "preview_sessions": preview_sessions_api_payload(record),
        "workspace": {
            "path": str(workspace),
            "configured": workspace.is_dir(),
        },
        "tmux": {
            "session_name": record.session_name,
            "state": None,
            "active_lane": None,
        },
        "expo": {
            "state": expo_state,
            "trace_groups": trace_groups,
            "package": {
                "status": package_status,
                "label": package_label,
                "updated_at": (hap_result or {}).get("completedAt") or record.expo_package_updated_at,
                "error": package_error,
                "duration_ms": (hap_result or {}).get("durationMs") or 0,
                "sha256": (hap_result or {}).get("hapSha256") or "",
                "bundle_name": (hap_result or {}).get("bundleName") or "",
                "slot_id": (hap_result or {}).get("slotId") or "",
            },
            "serve": serve_state,
        },
        "autopilot": None,
        "compact": None,
        "capture": {
            "status": str(primary_preview.get("capture_status") or "waiting_launch"),
            "process_pid": None,
            "command": [],
            "manifest": None,
        },
        "distribution": {
            "enabled": HPACK_ENABLED,
            "status": distribution_status,
            "process_pid": record.distribution_process_pid,
            "command": record.distribution_command,
            "manifest": hpack_manifest,
        },
        "signing": build_signing_payload(record),
        "status": run_status,
        "stage": detail or state_name or "waiting",
        "events": events[-20:],
        "questions": {"pending": [], "answered": [], "stale": []},
        "artifacts": {
            "hap_found": bool(hap_path),
            "hap_path": str(hap_path) if hap_path else "",
            "hap_display_path": relative_to_root(hap_path, workspace) if hap_path else "",
            "hap_download_path": f"/api/runs/{record.run_id}/hap" if hap_path else "",
            "hap_qr_path": f"/api/runs/{record.run_id}/hap-qr" if hap_path else "",
            "install_ready": install_ready,
            "install_url": str(hpack_manifest.get("install_url") or "") if hpack_manifest else "",
            "install_store_url": str(hpack_manifest.get("install_store_url") or "")
            if hpack_manifest and hpack_manifest.get("manifest_url")
            else build_install_store_url(str(hpack_manifest.get("manifest_url") or ""))
            if hpack_manifest
            else "",
            "manifest_url": str(hpack_manifest.get("manifest_url") or "") if hpack_manifest else "",
            "install_qr_path": f"/api/runs/{record.run_id}/install-qr" if install_ready else "",
            "first_install_ready": bool(record.first_install_url),
            "first_install_url": record.first_install_url,
            "first_install_store_url": record.first_install_store_url,
            "first_manifest_url": record.first_manifest_url,
            "first_install_qr_path": f"/api/runs/{record.run_id}/install-qr?version=first"
            if record.first_install_url
            else "",
            "signed_hap_path": str(hpack_manifest.get("signed_hap_path") or "") if hpack_manifest else "",
            "signed_hap_url": str(hpack_manifest.get("signed_hap_url") or "") if hpack_manifest else "",
            "distribution_status": distribution_status,
            "distribution_error": str(hpack_manifest.get("error") or "")
            if hpack_manifest
            else package_error
            or (str((expo_state or {}).get("error") or "") if run_status == "failed" else ""),
            "package_can_start": bool(
                HPACK_ENABLED
                and (latest_unsigned_ready or package_outdated)
                and package_operation_ready
                and not package_in_flight
                and not runtime_rebuild_in_flight
                and not preview_refresh_pending
                and not install_ready
            ),
            "package_current": install_ready,
            "package_outdated": package_outdated,
            "preview_source_outdated": preview_source_outdated,
            "preview_refresh_status": record.preview_refresh_status,
            "preview_refresh_error": record.preview_refresh_error,
            "media_ready": bool(media_path),
            "media_path": f"/api/runs/{record.run_id}/media" if media_path else "",
            "media_source_path": str(media_path) if media_path else "",
            "media_type": media_path.suffix.lower().lstrip(".") if media_path else "",
            "live_ready": bool(primary_preview.get("live_ready")),
            "live_frame_path": str(primary_preview.get("live_frame_path") or ""),
            "live_input_path": str(primary_preview.get("live_input_path") or ""),
            "live_webrtc_config_path": str(primary_preview.get("live_webrtc_config_path") or ""),
            "previews": preview_payloads,
            "newer_hap_available": newer_hap,
        },
        "follow_up": follow_up,
        "follow_up_trace": follow_up_trace,
        "ui": {
            "poll_interval_ms": 1000,
            "waiting_message": waiting_message,
        },
    }


def build_progress_payload(record: RunRecord) -> dict[str, Any]:
    if record.runtime == "expo":
        return build_expo_progress_payload(record)
    workspace = Path(record.workspace)
    # 服务重启后也能恢复尚未完成的首版本自动签名监视。
    if not record.first_install_url:
        start_initial_package_monitor(record)
    run_state = load_tmux_run_state(workspace, record.session_name)
    lane = current_lane(run_state)
    session_id = None
    if run_state:
        session_id = lane.get("claude_session_id") or run_state.get("claude_session_id")
    autopilot_state = load_autopilot_state(workspace, session_id)
    compact_diagnostics = load_compact_diagnostics(workspace, session_id)
    capture_manifest = load_capture_manifest(record.run_id)
    hpack_manifest = load_hpack_manifest(record.run_id)
    questions = load_ask_user_questions(workspace)

    transcript_path = None
    if run_state:
        transcript_str = lane.get("transcript_path") or run_state.get("transcript_path")
        if transcript_str:
            transcript_path = Path(transcript_str)

    events = [
        {
            "kind": "run",
            "timestamp": record.created_at,
            "summary": f"已提交任务并启动后端会话: {record.session_name}",
        }
    ]
    if run_state:
        events.append(
            {
                "kind": "status",
                "timestamp": run_state.get("updated_at"),
                "summary": (
                    f"当前 lane: {run_state.get('active_lane') or 'planning'}，"
                    f"阶段: {run_state.get('current_stage') or lane.get('current_stage') or 'unknown'}，"
                    f"状态: {run_state.get('status') or 'active'}"
                ),
            }
        )
    if autopilot_state:
        events.extend(summarize_stage_history(autopilot_state.get("stage_history") or []))
    events.extend(summarize_compact_events(compact_diagnostics))
    events.extend(summarize_capture_events(capture_manifest))
    events.extend(summarize_hpack_events(hpack_manifest))
    for item in questions.get("pending", []):
        tool_input = item.get("toolInput") if isinstance(item, dict) else {}
        question_count = len(tool_input.get("questions") or []) if isinstance(tool_input, dict) else 0
        events.append(
            {
                "kind": "question",
                "timestamp": item.get("createdAt"),
                "summary": f"等待用户回答 {question_count or 1} 个问题。",
            }
        )
    if transcript_path:
        events.extend(extract_recent_transcript_events(transcript_path))

    deduped: list[dict[str, Any]] = []
    seen: set[tuple[Any, Any, Any]] = set()
    for item in sorted(events, key=lambda value: value.get("timestamp") or ""):
        key = (item.get("kind"), item.get("timestamp"), item.get("summary"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)

    hap_path = find_latest_hap(workspace, record.created_at)
    phone_session = preview_sessions_payload(record)["phone"]
    capture_status = str(phone_session.get("status") or "idle")
    media_path = Path(str(phone_session.get("screenshot_path") or ""))
    if not media_path.is_file():
        media_path = None

    run_status = record.status
    if run_state and run_state.get("status"):
        run_status = str(run_state.get("status"))
    elif record.status == "running" and not process_alive(record.process_pid):
        run_status = "failed"

    # ArkPilot owns follow-up 的 FIFO、空闲确认和中断恢复。Remote UI 只读取 CLI 状态镜像。
    follow_up_private = load_follow_up_status(record, run_state)
    follow_up_trace = load_follow_up_trace(follow_up_private)
    follow_up = redact_follow_up_transcript_path(follow_up_private)

    manifest_ready = bool(hpack_manifest and hpack_manifest.get("status") == "ready")
    newer_hap = newer_hap_available(record.run_id, workspace, record.created_at)
    follow_up_changed = follow_up_changed_after_manifest(
        follow_up_private,
        hpack_manifest,
        record.latest_adjustment_at,
    )
    # 预览采集和 HPack 都可能为同一份源码重建 unsigned HAP，mtime 变化本身
    # 不能说明二维码已过期。只有签名之后确实提交过续跑调整，才将安装包标旧。
    package_outdated = bool(
        manifest_ready
        and (
            follow_up_changed
            or package_revision_outdated(
                record.latest_adjustment_at,
                record.package_source_adjustment_at,
            )
        )
    )
    package_tracked = record.run_id in HPACK_PACKAGE_IN_FLIGHT
    package_process_alive = process_alive(record.distribution_process_pid)
    package_in_flight = bool(
        package_tracked or package_process_alive
    )
    install_ready = manifest_ready and not package_outdated and not package_in_flight
    qa_status = load_ui_qa_status(workspace, record.session_name)
    qa_gate_ready = package_qa_gate_ready(package_outdated, qa_status)
    follow_up_busy = str(follow_up.get("status") or "") in {"starting", "running", "interrupting"}
    latest_unsigned_ready = bool(hap_path and (not manifest_ready or newer_hap))
    package_can_start = bool(
        HPACK_ENABLED
        and latest_unsigned_ready
        and qa_gate_ready
        and not follow_up_busy
        and not package_in_flight
        and not install_ready
    )

    if not HPACK_ENABLED:
        distribution_status = "disabled"
    elif package_in_flight:
        distribution_status = "packaging"
    elif install_ready:
        distribution_status = "ready"
    elif record.distribution_status in {"failed", "packaging"} or (
        hpack_manifest and hpack_manifest.get("status") == "failed"
    ):
        distribution_status = "failed"
    elif package_outdated and not newer_hap:
        distribution_status = "waiting_update"
    elif hap_path and qa_gate_ready:
        distribution_status = "ready_to_package"
    else:
        distribution_status = "waiting_hap"

    # 首版本二维码：首次签名成功时持久化 install 信息，之后不再覆盖
    if manifest_ready and not record.first_install_url:
        first_url = str(hpack_manifest.get("install_url") or "")
        if first_url:
            record.first_install_url = first_url
            record.first_manifest_url = str(hpack_manifest.get("manifest_url") or "")
            record.first_install_store_url = (
                str(hpack_manifest.get("install_store_url") or "")
                or build_install_store_url(record.first_manifest_url)
            )
            record.first_ready_at = to_iso()
            record = save_run(record)

    stage = None
    if autopilot_state:
        pipeline = autopilot_state.get("pipeline") or {}
        index = pipeline.get("currentStageIndex")
        stages = pipeline.get("stages") or []
        if isinstance(index, int) and 0 <= index < len(stages):
            stage = stages[index].get("id")
    if run_state and not stage:
        stage = run_state.get("current_stage")

    phone_query = "preview=phone"
    phone_preview = {
        **phone_session,
        "capture_status": phone_session["status"],
        "media_ready": bool(phone_session.get("screenshot_path")),
        "media_path": f"/api/runs/{record.run_id}/media?{phone_query}" if phone_session.get("screenshot_path") else "",
        "media_source_path": str(phone_session.get("screenshot_path") or ""),
        "media_type": "jpeg" if phone_session.get("screenshot_path") else "",
        "live_ready": bool(phone_session.get("live_available")),
        "live_frame_path": f"/api/runs/{record.run_id}/live/frame?{phone_query}" if phone_session.get("live_available") else "",
        "live_input_path": f"/api/runs/{record.run_id}/live/input?{phone_query}" if phone_session.get("live_available") else "",
        "live_webrtc_config_path": f"/api/runs/{record.run_id}/live/webrtc/config?{phone_query}" if phone_session.get("live_available") and WEBRTC_PREVIEW is not None else "",
    }
    return {
        "run": asdict(record),
        "preview_policy": preview_policy(record),
        "preview_sessions": preview_sessions_api_payload(record),
        "workspace": {
            "path": str(workspace),
            "configured": workspace.is_dir(),
        },
        "tmux": {
            "session_name": record.session_name,
            "state": run_state,
            "active_lane": lane,
        },
        "autopilot": autopilot_state,
        "compact": compact_diagnostics,
        "capture": {
            "status": capture_status,
            "process_pid": record.capture_process_pid,
            "command": record.capture_command,
            "manifest": capture_manifest,
        },
        "distribution": {
            "enabled": HPACK_ENABLED,
            "status": distribution_status,
            "process_pid": record.distribution_process_pid,
            "command": record.distribution_command,
            "manifest": hpack_manifest,
        },
        "signing": build_signing_payload(record),
        "status": run_status,
        "stage": stage or "waiting",
        "events": deduped[-20:],
        "questions": questions,
        "artifacts": {
            "hap_found": bool(hap_path),
            "hap_path": str(hap_path) if hap_path else "",
            "hap_display_path": relative_to_root(hap_path, workspace) if hap_path else "",
            "hap_download_path": f"/api/runs/{record.run_id}/hap" if hap_path else "",
            "hap_qr_path": f"/api/runs/{record.run_id}/hap-qr" if hap_path else "",
            "install_ready": install_ready,
            "install_url": str(hpack_manifest.get("install_url") or "") if hpack_manifest else "",
            "install_store_url": str(hpack_manifest.get("install_store_url") or "")
            if hpack_manifest and hpack_manifest.get("manifest_url")
            else build_install_store_url(str(hpack_manifest.get("manifest_url") or ""))
            if hpack_manifest
            else "",
            "manifest_url": str(hpack_manifest.get("manifest_url") or "") if hpack_manifest else "",
            "install_qr_path": f"/api/runs/{record.run_id}/install-qr"
            if install_ready
            else "",
            "first_install_ready": bool(record.first_install_url),
            "first_install_url": record.first_install_url,
            "first_install_store_url": record.first_install_store_url,
            "first_manifest_url": record.first_manifest_url,
            "first_install_qr_path": f"/api/runs/{record.run_id}/install-qr?version=first"
            if record.first_install_url
            else "",
            "signed_hap_path": str(hpack_manifest.get("signed_hap_path") or "") if hpack_manifest else "",
            "signed_hap_url": str(hpack_manifest.get("signed_hap_url") or "") if hpack_manifest else "",
            "distribution_status": distribution_status,
            "distribution_error": str(hpack_manifest.get("error") or "") if hpack_manifest else "",
            "package_can_start": package_can_start,
            "package_current": install_ready,
            "package_outdated": package_outdated,
            "media_ready": bool(media_path),
            "media_path": f"/api/runs/{record.run_id}/media" if media_path else "",
            "media_source_path": str(media_path) if media_path else "",
            "media_type": media_path.suffix.lower().lstrip(".") if media_path else "",
            "live_ready": bool(phone_session.get("live_available")),
            "live_frame_path": phone_preview["live_frame_path"],
            "live_input_path": phone_preview["live_input_path"],
            "live_webrtc_config_path": phone_preview["live_webrtc_config_path"],
            "previews": {"phone": phone_preview},
            "newer_hap_available": newer_hap,
        },
        "follow_up": follow_up,
        "follow_up_trace": follow_up_trace,
        "ui": {
            "poll_interval_ms": DEFAULT_POLL_INTERVAL_MS,
            "waiting_message": (
                "已检测到 HAP，正在申请手机模拟器并安装应用。"
                if capture_status in {"queued", "allocating", "installing", "launching"}
                else f"手机模拟器预览失败：{phone_session.get('error') or '请稍后重试'}"
                if capture_status == "failed"
                else "Building"
                if not media_path
                else "手机模拟器预览已就绪。"
            ),
        },
    }


def run_tmux_in_background(record: RunRecord) -> None:
    workspace = Path(record.workspace)
    if not TMUX_RUNNER_PATH.exists():
        record.status = "failed"
        record.notes = f"tmux-runner 不存在: {TMUX_RUNNER_PATH}"
        release_signing_slot_for_record(record)
        save_run(record)
        return
    if not workspace.is_dir():
        record.status = "failed"
        record.notes = f"目标工作目录不存在或不是文件夹: {workspace}"
        release_signing_slot_for_record(record)
        save_run(record)
        return

    command = build_tmux_command(record)
    record.command = command
    log_path = LOG_DIR / f"{record.run_id}.log"
    log_stream = None
    try:
        log_stream = log_path.open("ab")
        log_stream.write(f"$ {' '.join(command)}\n".encode("utf-8", errors="ignore"))
        log_stream.flush()
        process = subprocess.Popen(
            command,
            cwd=str(APP_ROOT),
            stdout=log_stream,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env=build_tmux_env(record),
        )
        log_stream.close()
    except OSError as exc:
        if log_stream is not None and not log_stream.closed:
            log_stream.close()
        record.status = "failed"
        record.notes = f"启动失败: {exc}"
        release_signing_slot_for_record(record)
        save_run(record)
        return

    record.status = "running"
    record.process_pid = process.pid
    record.notes = f"tmux-runner 已启动，日志: {log_path}"
    save_run(record)
    threading.Thread(target=monitor_tmux_process, args=(record, process, log_path), daemon=True).start()


def monitor_expo_fast_run(
    record: RunRecord,
    launcher: subprocess.Popen[Any],
    log_path: Path,
    *,
    package_after: bool = False,
) -> None:
    exit_code = launcher.wait()
    latest = load_run(record.run_id) or record
    latest.process_pid = None
    state = load_expo_fast_state(Path(latest.workspace))
    if exit_code != 0 and not state:
        latest.status = "failed"
        latest.notes = f"Expo 启动器退出且未生成状态文件。exit_code={exit_code}, log={log_path}"
        release_signing_slot_for_record(latest)
        save_run(latest)
        return
    save_run(latest)

    while True:
        latest = load_run(record.run_id)
        if not latest:
            return
        state = load_expo_fast_state(Path(latest.workspace))
        status = expo_fast_run_status(latest, state)
        if status == "completed":
            latest.status = "completed"
            workspace = Path(latest.workspace)
            hap_result = load_expo_hap_result(workspace)
            hap_path = resolve_expo_hap_artifact(workspace, hap_result)
            package_status = expo_hap_status(state, hap_result, status, bool(hap_path))
            package_error = expo_hap_package_error(hap_result, package_status, bool(hap_path))
            latest = save_run(latest)
            latest = sync_expo_package_status(latest, package_status, package_error)
            ensure_expo_publication(latest, can_publish=True)
            if package_after and hap_path:
                start_hpack_packaging(
                    latest,
                    replace_manifest=hpack_manifest_path(latest.run_id).is_file(),
                )
            elif release_signing_slot_for_record(latest):
                save_run(latest)
            return
        if status == "failed":
            latest.status = "failed"
            error = str((state or {}).get("error") or "").strip()
            latest.notes = error[:1000] or f"Expo Runtime 执行失败，日志: {log_path}"
            release_signing_slot_for_record(latest)
            save_run(latest)
            return
        if latest.status != "running":
            latest.status = "running"
            save_run(latest)
        time.sleep(1)


def run_expo_fast_in_background(
    record: RunRecord,
    *,
    action: str = "initial",
    launch: bool | None = None,
    hap: bool | None = None,
) -> None:
    workspace = Path(record.workspace)
    command = build_expo_fast_command(record, action=action, launch=launch, hap=hap)
    package_after = (action != "preview" if hap is None else hap)
    if EXPO_FAST_LAUNCHER is None or not EXPO_FAST_LAUNCHER.is_file():
        record.status = "failed"
        record.notes = f"Expo Fast 启动器不存在: {EXPO_FAST_LAUNCHER or '<未配置>'}"
        release_signing_slot_for_record(record)
        save_run(record)
        return
    if not workspace.is_dir():
        record.status = "failed"
        record.notes = f"Expo 目标工作目录不存在或不是文件夹: {workspace}"
        release_signing_slot_for_record(record)
        save_run(record)
        return
    if not record.prompt_file or not Path(record.prompt_file).is_file():
        record.status = "failed"
        record.notes = f"Expo Prompt 文件不存在: {record.prompt_file or '<未配置>'}"
        release_signing_slot_for_record(record)
        save_run(record)
        return

    record.command = command
    log_path = LOG_DIR / f"{record.run_id}.expo-fast.log"
    log_stream = None
    try:
        log_stream = log_path.open("ab")
        log_stream.write(f"$ {' '.join(command)}\n".encode("utf-8", errors="ignore"))
        log_stream.flush()
        env = build_expo_fast_env(record)
        process = subprocess.Popen(
            command,
            cwd=str(EXPO_FAST_ROOT or APP_ROOT),
            stdout=log_stream,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env=env,
        )
        log_stream.close()
    except OSError as exc:
        if log_stream is not None and not log_stream.closed:
            log_stream.close()
        record.status = "failed"
        record.notes = f"Expo Runtime 启动失败: {exc}"
        release_signing_slot_for_record(record)
        save_run(record)
        return

    record.status = "running"
    record.process_pid = process.pid
    record.notes = f"Expo Runtime 已启动，日志: {log_path}"
    save_run(record)
    threading.Thread(
        target=monitor_expo_fast_run,
        args=(record, process, log_path),
        kwargs={"package_after": package_after},
        daemon=True,
    ).start()


EXPO_PREVIEW_RETRY_LOCK = threading.Lock()
EXPO_PREVIEW_RETRIES_IN_FLIGHT: set[str] = set()


def run_expo_preview_retry(record: RunRecord) -> None:
    try:
        run_expo_fast_in_background(record, action="preview", launch=True, hap=False)
    finally:
        with EXPO_PREVIEW_RETRY_LOCK:
            EXPO_PREVIEW_RETRIES_IN_FLIGHT.discard(record.run_id)


def lookup_context_value(context: dict[str, Any], key: str) -> Any:
    current: Any = context
    for part in key.split("."):
        if isinstance(current, dict):
            current = current.get(part, "")
        else:
            current = getattr(current, part, "")
    return current


def render_template(template_name: str, context: dict[str, Any]) -> str:
    template_path = APP_ROOT / "templates" / template_name
    content = read_text(template_path)

    def replace(match: re.Match[str]) -> str:
        key = match.group(1).strip()
        value = lookup_context_value(context, key)
        return html.escape(str(value), quote=True)

    return re.sub(r"\{\{\s*([^}]+?)\s*\}\}", replace, content)


class RemoteUIHandler(BaseHTTPRequestHandler):
    server_version = "HarmonyPilotRemoteUI/0.1"

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/":
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            return
        if path.startswith("/static/"):
            return self.handle_static(path, head_only=True)
        if path.startswith("/hpack/"):
            return self.handle_hpack_static(path, head_only=True)
        if path.startswith("/install/"):
            return self.handle_install_static(path, head_only=True)
        if path == "/api/health":
            payload = json.dumps({"ok": True}, ensure_ascii=False).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            return
        if re.fullmatch(r"/runs/[a-f0-9]+", path):
            if not self.load_accessible_run(path.rsplit("/", 1)[-1]):
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            return
        if re.fullmatch(r"/api/runs/[a-f0-9]+/media", path):
            return self.handle_get_media(path.split("/")[-2], head_only=True, query=parse_qs(parsed.query))
        if re.fullmatch(r"/api/runs/[a-f0-9]+/thumbnail", path):
            return self.handle_get_thumbnail(path.split("/")[-2], head_only=True)
        if re.fullmatch(r"/api/runs/[a-f0-9]+/hap", path):
            return self.handle_get_hap(path.split("/")[-2], head_only=True)
        if re.fullmatch(r"/api/runs/[a-f0-9]+/(hap-qr|install-qr)", path):
            if not self.load_accessible_run(path.split("/")[-2]):
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "image/png")
            self.end_headers()
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/":
            return self.handle_home()
        if path.startswith("/static/"):
            return self.handle_static(path)
        if path.startswith("/hpack/"):
            return self.handle_hpack_static(path)
        if path.startswith("/install/"):
            return self.handle_install_static(path)
        if path == "/api/health":
            return self.send_json(
                {
                    "ok": True,
                    "tmux_runner_exists": TMUX_RUNNER_PATH.exists(),
                    "capture_script_exists": HDC_CAPTURE_SCRIPT_PATH.exists(),
                    "hpack_enabled": HPACK_ENABLED,
                    "hpack_packager_exists": HPACK_PACKAGER_SCRIPT_PATH.exists(),
                    "workspace_exists": TARGET_WORKSPACE.exists(),
                    "workspace_is_dir": TARGET_WORKSPACE.is_dir(),
                    "workspace": str(TARGET_WORKSPACE),
                    "workspace_directories": list_workspace_directories(TARGET_WORKSPACE),
                    "expo_fast": {
                        "configured": bool(
                            EXPO_FAST_ROOT
                            and EXPO_FAST_LAUNCHER
                            and EXPO_FAST_LAUNCHER.is_file()
                            and EXPO_FAST_APP_ROOT
                        ),
                        "root": str(EXPO_FAST_ROOT) if EXPO_FAST_ROOT else "",
                        "launcher": str(EXPO_FAST_LAUNCHER) if EXPO_FAST_LAUNCHER else "",
                        "app_root": str(EXPO_FAST_APP_ROOT) if EXPO_FAST_APP_ROOT else "",
                    },
                    "expo_public_gateway": EXPO_PUBLIC_GATEWAY.health(),
                    "qrcode_enabled": qrcode is not None,
                    "webrtc_preview_enabled": WEBRTC_PREVIEW is not None,
                    "profile_pool": profile_pool_status_payload(),
                    "signing_pool": profile_pool_status_payload(),
                }
            )
        if path == "/api/auth/me":
            return self.handle_auth_me()
        if path in {"/api/profile-pool", "/api/signing-pool"}:
            return self.handle_profile_pool_status()
        if path == "/api/runs":
            return self.handle_list_runs()
        if re.fullmatch(r"/runs/[a-f0-9]+", path):
            return self.handle_detail(path.rsplit("/", 1)[-1])
        if re.fullmatch(r"/api/runs/[a-f0-9]+", path):
            return self.handle_get_run(path.rsplit("/", 1)[-1])
        if re.fullmatch(r"/api/runs/[a-f0-9]+/previews", path):
            return self.handle_get_previews(path.split("/")[3])
        if re.fullmatch(r"/api/runs/[a-f0-9]+/questions", path):
            return self.handle_get_run_questions(path.split("/")[-2])
        if re.fullmatch(r"/api/runs/[a-f0-9]+/events", path):
            return self.handle_run_events(path.split("/")[-2])
        if re.fullmatch(r"/api/runs/[a-f0-9]+/media", path):
            return self.handle_get_media(path.split("/")[-2], query=parse_qs(parsed.query))
        if re.fullmatch(r"/api/runs/[a-f0-9]+/live/frame", path):
            return self.handle_get_live_frame(
                path.split("/")[-3],
                query=parse_qs(parsed.query),
            )
        if re.fullmatch(r"/api/runs/[a-f0-9]+/live/webrtc/config", path):
            return self.handle_get_live_webrtc_config(path.split("/")[3], query=parse_qs(parsed.query))
        if re.fullmatch(r"/api/runs/[a-f0-9]+/thumbnail", path):
            return self.handle_get_thumbnail(path.split("/")[-2])
        if re.fullmatch(r"/api/runs/[a-f0-9]+/hap", path):
            return self.handle_get_hap(path.split("/")[-2])
        if re.fullmatch(r"/api/runs/[a-f0-9]+/hap-qr", path):
            return self.handle_get_hap_qr(path.split("/")[-2])
        if re.fullmatch(r"/api/runs/[a-f0-9]+/install-qr", path):
            version = (parse_qs(parsed.query).get("version") or ["latest"])[0]
            return self.handle_get_install_qr(path.split("/")[-2], version=version)
        if re.fullmatch(r"/api/runs/[a-f0-9]+/follow-up", path):
            return self.handle_get_follow_up(path.split("/")[-2])
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/auth/login":
            return self.handle_auth_login()
        if parsed.path == "/api/auth/logout":
            return self.handle_auth_logout()
        if parsed.path == "/api/runs":
            return self.handle_create_run()
        if parsed.path in {"/api/profile-pool/release", "/api/signing-pool/release"}:
            return self.handle_profile_pool_release()
        if re.fullmatch(r"/api/runs/[a-f0-9]+/questions/[a-zA-Z0-9._-]+/answer", parsed.path):
            parts = parsed.path.split("/")
            return self.handle_answer_run_question(parts[3], parts[5])
        if re.fullmatch(r"/api/runs/[a-f0-9]+/follow-up/messages", parsed.path):
            return self.handle_enqueue_follow_up(parsed.path.split("/")[3])
        if re.fullmatch(r"/api/runs/[a-f0-9]+/follow-up/interrupt", parsed.path):
            return self.handle_interrupt_follow_up(parsed.path.split("/")[3])
        if re.fullmatch(r"/api/runs/[a-f0-9]+/package", parsed.path):
            run_id = parsed.path.split("/")[3]
            with expo_run_operation_lock(run_id):
                return self.handle_package_run(run_id)
        if re.fullmatch(r"/api/runs/[a-f0-9]+/expo-serve", parsed.path):
            return self.handle_publish_expo_run(parsed.path.split("/")[3])
        if re.fullmatch(r"/api/runs/[a-f0-9]+/preview/retry", parsed.path):
            return self.handle_retry_expo_preview(parsed.path.split("/")[3])
        if re.fullmatch(r"/api/runs/[a-f0-9]+/previews/(desktop|phone)/start", parsed.path):
            parts = parsed.path.split("/")
            return self.handle_start_preview(parts[3], parts[5])
        if re.fullmatch(r"/api/runs/[a-f0-9]+/previews/(desktop|phone)/release", parsed.path):
            parts = parsed.path.split("/")
            return self.handle_release_preview(parts[3], parts[5])
        if re.fullmatch(r"/api/runs/[a-f0-9]+/previews/(desktop|phone)/heartbeat", parsed.path):
            parts = parsed.path.split("/")
            return self.handle_preview_heartbeat(parts[3], parts[5])
        if re.fullmatch(r"/api/runs/[a-f0-9]+/live/input", parsed.path):
            return self.handle_live_input(parsed.path.split("/")[3], query=parse_qs(parsed.query))
        if re.fullmatch(r"/api/runs/[a-f0-9]+/live/webrtc/offer", parsed.path):
            return self.handle_live_webrtc_offer(parsed.path.split("/")[3], query=parse_qs(parsed.query))
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)
        if re.fullmatch(r"/api/runs/[a-f0-9]+/follow-up/messages/[A-Za-z0-9._-]+", parsed.path):
            parts = parsed.path.split("/")
            return self.handle_update_queued_follow_up(parts[3], parts[6])
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if re.fullmatch(r"/api/runs/[a-f0-9]+/follow-up/messages/[A-Za-z0-9._-]+", parsed.path):
            parts = parsed.path.split("/")
            return self.handle_remove_queued_follow_up(parts[3], parts[6])
        if re.fullmatch(r"/api/runs/[a-f0-9]+/expo-serve", parsed.path):
            return self.handle_unpublish_expo_run(parsed.path.split("/")[3])
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def request_is_secure(self) -> bool:
        proto = (self.headers.get("X-Forwarded-Proto") or "").split(",", 1)[0].strip().lower()
        return proto == "https" or self.headers.get("X-Forwarded-Ssl") == "on"

    def cookie_value(self, name: str) -> str:
        for item in (self.headers.get("Cookie") or "").split(";"):
            cookie_name, separator, value = item.strip().partition("=")
            if separator and cookie_name == name:
                return value
        return ""

    def queue_cookie(self, name: str, value: str, *, max_age: int) -> None:
        queued = getattr(self, "_cookies_to_set", [])
        parts = [name + "=" + value, "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={max_age}"]
        if self.request_is_secure():
            parts.append("Secure")
        queued.append("; ".join(parts))
        self._cookies_to_set = queued

    def send_pending_cookies(self) -> None:
        for value in getattr(self, "_cookies_to_set", []):
            self.send_header("Set-Cookie", value)
        self._cookies_to_set = []

    def visitor_id(self, *, create: bool = False) -> str:
        visitor_id = self.cookie_value(VISITOR_COOKIE_NAME)
        if VISITOR_ID_PATTERN.fullmatch(visitor_id):
            return visitor_id
        if not create:
            return ""
        visitor_id = secrets.token_urlsafe(32)
        self.queue_cookie(VISITOR_COOKIE_NAME, visitor_id, max_age=VISITOR_COOKIE_MAX_AGE_SEC)
        return visitor_id

    def is_root(self) -> bool:
        return root_session_is_valid(self.cookie_value(ROOT_SESSION_COOKIE_NAME))

    def load_accessible_run(self, run_id: str, *, allow_share: bool = False) -> RunRecord | None:
        record = load_run(run_id)
        if not record:
            self.send_error(HTTPStatus.NOT_FOUND, "Run not found")
            return None
        if self.is_root():
            return record
        if record.owner_id and hmac.compare_digest(record.owner_id, self.visitor_id()):
            return record
        share_token = (parse_qs(urlparse(self.path).query).get("share") or [""])[0]
        if allow_share and record.share_token and hmac.compare_digest(record.share_token, share_token):
            return record
        self.send_error(HTTPStatus.NOT_FOUND, "Run not found")
        return None

    def read_body_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length > 0 else b"{}"
        try:
            payload = json.loads(body.decode("utf-8"))
            return payload if isinstance(payload, dict) else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {}

    def send_json(
        self,
        payload: dict[str, Any],
        status: HTTPStatus = HTTPStatus.OK,
        *,
        headers: dict[str, str] | None = None,
    ) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_pending_cookies()
        self.end_headers()
        self.wfile.write(data)

    def send_html(self, html: str, status: HTTPStatus = HTTPStatus.OK) -> None:
        data = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_pending_cookies()
        self.end_headers()
        self.wfile.write(data)

    def send_bytes(
        self,
        data: bytes,
        content_type: str,
        status: HTTPStatus = HTTPStatus.OK,
        *,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_pending_cookies()
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, file_path: Path, download_name: str | None = None) -> None:
        if not file_path.exists() or not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return
        content_type = content_type_for_path(file_path)
        size = file_path.stat().st_size
        byte_range = self.parse_byte_range(size)
        if byte_range == "invalid":
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            return
        start = 0
        end = size - 1
        status = HTTPStatus.OK
        if byte_range is not None:
            start, end = byte_range
            status = HTTPStatus.PARTIAL_CONTENT
        length = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if download_name:
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        with file_path.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining > 0:
                chunk = handle.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def send_file_head(self, file_path: Path, download_name: str | None = None) -> None:
        if not file_path.exists() or not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return
        content_type = content_type_for_path(file_path)
        size = file_path.stat().st_size
        byte_range = self.parse_byte_range(size)
        if byte_range == "invalid":
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            return
        start = 0
        end = size - 1
        status = HTTPStatus.OK
        if byte_range is not None:
            start, end = byte_range
            status = HTTPStatus.PARTIAL_CONTENT
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if download_name:
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(max(0, end - start + 1)))
        self.end_headers()

    def parse_byte_range(self, size: int) -> tuple[int, int] | str | None:
        range_header = (self.headers.get("Range") or "").strip()
        if not range_header:
            return None
        if not range_header.startswith("bytes=") or "," in range_header:
            return "invalid"
        spec = range_header.removeprefix("bytes=").strip()
        if "-" not in spec:
            return "invalid"
        start_text, end_text = spec.split("-", 1)
        try:
            if start_text == "":
                suffix_length = int(end_text)
                if suffix_length <= 0:
                    return "invalid"
                start = max(size - suffix_length, 0)
                end = size - 1
            else:
                start = int(start_text)
                end = int(end_text) if end_text else size - 1
        except ValueError:
            return "invalid"
        if start < 0 or end < start or start >= size:
            return "invalid"
        return start, min(end, size - 1)

    def request_origin(self) -> str:
        proto = (self.headers.get("X-Forwarded-Proto") or "").split(",", 1)[0].strip()
        if not proto:
            proto = "https" if self.headers.get("X-Forwarded-Ssl") == "on" else "http"
        host = (
            (self.headers.get("X-Forwarded-Host") or "").split(",", 1)[0].strip()
            or (self.headers.get("Host") or "").strip()
        )
        if not host:
            host = f"{self.server.server_address[0]}:{self.server.server_address[1]}"
        return f"{proto}://{host}"

    def build_absolute_url(self, path: str) -> str:
        return f"{self.request_origin()}{path}"

    def generate_qr_png(self, content: str) -> bytes:
        if qrcode is None:
            raise RuntimeError("缺少 qrcode 依赖，请先执行 pip install -r requirements.txt")
        qr = qrcode.QRCode(
            version=None,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=10,
            border=4,
        )
        qr.add_data(content)
        qr.make(fit=True)
        image = qr.make_image(fill_color="black", back_color="white")
        buffer = BytesIO()
        image.save(buffer, format="PNG")
        return buffer.getvalue()

    def handle_home(self) -> None:
        html = render_template(
            "index.html",
            {
                "default_prompt": "为这个 HarmonyOS 工程实现一个记账应用，并完成构建和运行验证",
                "workspace": str(TARGET_WORKSPACE),
                "variant": DEFAULT_VARIANT,
            },
        )
        self.send_html(html)

    def handle_detail(self, run_id: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        html = render_template(
            "detail.html",
            {
                "run": asdict(record),
                "poll_interval_ms": DEFAULT_POLL_INTERVAL_MS,
                "static_asset_version": int(time.time()),
            },
        )
        self.send_html(html)

    def handle_static(self, path: str, *, head_only: bool = False) -> None:
        relative = path.removeprefix("/static/")
        file_path = (APP_ROOT / "static" / relative).resolve()
        static_root = (APP_ROOT / "static").resolve()
        try:
            file_path.relative_to(static_root)
        except ValueError:
            self.send_error(HTTPStatus.FORBIDDEN, "Forbidden")
            return
        if head_only:
            self.send_file_head(file_path)
        else:
            self.send_file(file_path)

    def handle_hpack_static(self, path: str, *, head_only: bool = False) -> None:
        if HPACK_STATIC_ROOT is None:
            self.send_error(HTTPStatus.NOT_FOUND, "HPack static root is not configured")
            return
        serve_hpack_static(
            HPACK_STATIC_ROOT,
            path,
            prefix="/hpack/",
            send_file=self.send_file,
            send_file_head=self.send_file_head,
            send_error=lambda code, message: self.send_error(code, message),
            head_only=head_only,
        )

    def handle_install_static(self, path: str, *, head_only: bool = False) -> None:
        if HPACK_STATIC_ROOT is None:
            self.send_error(HTTPStatus.NOT_FOUND, "HPack static root is not configured")
            return
        serve_hpack_static(
            HPACK_STATIC_ROOT,
            path,
            prefix="/install/",
            send_file=self.send_file,
            send_file_head=self.send_file_head,
            send_error=lambda code, message: self.send_error(code, message),
            head_only=head_only,
        )

    def handle_create_run(self) -> None:
        payload = self.read_body_json()
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            self.send_json({"error": "prompt is required"}, status=HTTPStatus.BAD_REQUEST)
            return

        runtime = str(payload.get("runtime") or "arkpilot").strip().lower()
        if runtime not in {"arkpilot", "expo"}:
            self.send_json({"error": f"unsupported runtime: {runtime}"}, status=HTTPStatus.BAD_REQUEST)
            return
        if runtime == "arkpilot" and not TARGET_WORKSPACE.parts:
            self.send_json(
                {"error": "ArkPilot 工作目录未配置，请设置 HP_TARGET_WORKSPACE。"},
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return

        pool = get_signing_pool() if runtime == "arkpilot" or (runtime == "expo" and HPACK_ENABLED) else None
        if runtime == "expo" and HPACK_ENABLED and pool is None:
            self.send_json(
                {"error": "Expo 手机安装需要可用的 Profile 池，请检查 HP_PROFILE_POOL_CONFIG。"},
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return
        if pool:
            pool.cleanup_stale()

        run_id = uuid4().hex
        workspace = Path(str(payload.get("workspace") or TARGET_WORKSPACE)).expanduser().resolve()
        variant = str(payload.get("variant") or DEFAULT_VARIANT).strip()
        plan_skill = str(payload["plan_skill"]).strip() if "plan_skill" in payload else DEFAULT_PLAN_SKILL
        interactive_questions = payload.get("interactive_questions") is True
        owner_id = self.visitor_id(create=True)
        session_name = build_tmux_session_name(run_id)
        signing_slot = None
        prompt_file = ""

        if runtime == "expo":
            if EXPO_FAST_ROOT is None or EXPO_FAST_LAUNCHER is None or not EXPO_FAST_LAUNCHER.is_file():
                self.send_json(
                    {"error": "Expo Runtime 未配置，请设置 HP_EXPO_FAST_ROOT。"},
                    status=HTTPStatus.SERVICE_UNAVAILABLE,
                )
                return
            if EXPO_FAST_APP_ROOT is None:
                self.send_json(
                    {"error": "Expo 工作目录未配置，请设置 HP_EXPO_FAST_APP_ROOT。"},
                    status=HTTPStatus.SERVICE_UNAVAILABLE,
                )
                return
            project_name = f"remote-ui-{run_id}"
            workspace = (EXPO_FAST_APP_ROOT / project_name).resolve()
            prompt_path = (EXPO_FAST_APP_ROOT / ".expo-fast-inputs" / f"{project_name}.md").resolve()
            session_name = f"expo-fast-{project_name[:32]}"
            variant = "expo-fast"
            plan_skill = ""
            interactive_questions = False
            prompt_file = str(prompt_path)

        if pool:
            signing_slot = pool.acquire(run_id, session_name)
            if not signing_slot:
                status = profile_pool_status_payload()
                self.send_json(
                    {
                        "error": "当前没有空闲 Profile，请稍后再试",
                        "profile_pool": status,
                        "signing_pool": status,
                    },
                    status=HTTPStatus.SERVICE_UNAVAILABLE,
                )
                return
            if runtime == "arkpilot" and PROFILE_POOL_ISOLATE_WORKSPACE:
                workspace = (TARGET_WORKSPACE / run_id).resolve()
            elif runtime == "arkpilot":
                workspace = (TARGET_WORKSPACE / "current").resolve()

        if runtime == "expo":
            try:
                EXPO_FAST_APP_ROOT.mkdir(parents=True, exist_ok=True)
                workspace.mkdir(parents=False, exist_ok=False)
                prompt_path.parent.mkdir(parents=True, exist_ok=True)
                prompt_path.write_text(f"{prompt}\n", encoding="utf-8")
            except FileExistsError:
                if pool and signing_slot:
                    pool.release(run_id)
                self.send_json({"error": f"Expo 目标目录已存在: {workspace}"}, status=HTTPStatus.CONFLICT)
                return
            except OSError as exc:
                if pool and signing_slot:
                    pool.release(run_id)
                try:
                    prompt_path.unlink(missing_ok=True)
                    workspace.rmdir()
                except OSError:
                    pass
                self.send_json({"error": f"创建 Expo 工作目录或 Prompt 失败: {exc}"}, status=HTTPStatus.BAD_REQUEST)
                return

        if runtime == "arkpilot":
            target_root = TARGET_WORKSPACE.expanduser().resolve()
            if workspace == target_root:
                workspace = (target_root / "current").resolve()
            elif target_root not in workspace.parents:
                self.send_json(
                    {"error": f"ArkPilot 工作目录必须位于 HP_TARGET_WORKSPACE 下: {target_root}"},
                    status=HTTPStatus.BAD_REQUEST,
                )
                return
            try:
                if pool and PROFILE_POOL_ISOLATE_WORKSPACE:
                    clear_workspace_contents(workspace)
                else:
                    stop_existing_workspace_runs(workspace)
                    clear_workspace_contents(workspace)
            except RuntimeError as exc:
                if pool and signing_slot:
                    pool.release(run_id)
                self.send_json({"error": f"停止旧构建失败: {exc}"}, status=HTTPStatus.CONFLICT)
                return
            except (OSError, ValueError) as exc:
                if pool and signing_slot:
                    pool.release(run_id)
                self.send_json({"error": f"清空工作目录失败: {exc}"}, status=HTTPStatus.BAD_REQUEST)
                return

        record = RunRecord(
            run_id=run_id,
            session_name=session_name,
            prompt=prompt,
            workspace=str(workspace),
            variant=variant,
            plan_skill=plan_skill,
            interactive_questions=interactive_questions,
            owner_id=owner_id,
            share_token=secrets.token_urlsafe(24),
            created_at=to_iso(),
            updated_at=to_iso(),
            status="queued",
            runtime=runtime,
            prompt_file=prompt_file,
            preview_targets={},
        )
        if signing_slot:
            try:
                apply_signing_slot_to_record(record, signing_slot)
            except ValueError as exc:
                pool.release(run_id)
                self.send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
                return
        save_run(record)
        if runtime == "expo":
            threading.Thread(target=run_expo_fast_in_background, args=(record,), daemon=True).start()
        else:
            threading.Thread(target=run_tmux_in_background, args=(record,), daemon=True).start()
            # 首版本等待 QA 与手机 HAP 预览稳定后自动签名；后续调整仍由按钮手动更新。
            start_initial_package_monitor(record)
            start_phone_preview_monitor(record)
        response: dict[str, Any] = {
            "run_id": run_id,
            "detail_url": f"/runs/{run_id}",
            "runtime": runtime,
        }
        if record.signing_slot_id:
            response["signing_slot_id"] = record.signing_slot_id
            response["signing_bundle_name"] = record.signing_bundle_name
        self.send_json(response, status=HTTPStatus.CREATED)

    def handle_auth_me(self) -> None:
        self.send_json(
            {
                "role": "root" if self.is_root() else "guest",
                "root_login_enabled": root_auth_enabled(),
            }
        )

    def handle_auth_login(self) -> None:
        if not root_auth_enabled():
            self.send_json({"error": "管理员登录尚未配置"}, status=HTTPStatus.SERVICE_UNAVAILABLE)
            return
        client_ip = self.client_address[0]
        if login_is_limited(client_ip):
            self.send_json({"error": "登录尝试过多，请十分钟后重试"}, status=HTTPStatus.TOO_MANY_REQUESTS)
            return
        password = str(self.read_body_json().get("password") or "")
        if not password or not verify_root_password(password):
            record_failed_login(client_ip)
            self.send_json({"error": "管理员密码错误"}, status=HTTPStatus.UNAUTHORIZED)
            return
        clear_failed_logins(client_ip)
        self.queue_cookie(ROOT_SESSION_COOKIE_NAME, create_root_session(), max_age=ROOT_SESSION_MAX_AGE_SEC)
        self.send_json({"role": "root", "root_login_enabled": True})

    def handle_auth_logout(self) -> None:
        self.queue_cookie(ROOT_SESSION_COOKIE_NAME, "", max_age=0)
        self.send_json({"role": "guest", "root_login_enabled": root_auth_enabled()})

    def handle_profile_pool_status(self) -> None:
        self.send_json(profile_pool_status_payload())

    handle_signing_pool_status = handle_profile_pool_status

    def handle_profile_pool_release(self) -> None:
        payload = self.read_body_json()
        run_id = str(payload.get("run_id") or "").strip()
        if not run_id:
            self.send_json({"error": "run_id is required"}, status=HTTPStatus.BAD_REQUEST)
            return
        record = self.load_accessible_run(run_id)
        if not record:
            return
        released = release_signing_slot_for_record(record)
        if released:
            save_run(record)
        self.send_json(
            {
                "released": released,
                "run_id": run_id,
                "profile_pool": profile_pool_status_payload(),
                "signing_pool": profile_pool_status_payload(),
            }
        )

    handle_signing_pool_release = handle_profile_pool_release

    def handle_list_runs(self) -> None:
        visitor_id = self.visitor_id()
        records = (
            iter_run_records()
            if self.is_root()
            else [
                record
                for record in iter_run_records()
                if visitor_id and record.owner_id and hmac.compare_digest(record.owner_id, visitor_id)
            ]
        )
        summaries: list[dict[str, Any]] = []
        for record in records:
            run_status = record.status
            capture_manifest = load_capture_manifest(record.run_id)
            hpack_manifest = load_hpack_manifest(record.run_id)
            if record.runtime == "expo":
                try:
                    run_status = expo_fast_run_status(
                        record,
                        load_expo_fast_state(Path(record.workspace)),
                    )
                except Exception:
                    run_status = record.status
            else:
                try:
                    run_state = load_tmux_run_state(Path(record.workspace), record.session_name)
                    if run_state and run_state.get("status"):
                        run_status = str(run_state.get("status"))
                    elif record.status == "running" and not process_alive(record.process_pid):
                        run_status = "failed"
                except Exception:
                    run_status = record.status
            try:
                media_path = find_latest_media(
                    record.run_id, Path(record.workspace), record.created_at
                )
            except Exception:
                media_path = None
            try:
                screenshot_path = find_first_screenshot(record.run_id)
            except Exception:
                screenshot_path = None
            media_type = media_path.suffix.lower().lstrip(".") if media_path else ""
            capture_status = str(capture_manifest.get("status") or "") if capture_manifest else ""
            hpack_status = str(hpack_manifest.get("status") or "") if hpack_manifest else ""
            status_key = run_status.lower()
            # The list represents the end-to-end deliverable. A completed
            # tmux run or preview capture only means the build/preview stage
            # finished; it is not installable until HPack has signed and
            # published it successfully.
            package_outdated = package_revision_outdated(
                record.latest_adjustment_at,
                record.package_source_adjustment_at,
            )
            if record.runtime == "expo" and status_key in {"complete", "completed", "done", "succeeded"}:
                display_status = "complete"
            elif record.runtime == "expo" and status_key in {"failed", "error"}:
                display_status = "failed"
            elif record.runtime == "expo":
                display_status = "queued" if status_key in {"queued", "waiting"} else "active"
            elif hpack_status == "ready" and not package_outdated:
                display_status = "complete"
            elif status_key in {"failed", "error"} or capture_status == "failed" or hpack_status == "failed":
                display_status = "failed"
            elif status_key in {"queued", "waiting", "waiting_hap"}:
                display_status = "queued"
            else:
                display_status = "active"
            summaries.append(
                {
                    "run_id": record.run_id,
                    "prompt": record.prompt,
                    "status": display_status,
                    "variant": getattr(record, "variant", "") or "",
                    "runtime": getattr(record, "runtime", "arkpilot") or "arkpilot",
                    "session_name": record.session_name,
                    "created_at": record.created_at,
                    "updated_at": record.updated_at,
                    "notes": getattr(record, "notes", "") or "",
                    "detail_url": f"/runs/{record.run_id}",
                    "has_media": bool(media_path),
                    "media_url": f"/api/runs/{record.run_id}/media" if media_path else "",
                    "media_type": media_type,
                    "has_thumbnail": bool(screenshot_path),
                    "thumbnail_url": f"/api/runs/{record.run_id}/thumbnail" if screenshot_path else "",
                    "default_preview_kind": preview_policy(record)["default_kind"],
                    "preview_summary": {
                        kind: {
                            "status": session.get("status", "idle"),
                            "transport": session.get("transport", ""),
                            "has_screenshot": bool(session.get("screenshot_path")),
                            "live_available": bool(session.get("live_available")),
                        }
                        for kind, session in preview_sessions_payload(record).items()
                    },
                }
            )

        summaries.sort(key=lambda item: item.get("created_at") or "", reverse=True)
        counts: dict[str, int] = {}
        for item in summaries:
            key = str(item.get("status") or "unknown")
            counts[key] = counts.get(key, 0) + 1
        self.send_json({"runs": summaries, "total": len(summaries), "counts": counts})

    def handle_get_run(self, run_id: str) -> None:
        if not self.load_accessible_run(run_id):
            return
        latest = self._compute_run_progress(run_id)
        if latest is None:
            self.send_error(HTTPStatus.NOT_FOUND, "Run not found")
            return
        self.send_json(latest)

    def handle_get_previews(self, run_id: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        self.send_json({
            "run_id": run_id,
            "policy": preview_policy(record),
            "previews": preview_sessions_api_payload(record),
        })

    def handle_start_preview(self, run_id: str, kind: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        config = preview_policy(record)["previews"].get(kind)
        if not config:
            self.send_json({"ok": False, "error": "当前模式不支持该预览类型。"}, status=HTTPStatus.CONFLICT)
            return
        try:
            preempted_run_ids = preempt_owner_preview_leases(record, kind)
            mark_preview_viewer(record.run_id, kind, visible=True)
            if kind == "phone" and config.get("transport") == "hap_install":
                record, accepted = start_phone_preview(record)
            elif kind == "desktop" and config.get("transport") == "hap_install":
                record, accepted = start_desktop_preview(record)
            else:
                raise LivePreviewError("当前预览类型的启动方式无效。")
        except LivePreviewError as exc:
            clear_preview_viewer(record.run_id, kind)
            self.send_json({"ok": False, "error": str(exc)}, status=HTTPStatus.CONFLICT)
            return
        self.send_json(
            {
                "ok": True,
                "accepted": accepted,
                "run_id": record.run_id,
                "status": str(preview_sessions_payload(record)[kind].get("status") or "idle"),
                "preview": preview_sessions_api_payload(record)[kind],
                "preempted_run_ids": preempted_run_ids,
            },
            status=HTTPStatus.ACCEPTED if accepted else HTTPStatus.OK,
        )

    def handle_release_preview(self, run_id: str, kind: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        if kind not in preview_policy(record)["previews"]:
            self.send_json({"ok": False, "error": "当前模式不支持该预览类型。"}, status=HTTPStatus.CONFLICT)
            return
        record = release_preview_lease(record, kind)
        self.send_json(
            {
                "ok": True,
                "released": True,
                "run_id": record.run_id,
                "preview": preview_sessions_api_payload(record)[kind],
            }
        )

    def handle_preview_heartbeat(self, run_id: str, kind: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        if kind not in preview_policy(record)["previews"]:
            self.send_json({"ok": False, "error": "当前模式不支持该预览类型。"}, status=HTTPStatus.CONFLICT)
            return
        payload = self.read_body_json()
        visible = payload.get("visible") is True
        session = preview_sessions_payload(record).get(kind, {})
        if str(session.get("status") or "") not in {
            "queued", "allocating", "installing", "loading_bundle", "launching", "ready"
        }:
            clear_preview_viewer(record.run_id, kind)
            self.send_json({"ok": True, "run_id": run_id, "kind": kind, "visible": False})
            return
        mark_preview_viewer(record.run_id, kind, visible=visible)
        self.send_json({"ok": True, "run_id": run_id, "kind": kind, "visible": visible})

    def handle_retry_expo_preview(self, run_id: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        if record.runtime != "expo":
            self.send_json(
                {"ok": False, "error": "只有 Expo Runtime 任务可以重新执行设备预览。"},
                status=HTTPStatus.CONFLICT,
            )
            return
        with EXPO_PREVIEW_RETRY_LOCK:
            if run_id in EXPO_PREVIEW_RETRIES_IN_FLIGHT or process_alive(record.process_pid):
                self.send_json(
                    {"ok": False, "error": "Expo 任务仍在运行或等待设备。"},
                    status=HTTPStatus.CONFLICT,
                )
                return
            EXPO_PREVIEW_RETRIES_IN_FLIGHT.add(run_id)
        workspace = Path(record.workspace)
        export_root = workspace / "dist" / "harmony-go"
        if not (workspace / ".expo-fast" / "manifest.json").is_file() or not (
            export_root / ".expo-harmony-go-export"
        ).is_file():
            with EXPO_PREVIEW_RETRY_LOCK:
                EXPO_PREVIEW_RETRIES_IN_FLIGHT.discard(run_id)
            self.send_json(
                {"ok": False, "error": "当前任务还没有可重新预览的 Harmony Go 导出产物。"},
                status=HTTPStatus.CONFLICT,
            )
            return
        record.status = "running"
        record.notes = "已提交设备预览重试，正在重新校验产物并等待空闲模拟器。"
        record.process_pid = None
        record = save_run(record)
        threading.Thread(
            target=run_expo_preview_retry,
            args=(record,),
            daemon=True,
        ).start()
        self.send_json(
            {"ok": True, "accepted": True, "run_id": record.run_id, "status": "preview_queued"},
            status=HTTPStatus.ACCEPTED,
        )

    def handle_publish_expo_run(self, run_id: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        if record.runtime != "expo":
            self.send_json(
                {"ok": False, "error": "只有 Expo Runtime 任务可以发布 Harmony Go 预览。", "code": "not_expo_run"},
                status=HTTPStatus.CONFLICT,
            )
            return
        state = load_expo_fast_state(Path(record.workspace))
        if expo_fast_run_status(record, state) != "completed":
            self.send_json(
                {"ok": False, "error": "Expo 生成与启动验证完成后才能开启外网预览。", "code": "expo_run_not_ready"},
                status=HTTPStatus.CONFLICT,
            )
            return
        artifact_root = Path(record.workspace) / "dist" / "harmony-go"
        try:
            serve_state, created = EXPO_PUBLIC_GATEWAY.publish(record.run_id, artifact_root)
        except ExpoExportValidationError as exc:
            self.send_json(
                {"ok": False, "error": str(exc), "code": "expo_export_invalid"},
                status=HTTPStatus.CONFLICT,
            )
            return
        except ExpoGatewayError as exc:
            self.send_json(
                {"ok": False, "error": str(exc), "code": "expo_gateway_unavailable"},
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return
        self.send_json(
            {"ok": True, "accepted": created, "serve": serve_state},
            status=HTTPStatus.CREATED if created else HTTPStatus.OK,
        )

    def handle_unpublish_expo_run(self, run_id: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        if record.runtime != "expo":
            self.send_json(
                {"ok": False, "error": "只有 Expo Runtime 任务可以撤销 Harmony Go 预览。", "code": "not_expo_run"},
                status=HTTPStatus.CONFLICT,
            )
            return
        try:
            state = load_expo_fast_state(Path(record.workspace))
            serve_state, removed = EXPO_PUBLIC_GATEWAY.unpublish(
                record.run_id,
                can_publish=expo_fast_run_status(record, state) == "completed",
            )
        except ExpoGatewayError as exc:
            self.send_json(
                {"ok": False, "error": str(exc), "code": "expo_gateway_state_error"},
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return
        self.send_json({"ok": True, "accepted": removed, "serve": serve_state})

    def handle_package_run(self, run_id: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        if record.runtime == "expo":
            progress = build_expo_progress_payload(record)
            artifacts = progress.get("artifacts") if isinstance(progress.get("artifacts"), dict) else {}
            if artifacts.get("package_current"):
                self.send_json({"ok": True, "accepted": False, "status": "ready"})
                return
            if not artifacts.get("package_can_start"):
                status = str(artifacts.get("distribution_status") or "waiting_hap")
                message = {
                    "packaging": "手机安装包正在签名，请勿重复提交。",
                    "building": "正在为最新调整重建 unsigned HAP，请勿重复提交。",
                    "waiting_update": "调整后的最新 unsigned HAP 尚未生成。",
                    "waiting_hap": "Expo unsigned HAP 尚未生成。",
                    "failed": str(artifacts.get("distribution_error") or "手机安装包生成失败。"),
                    "disabled": "当前环境未启用 HPack。",
                }.get(status, "当前状态暂不能生成手机安装包。")
                self.send_json(
                    {"ok": False, "error": message, "code": "package_not_ready"},
                    status=HTTPStatus.CONFLICT,
                )
                return
            if artifacts.get("package_outdated") and not artifacts.get("newer_hap_available"):
                latest = load_run(run_id) or record
                if process_alive(latest.process_pid):
                    self.send_json(
                        {"ok": False, "error": "Expo 最新版本仍在构建，请稍后重试。", "code": "package_busy"},
                        status=HTTPStatus.CONFLICT,
                    )
                    return
                follow_up = load_follow_up_status(
                    latest,
                    load_expo_fast_state(Path(latest.workspace)),
                )
                accepted = start_expo_preview_hap_refresh(latest, follow_up)
                if not accepted:
                    start_expo_preview_refresh_monitor(load_run(run_id) or latest)
                self.send_json(
                    {"ok": True, "accepted": accepted, "status": "building_hap"},
                    status=HTTPStatus.ACCEPTED,
                )
                return
            if artifacts.get("preview_source_outdated"):
                latest = load_run(run_id) or record
                follow_up = load_follow_up_status(
                    latest,
                    load_expo_fast_state(Path(latest.workspace)),
                )
                accepted = start_expo_preview_hap_refresh(latest, follow_up)
                if not accepted:
                    start_expo_preview_refresh_monitor(load_run(run_id) or latest)
                self.send_json(
                    {"ok": True, "accepted": accepted, "status": "building_hap"},
                    status=HTTPStatus.ACCEPTED,
                )
                return
            started = start_hpack_packaging(
                load_run(run_id) or record,
                replace_manifest=hpack_manifest_path(run_id).is_file(),
            )
            if not started:
                self.send_json(
                    {"ok": False, "error": "手机安装包任务已在运行或暂时无法启动。", "code": "package_busy"},
                    status=HTTPStatus.CONFLICT,
                )
                return
            self.send_json(
                {"ok": True, "accepted": True, "status": "packaging"},
                status=HTTPStatus.ACCEPTED,
            )
            return
        progress = build_progress_payload(record)
        artifacts = progress.get("artifacts") if isinstance(progress.get("artifacts"), dict) else {}
        if artifacts.get("package_current"):
            self.send_json({"ok": True, "accepted": False, "status": "ready"})
            return
        if not artifacts.get("package_can_start"):
            status = str(artifacts.get("distribution_status") or "")
            message = {
                "packaging": "安装包正在生成，请勿重复提交。",
                "waiting_update": "调整后的最新 unsigned HAP 尚未生成。",
                "waiting_preview": "最新预览尚未生成，请稍后再试。",
                "waiting_hap": "QA 和 unsigned HAP 尚未就绪。",
                "disabled": "当前环境未启用 HPack。",
            }.get(status, "当前状态暂不能生成安装包，请等待调整与预览完成。")
            self.send_json(
                {"ok": False, "error": message, "code": "package_not_ready"},
                status=HTTPStatus.CONFLICT,
            )
            return
        started = start_hpack_packaging(
            load_run(run_id) or record,
            replace_manifest=hpack_manifest_path(run_id).is_file(),
        )
        if not started:
            self.send_json(
                {"ok": False, "error": "安装包任务已在运行或暂时无法启动。", "code": "package_busy"},
                status=HTTPStatus.CONFLICT,
            )
            return
        self.send_json(
            {"ok": True, "accepted": True, "status": "packaging"},
            status=HTTPStatus.ACCEPTED,
        )

    def handle_get_run_questions(self, run_id: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        self.send_json(load_ask_user_questions(Path(record.workspace)))

    def handle_answer_run_question(self, run_id: str, question_id: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        question_id = safe_question_id(question_id)
        questions = load_ask_user_questions(Path(record.workspace))
        pending = {
            str(item.get("id")): item
            for item in questions.get("pending", [])
            if isinstance(item, dict)
        }
        if question_id not in pending:
            self.send_json({"error": "Question not found or already answered"}, status=HTTPStatus.NOT_FOUND)
            return
        payload = self.read_body_json()
        answers = payload.get("answers")
        if not isinstance(answers, dict) or not answers:
            self.send_json({"error": "answers is required"}, status=HTTPStatus.BAD_REQUEST)
            return
        annotations = payload.get("annotations")
        response: dict[str, Any] = {
            "id": question_id,
            "toolUseId": pending[question_id].get("toolUseId") or question_id,
            "answers": answers,
            "answeredAt": to_iso(),
            "answeredBy": "remote-ui",
        }
        if isinstance(annotations, dict):
            response["annotations"] = annotations
        write_json(ask_user_question_dir(Path(record.workspace)) / f"response-{question_id}.json", response)
        self.send_json({"ok": True, "question": response})

    def send_follow_up_error(self, exc: FollowUpControlError) -> None:
        status = {
            "run_not_found": HTTPStatus.NOT_FOUND,
            "follow_up_not_found": HTTPStatus.NOT_FOUND,
            "invalid_follow_up_session": HTTPStatus.NOT_FOUND,
            "control_busy": HTTPStatus.CONFLICT,
            "invalid_run_name": HTTPStatus.BAD_REQUEST,
            "invalid_client_request_id": HTTPStatus.BAD_REQUEST,
            "empty_message": HTTPStatus.BAD_REQUEST,
            "message_too_large": HTTPStatus.BAD_REQUEST,
            "invalid_command_id": HTTPStatus.BAD_REQUEST,
            "command_not_found": HTTPStatus.NOT_FOUND,
            "command_not_queued": HTTPStatus.CONFLICT,
        }.get(exc.code, HTTPStatus.SERVICE_UNAVAILABLE if exc.code in {"control_unavailable", "follow_up_unavailable"} else HTTPStatus.INTERNAL_SERVER_ERROR)
        self.send_json({"ok": False, "error": str(exc), "code": exc.code, "details": exc.details}, status=status)

    def handle_get_follow_up(self, run_id: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        try:
            self.send_json(redact_follow_up_response(call_follow_up_control(record, "status")))
        except FollowUpControlError as exc:
            self.send_follow_up_error(exc)

    def handle_enqueue_follow_up(self, run_id: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        body = self.read_body_json()
        text = str(body.get("text") or "")
        if not text.strip():
            self.send_json({"ok": False, "error": "text is required", "code": "empty_message"}, status=HTTPStatus.BAD_REQUEST)
            return
        with expo_run_operation_lock(run_id):
            latest = load_run(run_id) or record
            if latest.runtime == "expo" and (
                expo_runtime_operation_in_flight(latest)
                or latest.run_id in HPACK_PACKAGE_IN_FLIGHT
                or process_alive(latest.distribution_process_pid)
            ):
                self.send_json(
                    {
                        "ok": False,
                        "error": "Expo 构建或安装包任务正在运行，请完成后再提交调整。",
                        "code": "control_busy",
                    },
                    status=HTTPStatus.CONFLICT,
                )
                return
            try:
                response = call_follow_up_control(latest, "enqueue", {
                    "text": text,
                    "clientMessageId": str(body.get("clientMessageId") or ""),
                })
                latest = persist_latest_adjustment(latest, response)
                start_expo_preview_refresh_monitor(latest)
                self.send_json(redact_follow_up_response(response))
            except FollowUpControlError as exc:
                self.send_follow_up_error(exc)

    def handle_interrupt_follow_up(self, run_id: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        body = self.read_body_json()
        try:
            response = call_follow_up_control(record, "interrupt", {
                "clientActionId": str(body.get("clientActionId") or ""),
            })
            persist_latest_adjustment(record, response, replace_from_state=True)
            self.send_json(redact_follow_up_response(response))
        except FollowUpControlError as exc:
            self.send_follow_up_error(exc)

    def handle_update_queued_follow_up(self, run_id: str, command_id: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        body = self.read_body_json()
        text = str(body.get("text") or "")
        if not text.strip():
            self.send_json({"ok": False, "error": "text is required", "code": "empty_message"}, status=HTTPStatus.BAD_REQUEST)
            return
        try:
            self.send_json(redact_follow_up_response(call_follow_up_control(record, "update", {
                "commandId": command_id,
                "text": text,
            })))
        except FollowUpControlError as exc:
            self.send_follow_up_error(exc)

    def handle_remove_queued_follow_up(self, run_id: str, command_id: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        try:
            response = call_follow_up_control(record, "remove", {
                "commandId": command_id,
            })
            persist_latest_adjustment(record, response, replace_from_state=True)
            self.send_json(redact_follow_up_response(response))
        except FollowUpControlError as exc:
            self.send_follow_up_error(exc)

    def _compute_run_progress(self, run_id: str) -> dict[str, Any] | None:
        """读取并刷新单个 run 的进度负载；run 不存在时返回 None。"""
        record = load_run(run_id)
        if not record:
            return None
        maybe_release_signing_slot(record)
        latest = build_progress_payload(record)
        if latest["status"] != record.status:
            record.status = str(latest["status"])
            save_run(record)
            latest["run"] = asdict(record)
        return latest

    def handle_run_events(self, run_id: str) -> None:
        """通过 Server-Sent Events 实时推送单个 run 的进度。

        每个请求由 ThreadingHTTPServer 分配独立线程，可安全地保持长连接。
        仅在进度内容变化时推送数据帧，其余周期发送注释心跳维持连接，
        进入终态（succeeded / failed）后关闭流。
        """
        if not self.load_accessible_run(run_id):
            return
        initial = self._compute_run_progress(run_id)
        if initial is None:
            self.send_error(HTTPStatus.NOT_FOUND, "Run not found")
            return

        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-store")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            return

        poll_interval = float(DEFAULT_POLL_INTERVAL_MS) / 1000.0
        heartbeat_every = max(1, int(15.0 / poll_interval))

        def write_event(payload: dict[str, Any]) -> bool:
            data = json.dumps(payload, ensure_ascii=False)
            frame = f"data: {data}\n\n".encode("utf-8")
            try:
                self.wfile.write(frame)
                self.wfile.flush()
                return True
            except (BrokenPipeError, ConnectionResetError, ValueError):
                return False

        def write_heartbeat() -> bool:
            try:
                self.wfile.write(b": keep-alive\n\n")
                self.wfile.flush()
                return True
            except (BrokenPipeError, ConnectionResetError, ValueError):
                return False

        last_serialized = json.dumps(initial, ensure_ascii=False, sort_keys=True)
        if not write_event(initial):
            return
        if str(initial.get("status")) in {"succeeded", "failed"}:
            return

        idle_ticks = 0
        while True:
            time.sleep(poll_interval)
            latest = self._compute_run_progress(run_id)
            if latest is None:
                break
            serialized = json.dumps(latest, ensure_ascii=False, sort_keys=True)
            if serialized != last_serialized:
                last_serialized = serialized
                idle_ticks = 0
                if not write_event(latest):
                    break
                if str(latest.get("status")) in {"succeeded", "failed"}:
                    break
            else:
                idle_ticks += 1
                if idle_ticks >= heartbeat_every:
                    idle_ticks = 0
                    if not write_heartbeat():
                        break

    def handle_get_media(
        self,
        run_id: str,
        *,
        head_only: bool = False,
        query: dict[str, list[str]] | None = None,
    ) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        preview_kind = normalize_preview_kind(record, ((query or {}).get("preview") or [""])[0])
        session = preview_sessions_payload(record).get(preview_kind, {})
        session_media = Path(str(session.get("screenshot_path") or ""))
        media_path = (
            session_media
            if session_media.is_file()
            else expo_preview_media_path(Path(record.workspace), preview_kind)
            if record.runtime == "expo" and preview_kind
            else find_latest_media(record.run_id, Path(record.workspace))
        )
        if not media_path:
            self.send_error(HTTPStatus.NOT_FOUND, "Media not found")
            return
        if head_only:
            self.send_file_head(media_path)
        else:
            self.send_file(media_path)

    def live_preview_is_available(self, record: RunRecord, preview_kind: str = "") -> bool:
        kind = preview_kind or normalize_preview_kind(record)
        session = preview_sessions_payload(record).get(kind, {})
        if record.runtime == "expo":
            return bool(session.get("status") == "ready" and session.get("live_available"))
        return effective_capture_status(record) == "complete"

    def handle_get_live_frame(
        self,
        run_id: str,
        *,
        query: dict[str, list[str]] | None = None,
    ) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        query = query or {}
        preview_kind = normalize_preview_kind(record, (query.get("preview") or [""])[0])
        if not self.live_preview_is_available(record, preview_kind):
            self.send_json({"error": "实时预览将在真机运行验证完成后可用。"}, status=HTTPStatus.CONFLICT)
            return
        try:
            after_sequence = max(0, int((query.get("after") or ["0"])[0]))
            wait_ms = max(0, min(int((query.get("wait_ms") or ["0"])[0]), 1500))
        except ValueError:
            self.send_json({"error": "帧序号或等待时间无效。"}, status=HTTPStatus.BAD_REQUEST)
            return
        try:
            session_id = bind_live_preview_target(record, preview_kind)
            frame = LIVE_PREVIEW.wait_for_frame(
                session_id,
                after_sequence=after_sequence,
                timeout_sec=wait_ms / 1000,
            )
        except LivePreviewError as exc:
            self.send_json({"error": str(exc)}, status=HTTPStatus.BAD_GATEWAY)
            return
        self.send_bytes(
            frame.data,
            "image/jpeg",
            headers={
                "X-Harmony-Preview-Status": "stale" if frame.stale else "fresh",
                "X-Harmony-Preview-Sequence": str(frame.sequence),
                "X-Harmony-Preview-Width": str(frame.width),
                "X-Harmony-Preview-Height": str(frame.height),
                "X-Harmony-Preview-Bytes": str(len(frame.data)),
            },
        )

    def live_request_network_fields(self) -> dict[str, str]:
        cf_ray = self.headers.get("CF-Ray", "").strip()
        cf_colo = cf_ray.rsplit("-", 1)[-1].upper() if "-" in cf_ray else ""
        return {
            "cf_ray": cf_ray,
            "cf_colo": cf_colo,
            "cf_country": self.headers.get("CF-IPCountry", "").strip().upper(),
            "forwarded_proto": (self.headers.get("X-Forwarded-Proto") or "").split(",", 1)[0].strip(),
        }

    def log_live_input(
        self,
        *,
        run_id: str,
        action: str,
        status: str,
        request_started_at: float,
        timings: dict[str, float | int] | None = None,
        error: str = "",
    ) -> None:
        append_live_preview_log(
            {
                "timestamp": to_iso(),
                "event": "live_input",
                "run_id": run_id,
                "action": action,
                "status": status,
                "request_ms": round((time.monotonic() - request_started_at) * 1000, 3),
                **self.live_request_network_fields(),
                "timings": timings or {},
                "error": error,
            }
        )

    def handle_live_input(
        self,
        run_id: str,
        *,
        query: dict[str, list[str]] | None = None,
    ) -> None:
        request_started_at = time.monotonic()
        record = self.load_accessible_run(run_id)
        if not record:
            return
        preview_kind = normalize_preview_kind(record, ((query or {}).get("preview") or [""])[0])
        if not self.live_preview_is_available(record, preview_kind):
            self.send_json({"error": "实时预览将在真机运行验证完成后可用。"}, status=HTTPStatus.CONFLICT)
            return
        payload = self.read_body_json()
        action = str(payload.get("type") or "unknown")[:24]
        try:
            session_id = bind_live_preview_target(record, preview_kind)
            frame = LIVE_PREVIEW.submit_input(session_id, payload)
        except LiveInputValidationError as exc:
            self.log_live_input(
                run_id=run_id,
                action=action,
                status="invalid",
                request_started_at=request_started_at,
                error=str(exc),
            )
            self.send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return
        except LiveInputRateLimitError as exc:
            self.log_live_input(
                run_id=run_id,
                action=action,
                status="rate_limited",
                request_started_at=request_started_at,
                error=str(exc),
            )
            self.send_json({"error": str(exc)}, status=HTTPStatus.TOO_MANY_REQUESTS)
            return
        except LivePreviewError as exc:
            self.log_live_input(
                run_id=run_id,
                action=action,
                status="error",
                request_started_at=request_started_at,
                error=str(exc),
            )
            self.send_json({"error": str(exc)}, status=HTTPStatus.BAD_GATEWAY)
            return
        self.log_live_input(
            run_id=run_id,
            action=action,
            status="ok",
            request_started_at=request_started_at,
            timings=frame.timings,
        )
        self.send_json(
            {
                "ok": True,
                "frame_seq": frame.sequence,
                "frame_status": "refreshing",
                "refresh_queued": True,
                "timings": frame.timings,
            },
            headers={"Server-Timing": preview_server_timing(frame.timings)},
        )

    def handle_get_live_webrtc_config(
        self,
        run_id: str,
        *,
        query: dict[str, list[str]] | None = None,
    ) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        preview_kind = normalize_preview_kind(record, ((query or {}).get("preview") or [""])[0])
        if not self.live_preview_is_available(record, preview_kind):
            self.send_json({"error": "实时预览尚未可用。"}, status=HTTPStatus.CONFLICT)
            return
        if WEBRTC_PREVIEW is None:
            self.send_json(
                {"available": False, "reason": "服务端未安装 aiortc。"},
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return
        bind_live_preview_target(record, preview_kind)
        query_suffix = f"?preview={preview_kind}" if len(preview_targets_for_record(record)) > 1 else ""
        self.send_json(
            {
                **WEBRTC_PREVIEW.config_payload(),
                "offer_path": f"/api/runs/{run_id}/live/webrtc/offer{query_suffix}",
            }
        )

    def handle_live_webrtc_offer(
        self,
        run_id: str,
        *,
        query: dict[str, list[str]] | None = None,
    ) -> None:
        request_started_at = time.monotonic()
        record = self.load_accessible_run(run_id)
        if not record:
            return
        preview_kind = normalize_preview_kind(record, ((query or {}).get("preview") or [""])[0])
        if not self.live_preview_is_available(record, preview_kind):
            self.send_json({"error": "实时预览尚未可用。"}, status=HTTPStatus.CONFLICT)
            return
        if WEBRTC_PREVIEW is None:
            self.send_json(
                {"error": "WebRTC 当前不可用，请使用 REST 预览。"},
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return
        payload = self.read_body_json()
        try:
            session_id = bind_live_preview_target(record, preview_kind)
            answer = WEBRTC_PREVIEW.create_answer(
                run_id=session_id,
                sdp=str(payload.get("sdp") or ""),
                description_type=str(payload.get("type") or ""),
                signaling_id=str(payload.get("signaling_id") or ""),
                network_fields=self.live_request_network_fields(),
            )
        except WebRTCPreviewError as exc:
            append_webrtc_preview_log(
                {
                    "event": "webrtc_offer",
                    "run_id": run_id,
                    "status": "error",
                    "request_ms": round((time.monotonic() - request_started_at) * 1000, 3),
                    **self.live_request_network_fields(),
                    "error": str(exc),
                }
            )
            self.send_json({"error": str(exc)}, status=HTTPStatus.SERVICE_UNAVAILABLE)
            return
        append_webrtc_preview_log(
            {
                "event": "webrtc_offer",
                "run_id": run_id,
                "peer_id": answer.get("peer_id", ""),
                "status": "ok",
                "request_ms": round((time.monotonic() - request_started_at) * 1000, 3),
                **self.live_request_network_fields(),
                "local_candidate_types": answer.get("local_candidate_types", []),
                "error": "",
            }
        )
        self.send_json(answer)

    def handle_get_thumbnail(self, run_id: str, *, head_only: bool = False) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        screenshot_path = find_first_screenshot(record.run_id)
        if not screenshot_path:
            self.send_error(HTTPStatus.NOT_FOUND, "Thumbnail not found")
            return
        if head_only:
            self.send_file_head(screenshot_path)
        else:
            self.send_file(screenshot_path)

    def handle_get_hap(self, run_id: str, *, head_only: bool = False) -> None:
        record = self.load_accessible_run(run_id, allow_share=True)
        if not record:
            return
        workspace = Path(record.workspace)
        hap_path = (
            resolve_expo_hap_artifact(workspace)
            if record.runtime == "expo"
            else find_latest_hap(workspace)
        )
        if not hap_path:
            self.send_error(HTTPStatus.NOT_FOUND, "HAP not found")
            return
        if head_only:
            self.send_file_head(hap_path, download_name=hap_path.name)
        else:
            self.send_file(hap_path, download_name=hap_path.name)

    def handle_get_hap_qr(self, run_id: str) -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        workspace = Path(record.workspace)
        hap_path = (
            resolve_expo_hap_artifact(workspace)
            if record.runtime == "expo"
            else find_latest_hap(workspace)
        )
        if not hap_path:
            self.send_error(HTTPStatus.NOT_FOUND, "HAP not found")
            return
        try:
            qr_bytes = self.generate_qr_png(
                self.build_absolute_url(f"/api/runs/{run_id}/hap?share={quote(record.share_token)}")
            )
        except RuntimeError as exc:
            self.send_json({"error": str(exc)}, status=HTTPStatus.SERVICE_UNAVAILABLE)
            return
        self.send_bytes(qr_bytes, "image/png")

    def handle_get_install_qr(self, run_id: str, *, version: str = "latest") -> None:
        record = self.load_accessible_run(run_id)
        if not record:
            return
        if version == "first" and record.first_install_url:
            manifest_url = record.first_manifest_url
            install_store_url = record.first_install_store_url or (
                build_install_store_url(manifest_url) if manifest_url else ""
            )
            install_url = record.first_install_url
        else:
            hpack_manifest = load_hpack_manifest(record.run_id)
            manifest_url = str(hpack_manifest.get("manifest_url") or "") if hpack_manifest else ""
            install_store_url = str(hpack_manifest.get("install_store_url") or "") if hpack_manifest else ""
            if not install_store_url and manifest_url:
                install_store_url = build_install_store_url(manifest_url)
            install_url = str(hpack_manifest.get("install_url") or "") if hpack_manifest else ""
        qr_content = build_install_qr_content(
            install_url=install_url,
            install_store_url=install_store_url,
            manifest_url=manifest_url,
        )
        if not qr_content:
            self.send_error(HTTPStatus.NOT_FOUND, "Install URL not found")
            return
        try:
            qr_bytes = self.generate_qr_png(qr_content)
        except RuntimeError as exc:
            self.send_json({"error": str(exc)}, status=HTTPStatus.SERVICE_UNAVAILABLE)
            return
        self.send_bytes(qr_bytes, "image/png")


def run_server() -> None:
    # Default to loopback and let Cloudflare Tunnel expose the app externally.
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer((host, port), RemoteUIHandler)
    print(f"Harmony Pilot Remote UI running at http://{host}:{port}")
    if EXPO_PUBLIC_GATEWAY.start():
        print(
            "Expo Harmony Gateway running at "
            f"{EXPO_PUBLIC_GATEWAY.local_origin()} -> {EXPO_PUBLIC_GATEWAY.public_origin}"
        )
    elif EXPO_PUBLIC_GATEWAY.enabled:
        print(f"Expo Harmony Gateway failed to start: {EXPO_PUBLIC_GATEWAY.health()['error']}", file=sys.stderr)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        EXPO_PUBLIC_GATEWAY.stop()


if __name__ == "__main__":
    run_server()
