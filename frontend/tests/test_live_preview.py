import subprocess
import threading
import time
import unittest
from pathlib import Path

from scan_install.live_preview import (
    LiveInputRateLimitError,
    LivePreviewError,
    LocalLivePreview,
    normalized_to_pixel,
    parse_live_input,
    read_jpeg_size,
    swipe_velocity,
)


JPEG_1080_1920 = (
    b"\xff\xd8\xff\xc0\x00\x11\x08\x07\x80\x04\x38"
    + b"\x03\x01\x11\x00\x02\x11\x01\x03\x11\x01\xff\xd9"
)


class FakeHdc:
    def __init__(self) -> None:
        self.commands: list[list[str]] = []
        self.fail_snapshot = False

    def __call__(self, command, **_kwargs):
        command = list(command)
        self.commands.append(command)
        if self.fail_snapshot and "snapshot_display" in command:
            return subprocess.CompletedProcess(command, 1, stdout="", stderr="error: capture failed")
        if "file" in command and "recv" in command:
            Path(command[-1]).write_bytes(JPEG_1080_1920)
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")


class LiveInputTests(unittest.TestCase):
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
