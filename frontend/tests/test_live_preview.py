import subprocess
import threading
import time
import unittest
from io import BytesIO
from unittest.mock import patch
from pathlib import Path

from PIL import Image

from scan_install.live_preview import (
    LiveInputRateLimitError,
    LivePreviewError,
    LocalLivePreview,
    normalized_to_pixel,
    parse_open_bundle_names,
    parse_live_input,
    parse_bundle_pid,
    parse_layout_control_bounds,
    parse_render_resolution,
    parse_window_bounds,
    read_jpeg_size,
    swipe_velocity,
    window_is_maximized,
)


JPEG_1080_1920 = (
    b"\xff\xd8\xff\xc0\x00\x11\x08\x07\x80\x04\x38"
    + b"\x03\x01\x11\x00\x02\x11\x01\x03\x11\x01\xff\xd9"
)


class FakeHdc:
    def __init__(self, jpeg_data: bytes = JPEG_1080_1920) -> None:
        self.commands: list[list[str]] = []
        self.fail_snapshot = False
        self.jpeg_data = jpeg_data

    def __call__(self, command, **_kwargs):
        command = list(command)
        self.commands.append(command)
        if self.fail_snapshot and "snapshot_display" in command:
            return subprocess.CompletedProcess(command, 1, stdout="", stderr="error: capture failed")
        if "file" in command and "recv" in command:
            Path(command[-1]).write_bytes(self.jpeg_data)
        if command[-3:] == ["aa", "dump", "-a"]:
            return subprocess.CompletedProcess(
                command,
                0,
                stdout="  AppRunningRecord ID #1\n    process name [com.example.app]\n      pid #1234\n",
                stderr="",
            )
        if "WindowManagerService" in command:
            return subprocess.CompletedProcess(
                command,
                0,
                stdout="ide0 0 1234 111 1 102 0 110 0 [ 100 100 1000 700 ]",
                stderr="",
            )
        if "RenderService" in command:
            return subprocess.CompletedProcess(
                command,
                0,
                stdout="render resolution=1200x800",
                stderr="",
            )
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")


def make_jpeg(width: int, height: int) -> bytes:
    output = BytesIO()
    Image.new("RGB", (width, height), "white").save(output, format="JPEG", quality=85)
    return output.getvalue()


class LiveInputTests(unittest.TestCase):
    def test_parse_window_metadata(self) -> None:
        self.assertEqual(
            parse_bundle_pid("process name [com.example.app]\n  pid #1234", "com.example.app"),
            "1234",
        )
        self.assertEqual(
            parse_window_bounds("ide0 0 1234 111 1 102 0 110 0 [ 100 100 1000 700 ]", "1234"),
            (100, 100, 1000, 700),
        )
        self.assertEqual(parse_render_resolution("render resolution=1200x800"), (1200, 800))
        self.assertFalse(window_is_maximized((100, 100, 1000, 700), (1200, 800)))
        self.assertTrue(window_is_maximized((0, 0, 1200, 740), (1200, 800)))

    def test_parse_maximize_control_from_requested_bundle(self) -> None:
        layout = """{
          "attributes": {},
          "children": [{
            "attributes": {"id": "EnhanceMaximizeBtn", "bounds": "[2877,9][2930,62]"},
            "children": []
          }, {
            "attributes": {"bundleName": "com.example.app"},
            "children": []
          }]
        }"""
        self.assertEqual(
            parse_layout_control_bounds(layout, "com.example.app", "EnhanceMaximizeBtn"),
            (2877, 9, 53, 53),
        )

    def test_open_bundle_names_only_come_from_current_missions(self) -> None:
        ability_dump = """User ID #100
  current mission lists:{
    Mission ID #70
        bundle name [com.example.old.one]
    Mission ID #71
        bundle name [com.example.old.two]
        bundle name [com.example.old.one]
 }
  ExtensionRecords:
      bundle name [com.ohos.system.service]
"""

        self.assertEqual(
            parse_open_bundle_names(ability_dump),
            ["com.example.old.one", "com.example.old.two"],
        )

    def test_parse_tap_requires_normalized_coordinates(self) -> None:
        action = parse_live_input({"type": "tap", "point": {"x": 0.25, "y": 0.75}})
        self.assertEqual(action.kind, "tap")
        self.assertEqual(action.start, (0.25, 0.75))
        with self.assertRaises(LivePreviewError):
            parse_live_input({"type": "tap", "point": {"x": 1.1, "y": 0.2}})

    def test_normalized_coordinates_map_to_device_bounds(self) -> None:
        self.assertEqual(normalized_to_pixel((0, 0), (1080, 1920)), (0, 0))
        self.assertEqual(normalized_to_pixel((1, 1), (1080, 1920)), (1079, 1919))

    def test_jpeg_size_is_read_without_a_runtime_image_dependency(self) -> None:
        self.assertEqual(read_jpeg_size(JPEG_1080_1920), (1080, 1920))

    def test_swipe_duration_is_converted_to_supported_pixel_velocity(self) -> None:
        self.assertEqual(swipe_velocity((0, 0), (0, 1000), 500), 2000)
        self.assertEqual(swipe_velocity((0, 0), (0, 10), 1000), 200)
        self.assertEqual(swipe_velocity((0, 0), (40_000, 0), 100), 40_000)


