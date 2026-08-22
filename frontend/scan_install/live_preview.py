from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from io import BytesIO
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

try:
    from PIL import Image
except ImportError:  # pragma: no cover - production dependencies include Pillow
    Image = None


DEFAULT_HDC_CANDIDATES = [
    os.environ.get("HDC_PATH", "").strip(),
    os.path.join(
        os.environ.get("DEVECO_PATH", "/Applications/DevEco-Studio.app"),
        "Contents/sdk/default/openharmony/toolchains/hdc",
    ),
    "/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc",
]
REMOTE_TMP_DIR = "/data/local/tmp/harmony-pilot-remote-ui/live-preview"
ALLOWED_KEYS = {"BACK", "HOME"}
ALLOWED_SCROLL_DIRECTIONS = {"up", "down"}
MIN_SWIPE_VELOCITY = 200
MAX_SWIPE_VELOCITY = 40_000
FRAME_MAX_AGE_SEC = 1.0
MAX_QUEUED_INPUTS = 8
INPUT_MIN_INTERVAL_SEC = 0.06
PREVIEW_MAX_WIDTH = 660
PREVIEW_JPEG_QUALITY = 75
DESKTOP_PREVIEW_MAX_WIDTH = 3120
DESKTOP_PREVIEW_JPEG_QUALITY = 90
DESKTOP_WINDOW_WAIT_ATTEMPTS = 20
DESKTOP_WINDOW_RETRY_INTERVAL_SEC = 0.25
DESKTOP_MAXIMIZE_VERIFY_ATTEMPTS = 8
DESKTOP_MAXIMIZE_CLICK_ATTEMPTS = 3


def parse_open_bundle_names(ability_dump: str) -> list[str]:
    """Return app bundles represented by the current mission list."""
    marker = "current mission lists:"
    start = ability_dump.find(marker)
    if start < 0:
        return []
    end = ability_dump.find("\n  ExtensionRecords:", start)
    mission_dump = ability_dump[start:end if end >= 0 else len(ability_dump)]
    bundles = re.findall(r"^\s*bundle name \[([^\]]+)]\s*$", mission_dump, re.MULTILINE)
    return list(dict.fromkeys(bundle.strip() for bundle in bundles if bundle.strip()))


def parse_bundle_pid(ability_dump: str, bundle_name: str) -> str:
    """Find the foreground application pid reported by ``aa dump``."""
    lines = ability_dump.splitlines()
    marker = f"process name [{bundle_name}]"
    for index, line in enumerate(lines):
        if marker not in line:
            continue
        for candidate in lines[index + 1:index + 5]:
            match = re.search(r"pid\s+#(\d+)", candidate)
            if match:
                return match.group(1)
    return ""


def parse_window_bounds(window_dump: str, pid: str) -> tuple[int, int, int, int] | None:
    """Return x, y, width and height for an application window."""
    if not pid:
        return None
    pattern = re.compile(
        rf"^\s*\S+\s+\d+\s+{re.escape(pid)}\s+\d+\s+\d+\s+\d+\s+\d+\s+[-\d]+\s+\d+\s+"
        r"\[\s*(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\]",
        re.MULTILINE,
    )
    match = pattern.search(window_dump)
    if not match:
        return None
    return tuple(int(value) for value in match.groups())  # type: ignore[return-value]


def parse_render_resolution(render_dump: str) -> tuple[int, int] | None:
    """Read the active display resolution from RenderService output."""
    match = re.search(r"render resolution=(\d+)x(\d+)", render_dump)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def parse_layout_control_bounds(
    layout_dump: str,
    bundle_name: str,
    control_id: str,
) -> tuple[int, int, int, int] | None:
    """Find one system-decor control inside the requested app window."""
    try:
        root = json.loads(layout_dump)
    except (TypeError, json.JSONDecodeError):
        return None

    def find_bundle(node: dict[str, Any]) -> dict[str, Any] | None:
        attributes = node.get("attributes") or {}
        if str(attributes.get("bundleName") or "") == bundle_name:
            return node
        for child in node.get("children") or []:
            if isinstance(child, dict):
                match = find_bundle(child)
                if match:
                    return match
        return None

    def find_control(node: dict[str, Any]) -> tuple[int, int, int, int] | None:
        attributes = node.get("attributes") or {}
        if str(attributes.get("id") or attributes.get("key") or "") == control_id:
            match = re.fullmatch(
                r"\[\s*(-?\d+)\s*,\s*(-?\d+)\s*]\[\s*(-?\d+)\s*,\s*(-?\d+)\s*]",
                str(attributes.get("bounds") or ""),
            )
            if match:
                left, top, right, bottom = (int(value) for value in match.groups())
                return left, top, max(0, right - left), max(0, bottom - top)
        for child in node.get("children") or []:
            if isinstance(child, dict):
                match = find_control(child)
                if match:
                    return match
        return None

    # The title-bar controls live in the system decor sibling of the app node,
    # not below the app's bundle root. Confirm the requested bundle exists,
    # then search the complete layout tree for the stable control id.
    if not find_bundle(root):
        return None
    return find_control(root)


def window_is_maximized(
    bounds: tuple[int, int, int, int],
    display_size: tuple[int, int] | None,
) -> bool:
    """Whether an app window fills the HarmonyOS PC working area."""
    if not display_size:
        return False
    _x, _y, width, height = bounds
    display_width, display_height = display_size
    # The PC dock occupies a small strip at the bottom of the display.
    return width >= round(display_width * 0.95) and height >= round(display_height * 0.9)


class LivePreviewError(RuntimeError):
    """A user-facing failure while reading or controlling the local device."""


class LiveInputValidationError(LivePreviewError):
    """The browser sent an input message outside the supported contract."""


class LiveInputRateLimitError(LivePreviewError):
    """The target device already has too many queued browser inputs."""


def _screen_is_locked_error(error: LivePreviewError) -> bool:
    message = str(error).lower()
    return "screen is locked" in message or "screen locked" in message or "keyguard" in message


@dataclass(frozen=True)
class Frame:
    data: bytes
    width: int
    height: int
    sequence: int = 0
    stale: bool = False
    warning: str = ""
    timings: dict[str, float | int] = field(default_factory=dict)


@dataclass(frozen=True)
class LiveInput:
    kind: str
    start: tuple[float, float] | None = None
    end: tuple[float, float] | None = None
    duration_ms: int | None = None
    key: str | None = None
    direction: str | None = None


@dataclass
class _Session:
    lock: threading.RLock
    frame_condition: threading.Condition = field(init=False)
    target: str = ""
    preview_kind: str = ""
    remote_dir_ready: bool = False
    screen_size: tuple[int, int] | None = None
    latest_frame: Frame | None = None
    latest_frame_at: float = 0.0
    refresh_in_progress: bool = False
    refresh_requested: bool = False
    last_refresh_error: str = ""
    frame_sequence: int = 0

    def __post_init__(self) -> None:
        self.frame_condition = threading.Condition(self.lock)


@dataclass
class _DeviceGate:
    condition: threading.Condition
    busy: bool = False
    waiting_inputs: int = 0
    last_input_started_at: float = 0.0


def resolve_hdc_binary() -> str:
    for candidate in DEFAULT_HDC_CANDIDATES:
        if candidate and Path(candidate).is_file():
            return candidate
    system_hdc = shutil.which("hdc")
    if system_hdc:
        return system_hdc
    raise LivePreviewError("未找到 hdc。请设置 HDC_PATH 或安装 DevEco Studio。")


def parse_live_input(payload: dict[str, Any]) -> LiveInput:
    kind = str(payload.get("type") or "").strip().lower()
    if kind == "tap":
        return LiveInput(kind="tap", start=parse_point(payload, "point"))
    if kind == "swipe":
        duration = payload.get("duration_ms", 360)
        if isinstance(duration, bool) or not isinstance(duration, (int, float)):
            raise LiveInputValidationError("滑动时长无效。")
        return LiveInput(
            kind="swipe",
            start=parse_point(payload, "start"),
            end=parse_point(payload, "end"),
            duration_ms=max(80, min(int(duration), 1500)),
        )
    if kind == "key":
        key = str(payload.get("key") or "").strip().upper()
        if key not in ALLOWED_KEYS:
            raise LiveInputValidationError("不支持的设备按键。")
        return LiveInput(kind="key", key=key)
    if kind == "scroll":
        direction = str(payload.get("direction") or "").strip().lower()
        if direction not in ALLOWED_SCROLL_DIRECTIONS:
            raise LiveInputValidationError("不支持的滚动方向。")
        return LiveInput(kind="scroll", direction=direction)
    raise LiveInputValidationError("不支持的预览操作。")