class LocalLivePreviewTests(unittest.TestCase):
    def test_install_and_launch_prepares_device_and_returns_first_frame(self) -> None:
        fake_hdc = FakeHdc()
        original_runner = fake_hdc

        preview = LocalLivePreview(
            preferred_target="emulator-phone",
            hdc_bin="/fake/hdc",
            command_runner=original_runner,
        )
        with patch("scan_install.live_preview.time.sleep"):
            with patch.object(Path, "is_file", return_value=True):
                frame = preview.install_and_launch(
                    "run:phone",
                    hap_path=Path("/tmp/app.hap"),
                    bundle_name="com.example.app",
                    ability_name="MainAbility",
                )

        commands = [command[3:] for command in fake_hdc.commands if command[1:3] == ["-t", "emulator-phone"]]
        install_index = commands.index(["install", "-r", "/tmp/app.hap"])
        self.assertIn(["shell", "aa", "force-stop", "com.example.app"], commands)
        self.assertNotIn(["shell", "aa", "force-stop", "com.example.previous"], commands)
        self.assertLess(commands.index(["shell", "aa", "force-stop", "com.example.app"]), install_index)
        self.assertIn(["install", "-r", "/tmp/app.hap"], commands)
        self.assertIn(["shell", "aa", "start", "-b", "com.example.app", "-a", "MainAbility"], commands)
        self.assertTrue(any("power-shell" in command for command in commands))
        self.assertEqual((frame.width, frame.height), (1080, 1920))

    def test_release_session_allows_binding_a_new_target(self) -> None:
        preview = LocalLivePreview(preferred_target="phone-one", hdc_bin="/fake/hdc", command_runner=FakeHdc())
        preview.bind_target("run:phone", "phone-one", preview_kind="phone")
        preview.release_session("run:phone")
        preview.bind_target("run:phone", "phone-two", preview_kind="phone")
        self.assertEqual(preview._session("run:phone").target, "phone-two")

    def test_bound_session_does_not_resolve_an_ambiguous_default_target(self) -> None:
        def multiple_targets(command, **_kwargs):
            return subprocess.CompletedProcess(command, 0, stdout="phone-one\nphone-two\n", stderr="")

        preview = LocalLivePreview(hdc_bin="/fake/hdc", command_runner=multiple_targets)
        preview.bind_target("run:phone", "phone-two", preview_kind="phone")

        self.assertEqual(preview._session("run:phone").target, "phone-two")

    def test_install_and_launch_prepares_phone_and_returns_first_frame(self) -> None:
        fake_hdc = FakeHdc()
        preview = LocalLivePreview(
            preferred_target="emulator-phone",
            hdc_bin="/fake/hdc",
            command_runner=fake_hdc,
        )
        preview.bind_target("run:phone", "emulator-phone", preview_kind="phone")
        with patch("scan_install.live_preview.time.sleep", return_value=None):
            with patch.object(Path, "is_file", return_value=True):
                frame = preview.install_and_launch(
                    "run:phone",
                    hap_path=Path("/tmp/app.hap"),
                    bundle_name="com.example.app",
                )

        self.assertEqual((frame.width, frame.height), (1080, 1920))
        flattened = [command[3:] for command in fake_hdc.commands if command[1:3] == ["-t", "emulator-phone"]]
        self.assertIn(["install", "-r", "/tmp/app.hap"], flattened)
        self.assertIn(["shell", "aa", "start", "-b", "com.example.app", "-a", "EntryAbility"], flattened)
        self.assertTrue(any("power-shell" in command for command in flattened))
        self.assertTrue(any("snapshot_display" in command for command in flattened))

    def test_desktop_launch_clicks_maximize_control(self) -> None:
        fake_hdc = FakeHdc()
        preview = LocalLivePreview(
            preferred_target="emulator-desktop",
            hdc_bin="/fake/hdc",
            command_runner=fake_hdc,
        )
        preview.bind_target("run:desktop", "emulator-desktop", preview_kind="desktop")

        window_dumps = iter([
            "ide0 0 1234 111 1 102 0 110 0 [ 100 100 1000 700 ]",
            "ide0 0 1234 111 1 1 0 110 0 [ 0 0 1200 740 ]",
        ])

        def output(_target, *args, **_kwargs):
            if args[-3:] == ("aa", "dump", "-a"):
                return "process name [com.example.app]\n  pid #1234"
            if "WindowManagerService" in args:
                return next(window_dumps)
            if "RenderService" in args:
                return "render resolution=1200x800"
            return ""

        with patch("scan_install.live_preview.time.sleep", return_value=None), patch.object(
            Path, "is_file", return_value=True
        ), patch.object(preview, "_run_output", side_effect=output), patch.object(
            preview, "_desktop_maximize_control_bounds", return_value=(970, 95, 60, 50)
        ):
            preview.install_and_launch(
                "run:desktop",
                hap_path=Path("/tmp/app.hap"),
                bundle_name="com.example.app",
                maximize=True,
            )

        commands = [
            command[3:]
            for command in fake_hdc.commands
            if command[1:3] == ["-t", "emulator-desktop"]
        ]
        self.assertIn(
            ["shell", "aa", "start", "-b", "com.example.app", "-a", "EntryAbility"],
            commands,
        )
        self.assertIn(["shell", "uitest", "uiInput", "click", "1000", "120"], commands)

    def test_desktop_maximize_waits_for_cold_start_window(self) -> None:
        fake_hdc = FakeHdc()
        preview = LocalLivePreview(
            preferred_target="emulator-desktop",
            hdc_bin="/fake/hdc",
            command_runner=fake_hdc,
        )
        ability_dumps = iter([
            "",
            "process name [com.example.app]\n  pid #1234",
        ])
        window_dumps = iter([
            "ide0 0 1234 111 1 102 0 110 0 [ 100 100 1000 700 ]",
            "ide0 0 1234 111 1 1 0 110 0 [ 0 0 1200 740 ]",
        ])

        def output(_target, *args, **_kwargs):
            if args[-3:] == ("aa", "dump", "-a"):
                return next(ability_dumps)
            if "WindowManagerService" in args:
                return next(window_dumps)
            if "RenderService" in args:
                return "render resolution=1200x800"
            return ""

        with patch.object(preview, "_run_output", side_effect=output), patch.object(
            preview, "_run", return_value=0
        ) as runner, patch.object(
            preview, "_desktop_maximize_control_bounds", return_value=None
        ), patch("scan_install.live_preview.time.sleep", return_value=None):
            preview._maximize_desktop_window("emulator-desktop", "com.example.app")

        runner.assert_called_once_with(
            "emulator-desktop",
            "shell",
            "uitest",
            "uiInput",
            "click",
            "1030",
            "135",
            check=False,
        )

    def test_release_session_allows_rebinding_to_another_target(self) -> None:
        preview = LocalLivePreview(
            preferred_target="emulator-phone",
            hdc_bin="/fake/hdc",
            command_runner=FakeHdc(),
        )
        preview.bind_target("run:phone", "phone-1", preview_kind="phone")
        preview.release_session("run:phone")
        preview.bind_target("run:phone", "phone-2", preview_kind="phone")
        self.assertEqual(preview._session("run:phone").target, "phone-2")

    def test_last_activity_tracks_captured_frames_and_clears_on_release(self) -> None:
        preview = LocalLivePreview(
            preferred_target="emulator-1",
            hdc_bin="/fake/hdc",
            command_runner=FakeHdc(),
        )
        preview.bind_target("run:desktop", "emulator-1", preview_kind="desktop")

        self.assertEqual(preview.last_activity_at("run:desktop"), 0.0)
        preview.capture_frame("run:desktop")
        self.assertGreater(preview.last_activity_at("run:desktop"), 0.0)
        preview.release_session("run:desktop")
        self.assertEqual(preview.last_activity_at("run:desktop"), 0.0)

    def test_logical_preview_sessions_bind_to_distinct_targets(self) -> None:
        fake_hdc = FakeHdc()
        preview = LocalLivePreview(
            preferred_target="emulator-default",
            hdc_bin="/fake/hdc",
            command_runner=fake_hdc,
        )

        preview.bind_target("run:desktop", "emulator-desktop", preview_kind="desktop")
        preview.bind_target("run:phone", "emulator-phone", preview_kind="phone")
        preview.capture_frame("run:desktop")
        preview.capture_frame("run:phone")

        targets = [command[2] for command in fake_hdc.commands if len(command) > 2 and command[1] == "-t"]
        self.assertIn("emulator-desktop", targets)
        self.assertIn("emulator-phone", targets)
        self.assertEqual(preview._session("run:desktop").preview_kind, "desktop")
        self.assertEqual(preview._session("run:phone").preview_kind, "phone")
        with self.assertRaises(LivePreviewError):
            preview.bind_target("run:desktop", "emulator-other")

    def test_desktop_preview_keeps_native_width_while_phone_uses_compact_frames(self) -> None:
        source = make_jpeg(1200, 800)
        preview = LocalLivePreview(
            preferred_target="emulator-1",
            hdc_bin="/fake/hdc",
            command_runner=FakeHdc(source),
            preview_max_width=660,
            desktop_preview_max_width=3120,
        )
        preview.bind_target("run:desktop", "emulator-1", preview_kind="desktop")
        preview.bind_target("run:phone", "emulator-1", preview_kind="phone")

        desktop = preview.capture_frame("run:desktop")
        phone = preview.capture_frame("run:phone")

        self.assertEqual((desktop.width, desktop.height), (1200, 800))
        self.assertEqual((phone.width, phone.height), (660, 440))

    def test_recent_frame_is_served_from_cache_without_another_hdc_capture(self) -> None:
        fake_hdc = FakeHdc()
        preview = LocalLivePreview(
            preferred_target="emulator-1",
            hdc_bin="/fake/hdc",
            command_runner=fake_hdc,
            frame_max_age_sec=10,
        )

        captured = preview.capture_frame("d" * 32)
        command_count = len(fake_hdc.commands)
        cached = preview.get_latest_frame("d" * 32)

        self.assertEqual(cached, captured)
        self.assertEqual(len(fake_hdc.commands), command_count)

    def test_failed_refresh_returns_the_last_frame_as_stale(self) -> None:
        fake_hdc = FakeHdc()
        preview = LocalLivePreview(
            preferred_target="emulator-1",
            hdc_bin="/fake/hdc",
            command_runner=fake_hdc,
            frame_max_age_sec=0.1,
        )
        run_id = "z" * 32
        captured = preview.capture_frame(run_id)
        fake_hdc.fail_snapshot = True
        session = preview._session(run_id)
        session.latest_frame_at = time.monotonic() - 1

        preview.get_latest_frame(run_id)
        deadline = time.monotonic() + 1
        while session.refresh_in_progress and time.monotonic() < deadline:
            time.sleep(0.01)
        fallback = preview.get_latest_frame(run_id)

        self.assertEqual(fallback.data, captured.data)
        self.assertTrue(fallback.stale)
        self.assertIn("capture failed", fallback.warning)

    def test_capture_then_tap_uses_hdc_with_mapped_coordinates(self) -> None:
        fake_hdc = FakeHdc()
        preview = LocalLivePreview(
            preferred_target="emulator-1",
            hdc_bin="/fake/hdc",
            command_runner=fake_hdc,
        )

        frame = preview.capture_frame("a" * 32)
        input_frame = preview.submit_input(
            "a" * 32,
            {"type": "tap", "point": {"x": 0.5, "y": 0.5}},
        )

        self.assertEqual((frame.width, frame.height), (1080, 1920))
        self.assertEqual(input_frame.sequence, frame.sequence)
        self.assertIn("input_ms", input_frame.timings)
        self.assertEqual(input_frame.timings["refresh_queued"], 1)
        click = next(command for command in fake_hdc.commands if "click" in command)
        self.assertEqual(click[-2:], ["540", "960"])
        session = preview._session("a" * 32)
        deadline = time.monotonic() + 1
        while session.refresh_in_progress and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertIsNotNone(session.latest_frame)
        self.assertGreater(session.latest_frame.sequence, frame.sequence)

    def test_runs_on_the_same_target_keep_frames_isolated(self) -> None:
        fake_hdc = FakeHdc()
        preview = LocalLivePreview(
            preferred_target="emulator-1",
            hdc_bin="/fake/hdc",
            command_runner=fake_hdc,
            frame_max_age_sec=10,
        )

        captured = preview.capture_frame("a" * 32)
        snapshot_count = sum("snapshot_display" in command for command in fake_hdc.commands)
        second_run = preview.get_latest_frame("b" * 32)

        self.assertEqual(second_run.sequence, 1)
        self.assertEqual(captured.sequence, 1)
        self.assertGreater(
            sum("snapshot_display" in command for command in fake_hdc.commands),
            snapshot_count,
        )

    def test_swipe_and_key_are_limited_to_expected_hdc_commands(self) -> None:
        fake_hdc = FakeHdc()
        preview = LocalLivePreview(
            preferred_target="emulator-1",
            hdc_bin="/fake/hdc",
            command_runner=fake_hdc,
        )
        preview.capture_frame("b" * 32)
        preview.submit_input(
            "b" * 32,
            {
                "type": "swipe",
                "start": {"x": 0.5, "y": 0.8},
                "end": {"x": 0.5, "y": 0.2},
                "duration_ms": 320,
            },
        )
        preview.submit_input("b" * 32, {"type": "key", "key": "BACK"})

        swipe = next(command for command in fake_hdc.commands if "swipe" in command)
        self.assertEqual(swipe[-5:-1], ["540", "1535", "540", "384"])
        self.assertGreaterEqual(int(swipe[-1]), 200)
        key = next(command for command in fake_hdc.commands if "keyEvent" in command)
        self.assertEqual(key[-1], "BACK")

    def test_scroll_uses_a_centered_swipe(self) -> None:
        fake_hdc = FakeHdc()
        preview = LocalLivePreview(
            preferred_target="emulator-1",
            hdc_bin="/fake/hdc",
            command_runner=fake_hdc,
        )

        preview.submit_input("c" * 32, {"type": "scroll", "direction": "down"})

        swipe = next(command for command in fake_hdc.commands if "swipe" in command)
        self.assertEqual(swipe[-5:-1], ["540", "1382", "540", "537"])
        self.assertGreaterEqual(int(swipe[-1]), 200)

    def test_runs_for_the_same_target_do_not_interleave_hdc_commands(self) -> None:
        active_calls = 0
        max_active_calls = 0
        calls_lock = threading.Lock()

        def slow_hdc(command, **_kwargs):
            nonlocal active_calls, max_active_calls
            command = list(command)
            with calls_lock:
                active_calls += 1
                max_active_calls = max(max_active_calls, active_calls)
            try:
                time.sleep(0.01)
                if "file" in command and "recv" in command:
                    Path(command[-1]).write_bytes(JPEG_1080_1920)
                return subprocess.CompletedProcess(command, 0, stdout="", stderr="")
            finally:
                with calls_lock:
                    active_calls -= 1

        preview = LocalLivePreview(
            preferred_target="emulator-1",
            hdc_bin="/fake/hdc",
            command_runner=slow_hdc,
        )
        threads = [
            threading.Thread(target=preview.capture_frame, args=(run_id,))
            for run_id in ("e" * 32, "f" * 32)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(max_active_calls, 1)

    def test_waiting_input_runs_before_the_next_capture(self) -> None:
        preview = LocalLivePreview(
            preferred_target="emulator-1",
            hdc_bin="/fake/hdc",
            command_runner=FakeHdc(),
        )
        first_entered = threading.Event()
        release_first = threading.Event()
        order: list[str] = []

        def access(label: str, *, input_priority: bool = False, block: bool = False) -> None:
            with preview._target_access("emulator-1", input_priority=input_priority):
                order.append(label)
                if block:
                    first_entered.set()
                    release_first.wait(timeout=1)

        first = threading.Thread(target=access, args=("active-capture",), kwargs={"block": True})
        queued_capture = threading.Thread(target=access, args=("queued-capture",))
        queued_input = threading.Thread(
            target=access,
            args=("queued-input",),
            kwargs={"input_priority": True},
        )
        first.start()
        self.assertTrue(first_entered.wait(timeout=1))
        queued_capture.start()
        time.sleep(0.01)
        queued_input.start()
        time.sleep(0.01)
        release_first.set()
        for thread in (first, queued_capture, queued_input):
            thread.join(timeout=1)

        self.assertEqual(order, ["active-capture", "queued-input", "queued-capture"])

    def test_device_input_queue_rejects_excess_requests(self) -> None:
        preview = LocalLivePreview(
            preferred_target="emulator-1",
            hdc_bin="/fake/hdc",
            command_runner=FakeHdc(),
            max_queued_inputs=1,
        )
        active_entered = threading.Event()
        release_active = threading.Event()

        def hold_device() -> None:
            with preview._target_access("emulator-1"):
                active_entered.set()
                release_active.wait(timeout=1)

        def queue_input() -> None:
            with preview._target_access("emulator-1", input_priority=True):
                pass

        active = threading.Thread(target=hold_device)
        queued = threading.Thread(target=queue_input)
        active.start()
        self.assertTrue(active_entered.wait(timeout=1))
        queued.start()

        gate = preview._device_gates["emulator-1"]
        deadline = time.monotonic() + 1
        while gate.waiting_inputs < 1 and time.monotonic() < deadline:
            time.sleep(0.01)

        with self.assertRaises(LiveInputRateLimitError):
            with preview._target_access("emulator-1", input_priority=True):
                pass

        release_active.set()
        active.join(timeout=1)
        queued.join(timeout=1)

    def test_wait_for_frame_wakes_when_a_new_sequence_is_captured(self) -> None:
        preview = LocalLivePreview(
            preferred_target="emulator-1",
            hdc_bin="/fake/hdc",
            command_runner=FakeHdc(),
            frame_max_age_sec=10,
        )
        run_id = "w" * 32
        first = preview.capture_frame(run_id)
        result: list = []

        waiter = threading.Thread(
            target=lambda: result.append(
                preview.wait_for_frame(
                    run_id,
                    after_sequence=first.sequence,
                    timeout_sec=1,
                )
            )
        )
        waiter.start()
        time.sleep(0.02)
        second = preview.capture_frame(run_id)
        waiter.join(timeout=1)

        self.assertFalse(waiter.is_alive())
        self.assertEqual(result[0].sequence, second.sequence)
        self.assertGreater(second.sequence, first.sequence)

    def test_stale_frame_honors_long_poll_timeout_before_retrying(self) -> None:
        preview = LocalLivePreview(
            preferred_target="emulator-1",
            hdc_bin="/fake/hdc",
            command_runner=FakeHdc(),
            frame_max_age_sec=10,
        )
        run_id = "y" * 32
        first = preview.capture_frame(run_id)
        session = preview._session(run_id)
        with session.lock:
            session.last_refresh_error = "capture failed"

        started_at = time.monotonic()
        frame = preview.wait_for_frame(run_id, after_sequence=first.sequence, timeout_sec=0.05)

        self.assertGreaterEqual(time.monotonic() - started_at, 0.04)
        self.assertTrue(frame.stale)


if __name__ == "__main__":
    unittest.main()