def parse_point(payload: dict[str, Any], key: str) -> tuple[float, float]:
    value = payload.get(key)
    if not isinstance(value, dict):
        raise LiveInputValidationError("预览坐标无效。")
    x = value.get("x")
    y = value.get("y")
    if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        raise LiveInputValidationError("预览坐标无效。")
    if not 0 <= float(x) <= 1 or not 0 <= float(y) <= 1:
        raise LiveInputValidationError("预览坐标必须在 0 到 1 之间。")
    return float(x), float(y)


def normalized_to_pixel(point: tuple[float, float], screen_size: tuple[int, int]) -> tuple[int, int]:
    width, height = screen_size
    if width <= 0 or height <= 0:
        raise LivePreviewError("设备屏幕尺寸无效。")
    x = min(width - 1, max(0, round(point[0] * (width - 1))))
    y = min(height - 1, max(0, round(point[1] * (height - 1))))
    return x, y


def swipe_velocity(
    start: tuple[int, int],
    end: tuple[int, int],
    duration_ms: int,
) -> int:
    """Convert browser gesture duration to the pixel velocity expected by uiInput."""
    distance = math.hypot(end[0] - start[0], end[1] - start[1])
    duration_sec = max(1, duration_ms) / 1000
    velocity = round(distance / duration_sec)
    return max(MIN_SWIPE_VELOCITY, min(velocity, MAX_SWIPE_VELOCITY))


def read_jpeg_size(data: bytes) -> tuple[int, int]:
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        raise LivePreviewError("模拟器截图格式无效。")
    offset = 2
    sof_markers = {
        0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
        0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
    }
    while offset < len(data):
        while offset < len(data) and data[offset] != 0xFF:
            offset += 1
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            break
        marker = data[offset]
        offset += 1
        if marker in {0xD8, 0xD9}:
            continue
        if offset + 2 > len(data):
            break
        segment_length = int.from_bytes(data[offset:offset + 2], "big")
        if segment_length < 2 or offset + segment_length > len(data):
            break
        if marker in sof_markers and segment_length >= 7:
            height = int.from_bytes(data[offset + 3:offset + 5], "big")
            width = int.from_bytes(data[offset + 5:offset + 7], "big")
            if width > 0 and height > 0:
                return width, height
        offset += segment_length
    raise LivePreviewError("无法读取模拟器截图尺寸。")


def optimize_preview_jpeg(
    data: bytes,
    *,
    max_width: int = PREVIEW_MAX_WIDTH,
    quality: int = PREVIEW_JPEG_QUALITY,
) -> tuple[bytes, tuple[int, int]]:
    """Downsample device screenshots for the small browser preview."""
    original_size = read_jpeg_size(data)
    if Image is None or original_size[0] <= max_width:
        return data, original_size
    try:
        target_height = max(1, round(original_size[1] * max_width / original_size[0]))
        with Image.open(BytesIO(data)) as source:
            source.draft("RGB", (max_width, target_height))
            rendered = source.convert("RGB")
            if rendered.width > max_width:
                rendered.thumbnail((max_width, target_height), Image.Resampling.BOX)
            output = BytesIO()
            rendered.save(output, format="JPEG", quality=quality, optimize=False, subsampling=2)
        optimized = output.getvalue()
    except (OSError, ValueError):
        return data, original_size
    return (optimized, read_jpeg_size(optimized)) if len(optimized) < len(data) else (data, original_size)


class LocalLivePreview:
    """Capture and control Harmony devices while serializing each physical target."""

    def __init__(
        self,
        *,
        preferred_target: str = "",
        hdc_bin: str | None = None,
        command_runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
        frame_max_age_sec: float = FRAME_MAX_AGE_SEC,
        max_queued_inputs: int = MAX_QUEUED_INPUTS,
        input_min_interval_sec: float = INPUT_MIN_INTERVAL_SEC,
        preview_max_width: int = PREVIEW_MAX_WIDTH,
        preview_jpeg_quality: int = PREVIEW_JPEG_QUALITY,
        desktop_preview_max_width: int = DESKTOP_PREVIEW_MAX_WIDTH,
        desktop_preview_jpeg_quality: int = DESKTOP_PREVIEW_JPEG_QUALITY,
    ) -> None:
        self.preferred_target = preferred_target
        self.hdc_bin = hdc_bin
        self.command_runner = command_runner
        self.frame_max_age_sec = max(0.1, frame_max_age_sec)
        self.max_queued_inputs = max(1, max_queued_inputs)
        self.input_min_interval_sec = max(0.0, input_min_interval_sec)
        self.preview_max_width = max(320, preview_max_width)
        self.preview_jpeg_quality = max(40, min(preview_jpeg_quality, 90))
        self.desktop_preview_max_width = max(self.preview_max_width, desktop_preview_max_width)
        self.desktop_preview_jpeg_quality = max(40, min(desktop_preview_jpeg_quality, 95))
        self._sessions: dict[str, _Session] = {}
        self._sessions_lock = threading.Lock()
        self._default_target = ""
        self._target_resolution_lock = threading.Lock()
        self._device_gates: dict[str, _DeviceGate] = {}
        self._device_gates_lock = threading.Lock()

    def capture_frame(self, run_id: str) -> Frame:
        session = self._session(run_id)
        with session.lock:
            target = self._resolve_target(session)
        with self._target_access(target), session.lock:
            return self._capture_frame_locked(run_id, target, session)

    def install_and_launch(
        self,
        run_id: str,
        *,
        hap_path: Path,
        bundle_name: str,
        ability_name: str = "EntryAbility",
        maximize: bool = False,
    ) -> Frame:
        """Install one HAP on the bound device, launch it, and return its first frame."""
        if not hap_path.is_file():
            raise LivePreviewError(f"预览 HAP 不存在：{hap_path}")
        if not bundle_name.strip():
            raise LivePreviewError("无法启动设备预览：HAP 缺少 bundleName。")
        session = self._session(run_id)
        with session.lock:
            target = self._resolve_target(session)
        with self._target_access(target, input_priority=True), session.lock:
            # Do not terminate unrelated user/system applications on a shared
            # preview device. Only replace the bundle owned by this preview.
            self._run(target, "shell", "aa", "force-stop", bundle_name, check=False)
            self._run(target, "shell", "bm", "uninstall", "-n", bundle_name, check=False)
            self._run(target, "install", "-r", str(hap_path))
            self._wake_device(target)

            def launch_ability() -> None:
                common_args = (
                    "-b",
                    bundle_name,
                    "-a",
                    ability_name or "EntryAbility",
                )
                self._run(target, "shell", "aa", "start", *common_args)

            try:
                launch_ability()
            except LivePreviewError as exc:
                if not _screen_is_locked_error(exc):
                    raise
                self._unlock_device(target, session)
                launch_ability()
            if maximize:
                self._maximize_desktop_window(target, bundle_name)
            time.sleep(1.0)
            return self._capture_frame_locked(run_id, target, session)

    def _desktop_maximize_control_bounds(
        self,
        target: str,
        bundle_name: str,
    ) -> tuple[int, int, int, int] | None:
        remote_path = f"/data/local/tmp/harmony-pilot-layout-{uuid4().hex}.json"
        try:
            self._run(
                target,
                "shell",
                "uitest",
                "dumpLayout",
                "-p",
                remote_path,
                check=False,
            )
            layout_dump = self._run_output(target, "shell", "cat", remote_path, check=False)
            return parse_layout_control_bounds(layout_dump, bundle_name, "EnhanceMaximizeBtn")
        finally:
            self._run(target, "shell", "rm", "-f", remote_path, check=False)

    def _maximize_desktop_window(self, target: str, bundle_name: str) -> bool:
        """Click the HarmonyOS PC title-bar maximize control for this app.

        ``aa start -s`` only applies to legacy FA abilities and is ignored by
        the Stage-model HAPs produced by this project. The PC emulator exposes
        maximize as a system title-bar button, so locate the app window through
        ``aa dump``/WindowManagerService and click that control by geometry.
        """
        render_dump = self._run_output(
            target,
            "shell",
            "hidumper",
            "-s",
            "RenderService",
            "-a",
            "screen",
            check=False,
        )
        display_size = parse_render_resolution(render_dump)
        pid = ""
        bounds: tuple[int, int, int, int] | None = None
        # A cold Stage-model launch returns before the process and its system
        # title-bar window are registered. Wait for both instead of silently
        # skipping maximize on the first empty dump.
        for _attempt in range(DESKTOP_WINDOW_WAIT_ATTEMPTS):
            ability_dump = self._run_output(target, "shell", "aa", "dump", "-a", check=False)
            pid = parse_bundle_pid(ability_dump, bundle_name)
            if pid:
                window_dump = self._run_output(
                    target,
                    "shell",
                    "hidumper",
                    "-s",
                    "WindowManagerService",
                    "-a",
                    "-a",
                    check=False,
                )
                bounds = parse_window_bounds(window_dump, pid)
                if bounds is not None:
                    break
            time.sleep(DESKTOP_WINDOW_RETRY_INTERVAL_SEC)
        if bounds is None:
            raise LivePreviewError("PC 应用已启动，但无法识别窗口，未能完成最大化。")
        if window_is_maximized(bounds, display_size):
            return True

        for _click_attempt in range(DESKTOP_MAXIMIZE_CLICK_ATTEMPTS):
            control_bounds = self._desktop_maximize_control_bounds(target, bundle_name)
            if control_bounds:
                control_x, control_y, control_width, control_height = control_bounds
                click_x = control_x + max(1, control_width // 2)
                click_y = control_y + max(1, control_height // 2)
            else:
                x, y, width, _height = bounds
                # Accessibility data can be unavailable during a cold launch.
                # HarmonyOS PC places maximize before minimize and close, about
                # seven percent of the window width from its right edge.
                click_x = x + width - max(1, round(width * 0.07))
                click_y = y + 35
            self._run(
                target,
                "shell",
                "uitest",
                "uiInput",
                "click",
                str(click_x),
                str(click_y),
                check=False,
            )
            # WindowManagerService can lag behind the title-bar animation.
            # Poll the state before considering another click, otherwise a
            # second click could toggle a successfully maximized window back.
            for _verify_attempt in range(DESKTOP_MAXIMIZE_VERIFY_ATTEMPTS):
                time.sleep(DESKTOP_WINDOW_RETRY_INTERVAL_SEC)
                window_dump = self._run_output(
                    target,
                    "shell",
                    "hidumper",
                    "-s",
                    "WindowManagerService",
                    "-a",
                    "-a",
                    check=False,
                )
                latest_bounds = parse_window_bounds(window_dump, pid)
                if latest_bounds is None:
                    continue
                if window_is_maximized(latest_bounds, display_size):
                    return True
                bounds = latest_bounds
        raise LivePreviewError("PC 应用已启动，但系统窗口最大化未生效，请稍后重新预览。")

    def _wake_device(self, target: str) -> None:
        self._run(target, "shell", "power-shell", "wakeup", check=False)
        time.sleep(0.5)

    def _unlock_device(self, target: str, session: _Session) -> None:
        width, height = session.screen_size or (1080, 1920)
        x1, y1 = normalized_to_pixel((0.5, 0.82), (width, height))
        x2, y2 = normalized_to_pixel((0.5, 0.25), (width, height))
        self._run(
            target,
            "shell",
            "uitest",
            "uiInput",
            "swipe",
            str(x1),
            str(y1),
            str(x2),
            str(y2),
            "1000",
            check=False,
        )
        time.sleep(0.5)

    def release_session(self, run_id: str) -> None:
        """Forget one logical session so a later lease may bind another target."""
        with self._sessions_lock:
            self._sessions.pop(run_id, None)

    def last_activity_at(self, run_id: str) -> float:
        """Return the monotonic time of the last frame captured for a live viewer."""
        with self._sessions_lock:
            session = self._sessions.get(run_id)
        if session is None:
            return 0.0
        with session.lock:
            return session.latest_frame_at

    def bind_target(self, run_id: str, target: str, *, preview_kind: str = "") -> None:
        """Pin one logical preview session to one physical HDC target."""
        requested = target.strip()
        requested_kind = preview_kind.strip().lower()
        if not requested:
            raise LivePreviewError("实时预览未配置 HDC target。")
        with self._sessions_lock:
            session = self._sessions.get(run_id)
            if session is None:
                self._sessions[run_id] = _Session(
                    lock=threading.RLock(),
                    target=requested,
                    preview_kind=requested_kind,
                )
                return
        with session.lock:
            if session.target and session.target != requested:
                raise LivePreviewError("实时预览会话已绑定到另一台模拟器。")
            session.target = requested
            if requested_kind:
                session.preview_kind = requested_kind

    def _capture_frame_locked(self, run_id: str, target: str, session: _Session) -> Frame:
        if not session.remote_dir_ready:
            self._run(target, "shell", "mkdir", "-p", REMOTE_TMP_DIR)
            session.remote_dir_ready = True
        remote_path = f"{REMOTE_TMP_DIR}/{run_id}-{uuid4().hex}.jpeg"
        local_path = Path(tempfile.gettempdir()) / f"harmony-preview-{uuid4().hex}.jpeg"
        try:
            self._run(target, "shell", "snapshot_display", "-f", remote_path)
            self._run(target, "file", "recv", remote_path, str(local_path))
            original_data = local_path.read_bytes()
        except OSError as exc:
            raise LivePreviewError(f"读取模拟器画面失败：{exc}") from exc
        finally:
            local_path.unlink(missing_ok=True)
            self._cleanup_remote_later(target, remote_path)
        screen_size = read_jpeg_size(original_data)
        is_desktop = session.preview_kind == "desktop"
        data, delivered_size = optimize_preview_jpeg(
            original_data,
            max_width=self.desktop_preview_max_width if is_desktop else self.preview_max_width,
            quality=self.desktop_preview_jpeg_quality if is_desktop else self.preview_jpeg_quality,
        )
        session.screen_size = screen_size
        session.frame_sequence += 1
        frame = Frame(
            data=data,
            width=delivered_size[0],
            height=delivered_size[1],
            sequence=session.frame_sequence,
        )
        session.latest_frame = frame
        session.latest_frame_at = time.monotonic()
        session.last_refresh_error = ""
        session.frame_condition.notify_all()
        return frame

    def get_latest_frame(self, run_id: str) -> Frame:
        """Return a completed full-resolution frame while refreshing stale data."""
        session = self._session(run_id)
        if not session.lock.acquire(blocking=False):
            if session.latest_frame is not None:
                return self._frame_for_delivery(session, session.latest_frame)
            return self._capture_or_fallback(run_id, session)
        try:
            frame = session.latest_frame
            should_refresh = frame is not None and time.monotonic() - session.latest_frame_at >= self.frame_max_age_sec
            if frame is not None:
                if should_refresh:
                    self._refresh_in_background(run_id, session)
                return self._frame_for_delivery(session, frame)
        finally:
            session.lock.release()
        return self._capture_or_fallback(run_id, session)

    def _capture_or_fallback(self, run_id: str, session: _Session) -> Frame:
        try:
            return self.capture_frame(run_id)
        except LivePreviewError as exc:
            with session.lock:
                self._record_refresh_error(session, exc)
                if session.latest_frame is not None:
                    return self._frame_for_delivery(session, session.latest_frame)
            raise

    def wait_for_frame(
        self,
        run_id: str,
        *,
        after_sequence: int = 0,
        timeout_sec: float = 1.0,
    ) -> Frame:
        """Wait for a newer frame while respecting the configured capture cadence."""
        session = self._session(run_id)
        deadline = time.monotonic() + max(0.0, min(timeout_sec, 1.5))
        while True:
            should_refresh = False
            with session.lock:
                frame = session.latest_frame
                if frame is None:
                    break
                if frame.sequence > after_sequence:
                    return self._frame_for_delivery(session, frame)

                now = time.monotonic()
                remaining = deadline - now
                if remaining <= 0:
                    return self._frame_for_delivery(session, frame)

                if session.refresh_in_progress:
                    session.frame_condition.wait(timeout=remaining)
                    continue

                refresh_in = session.latest_frame_at + self.frame_max_age_sec - now
                if refresh_in > 0:
                    session.frame_condition.wait(timeout=min(remaining, refresh_in))
                    continue
                should_refresh = True

            if should_refresh:
                self._refresh_in_background(run_id, session)

        return self._capture_or_fallback(run_id, session)

    @staticmethod
    def _frame_for_delivery(session: _Session, frame: Frame) -> Frame:
        if not session.last_refresh_error:
            return frame
        return replace(frame, stale=True, warning=session.last_refresh_error)

    @staticmethod
    def _record_refresh_error(session: _Session, error: LivePreviewError) -> None:
        """Throttle retries after a failed capture while retaining the last frame."""
        session.last_refresh_error = str(error)
        session.latest_frame_at = time.monotonic()
        session.frame_condition.notify_all()

    def _refresh_in_background(
        self,
        run_id: str,
        session: _Session,
        *,
        force: bool = False,
    ) -> None:
        with session.lock:
            if session.refresh_in_progress:
                if force:
                    session.refresh_requested = True
                return
            session.refresh_in_progress = True

        def refresh() -> None:
            while True:
                try:
                    self.capture_frame(run_id)
                except LivePreviewError as exc:
                    with session.lock:
                        self._record_refresh_error(session, exc)
                with session.lock:
                    if session.refresh_requested:
                        session.refresh_requested = False
                        continue
                    session.refresh_in_progress = False
                    session.frame_condition.notify_all()
                    return

        threading.Thread(target=refresh, name=f"live-preview-{run_id[:8]}", daemon=True).start()

    def submit_input(self, run_id: str, payload: dict[str, Any]) -> Frame:
        """Apply device input, then capture its visual result outside the request path."""
        total_started_at = time.monotonic()
        action = parse_live_input(payload)
        session = self._session(run_id)
        with session.lock:
            target = self._resolve_target(session)
            needs_frame = session.screen_size is None
        if needs_frame:
            self.capture_frame(run_id)
        queued_at = time.monotonic()
        with self._target_access(target, input_priority=True), session.lock:
            queue_ms = (time.monotonic() - queued_at) * 1000
            assert session.screen_size is not None
            input_started_at = time.monotonic()
            if action.kind == "tap":
                x, y = normalized_to_pixel(action.start or (0, 0), session.screen_size)
                self._run(target, "shell", "uitest", "uiInput", "click", str(x), str(y))
            elif action.kind == "swipe":
                x1, y1 = normalized_to_pixel(action.start or (0, 0), session.screen_size)
                x2, y2 = normalized_to_pixel(action.end or (0, 0), session.screen_size)
                velocity = swipe_velocity((x1, y1), (x2, y2), action.duration_ms or 360)
                self._run(
                    target,
                    "shell",
                    "uitest",
                    "uiInput",
                    "swipe",
                    str(x1),
                    str(y1),
                    str(x2),
                    str(y2),
                    str(velocity),
                )
            elif action.kind == "scroll":
                start = (0.5, 0.72) if action.direction == "down" else (0.5, 0.28)
                end = (0.5, 0.28) if action.direction == "down" else (0.5, 0.72)
                x1, y1 = normalized_to_pixel(start, session.screen_size)
                x2, y2 = normalized_to_pixel(end, session.screen_size)
                velocity = swipe_velocity((x1, y1), (x2, y2), 260)
                self._run(
                    target,
                    "shell",
                    "uitest",
                    "uiInput",
                    "swipe",
                    str(x1),
                    str(y1),
                    str(x2),
                    str(y2),
                    str(velocity),
                )
            else:
                self._run(target, "shell", "uitest", "uiInput", "keyEvent", str(action.key))
            input_ms = (time.monotonic() - input_started_at) * 1000
            assert session.latest_frame is not None
            frame = self._frame_for_delivery(session, session.latest_frame)
            result = replace(
                frame,
                timings={
                    "queue_ms": round(queue_ms, 3),
                    "input_ms": round(input_ms, 3),
                    "total_ms": round((time.monotonic() - total_started_at) * 1000, 3),
                    "refresh_queued": 1,
                },
            )

        # The frame long-poll is already open in the browser. Capturing after the
        # request-critical HDC input lets that connection deliver the new frame
        # without making the POST wait for snapshot_display/file recv/JPEG work.
        self._refresh_in_background(run_id, session, force=True)
        return result

    def _cleanup_remote_later(self, target: str, remote_path: str) -> None:
        """Keep remote-file deletion off the click-to-frame critical path."""
        def cleanup() -> None:
            try:
                with self._target_access(target):
                    self._run(target, "shell", "rm", "-f", remote_path, check=False)
            except LivePreviewError:
                pass

        threading.Thread(
            target=cleanup,
            name="live-preview-cleanup",
            daemon=True,
        ).start()

    def _session(self, run_id: str) -> _Session:
        with self._sessions_lock:
            existing = self._sessions.get(run_id)
            if existing is not None:
                return existing
        target = self._resolve_default_target()
        with self._sessions_lock:
            return self._sessions.setdefault(
                run_id,
                _Session(lock=threading.RLock(), target=target),
            )

    @contextmanager
    def _target_access(self, target: str, *, input_priority: bool = False):
        with self._device_gates_lock:
            gate = self._device_gates.setdefault(
                target,
                _DeviceGate(condition=threading.Condition()),
            )
        with gate.condition:
            if input_priority:
                if gate.waiting_inputs >= self.max_queued_inputs:
                    raise LiveInputRateLimitError(
                        f"模拟器操作队列已满（最多等待 {self.max_queued_inputs} 个操作），请稍后重试。"
                    )
                gate.waiting_inputs += 1
            try:
                while True:
                    if gate.busy or (not input_priority and gate.waiting_inputs > 0):
                        gate.condition.wait()
                        continue
                    if input_priority:
                        wait_seconds = (
                            gate.last_input_started_at
                            + self.input_min_interval_sec
                            - time.monotonic()
                        )
                        if wait_seconds > 0:
                            gate.condition.wait(timeout=wait_seconds)
                            continue
                    break
                gate.busy = True
                if input_priority:
                    gate.last_input_started_at = time.monotonic()
            finally:
                if input_priority:
                    gate.waiting_inputs -= 1
        try:
            yield
        finally:
            with gate.condition:
                gate.busy = False
                gate.condition.notify_all()

    def _resolve_target(self, session: _Session) -> str:
        if session.target:
            return session.target
        session.target = self._resolve_default_target()
        return session.target

    def _resolve_default_target(self) -> str:
        if self._default_target:
            return self._default_target
        with self._target_resolution_lock:
            if self._default_target:
                return self._default_target
            if self.preferred_target:
                self._default_target = self.preferred_target
                return self._default_target
            hdc_bin = self._resolve_hdc_bin()
            result = self.command_runner(
                [hdc_bin, "list", "targets"], capture_output=True, text=True, check=False, timeout=10
            )
            if result.returncode != 0:
                raise LivePreviewError("无法读取 HarmonyOS 设备列表。")
            targets = [
                line.strip()
                for line in result.stdout.splitlines()
                if line.strip() and line.strip() != "[Empty]"
            ]
            if len(targets) != 1:
                raise LivePreviewError("请连接一个 HarmonyOS 模拟器，或设置 HP_HDC_TARGET。")
            self._default_target = targets[0]
            return self._default_target

    def _resolve_hdc_bin(self) -> str:
        if not self.hdc_bin:
            self.hdc_bin = resolve_hdc_binary()
        return self.hdc_bin

    def _run(self, target: str, *args: str, check: bool = True) -> float:
        elapsed_ms, _ = self._execute(target, *args, check=check)
        return elapsed_ms

    def _run_output(self, target: str, *args: str, check: bool = True) -> str:
        _, output = self._execute(target, *args, check=check)
        return output

    def _execute(self, target: str, *args: str, check: bool = True) -> tuple[float, str]:
        command = [self._resolve_hdc_bin(), "-t", target, *args]
        started_at = time.monotonic()
        try:
            result = self.command_runner(command, capture_output=True, text=True, check=False, timeout=20)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise LivePreviewError(f"执行 HDC 命令失败：{exc}") from exc
        output = "\n".join(item.strip() for item in (result.stdout, result.stderr) if item and item.strip())
        if check and (result.returncode != 0 or "[Fail]" in output or "error:" in output.lower()):
            raise LivePreviewError(f"模拟器操作失败：{output or '未知 HDC 错误'}")
        return (time.monotonic() - started_at) * 1000, output
