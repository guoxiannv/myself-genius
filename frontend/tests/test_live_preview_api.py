from __future__ import annotations

import http.client
import importlib.util
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from scan_install.live_preview import Frame, LiveInputRateLimitError, parse_live_input


MODULE_PATH = Path(__file__).resolve().parents[1] / "app.py"
SPEC = importlib.util.spec_from_file_location("remote_ui_live_preview_app", MODULE_PATH)
remote_ui_app = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
sys.modules[SPEC.name] = remote_ui_app
SPEC.loader.exec_module(remote_ui_app)


class FakeLivePreview:
    def __init__(self) -> None:
        self.inputs: list[tuple[str, dict]] = []
        self.frame_requests: list[str] = []
        self.stale_frame = False
        self.reject_input = False
        self.frame_sequence = 0

    def capture_frame(self, run_id: str):
        self.frame_requests.append(run_id)
        self.frame_sequence += 1
        return Frame(
            data=b"fake-jpeg",
            width=10,
            height=20,
            sequence=self.frame_sequence,
            stale=self.stale_frame,
        )

    def get_latest_frame(self, run_id: str):
        return self.capture_frame(run_id)

    def wait_for_frame(self, run_id: str, **_kwargs):
        return self.capture_frame(run_id)

    def submit_input(self, run_id: str, payload: dict) -> Frame:
        if self.reject_input:
            raise LiveInputRateLimitError("模拟器操作队列已满")
        parse_live_input(payload)
        self.inputs.append((run_id, payload))
        return Frame(
            data=b"fake-jpeg",
            width=10,
            height=20,
            sequence=self.frame_sequence,
            stale=self.stale_frame,
            timings={"queue_ms": 0.5, "input_ms": 6.0, "total_ms": 6.5, "refresh_queued": 1},
        )


class FakeWebRTCPreview:
    def config_payload(self) -> dict:
        return {
            "available": True,
            "ice_servers": [{"urls": ["stun:example.test:3478"]}],
            "connect_timeout_ms": 10000,
            "transport": "datachannel-jpeg",
        }

    def create_answer(self, **kwargs) -> dict:
        self.last_offer = kwargs
        return {
            "ok": True,
            "peer_id": "peer-test",
            "sdp": "answer-sdp",
            "type": "answer",
            "local_candidate_types": ["host"],
        }



class LivePreviewApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_runs_dir = remote_ui_app.RUNS_DIR
        self.original_live_preview = remote_ui_app.LIVE_PREVIEW
        self.original_latency_log_path = remote_ui_app.LIVE_PREVIEW_LATENCY_LOG_PATH
        self.original_webrtc_preview = remote_ui_app.WEBRTC_PREVIEW
        remote_ui_app.RUNS_DIR = Path(self.temp_dir.name) / "runs"
        remote_ui_app.RUNS_DIR.mkdir()
        self.preview = FakeLivePreview()
        remote_ui_app.LIVE_PREVIEW = self.preview
        self.webrtc_preview = FakeWebRTCPreview()
        remote_ui_app.WEBRTC_PREVIEW = self.webrtc_preview
        remote_ui_app.LIVE_PREVIEW_LATENCY_LOG_PATH = Path(self.temp_dir.name) / "latency.jsonl"
        self.run_id = "c" * 32
        self.owner_id = "o" * 32
        self.share_token = "shared-preview-token"
        remote_ui_app.save_run(
            remote_ui_app.RunRecord(
                run_id=self.run_id,
                session_name="live-test",
                prompt="live test",
                workspace=self.temp_dir.name,
                variant="test",
                created_at=remote_ui_app.to_iso(),
                updated_at=remote_ui_app.to_iso(),
                owner_id=self.owner_id,
                share_token=self.share_token,
                capture_status="complete",
            )
        )
        self.server = remote_ui_app.ThreadingHTTPServer(("127.0.0.1", 0), remote_ui_app.RemoteUIHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        remote_ui_app.RUNS_DIR = self.original_runs_dir
        remote_ui_app.LIVE_PREVIEW = self.original_live_preview
        remote_ui_app.WEBRTC_PREVIEW = self.original_webrtc_preview
        remote_ui_app.LIVE_PREVIEW_LATENCY_LOG_PATH = self.original_latency_log_path
        self.temp_dir.cleanup()

    def request(
        self,
        method: str,
        path: str,
        *,
        body: dict | None = None,
        owner: bool = True,
        extra_headers: dict[str, str] | None = None,
    ):
        connection = http.client.HTTPConnection(*self.server.server_address)
        headers = {"Content-Type": "application/json"}
        if owner:
            headers["Cookie"] = f"{remote_ui_app.VISITOR_COOKIE_NAME}={self.owner_id}"
        headers.update(extra_headers or {})
        data = json.dumps(body).encode("utf-8") if body is not None else None
        connection.request(method, path, body=data, headers=headers)
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_owner_can_read_live_frame_and_send_input(self) -> None:
        status, headers, data = self.request("GET", f"/api/runs/{self.run_id}/live/frame")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/jpeg")
        self.assertEqual(headers["X-Harmony-Preview-Status"], "fresh")
        self.assertEqual(headers["X-Harmony-Preview-Sequence"], "1")
        self.assertEqual(headers["X-Harmony-Preview-Width"], "10")
        self.assertNotIn("Server-Timing", headers)
        self.assertEqual(data, b"fake-jpeg")

        status, headers, data = self.request(
            "POST",
            f"/api/runs/{self.run_id}/live/input",
            body={"type": "tap", "point": {"x": 0.5, "y": 0.5}},
            extra_headers={"CF-Ray": "abc123-HKG", "CF-IPCountry": "CN"},
        )
        self.assertEqual(status, 200)
        payload = json.loads(data)
        self.assertEqual(payload["ok"], True)
        self.assertEqual(payload["frame_seq"], 1)
        self.assertEqual(payload["frame_status"], "refreshing")
        self.assertEqual(payload["refresh_queued"], True)
        self.assertEqual(payload["timings"]["input_ms"], 6.0)
        self.assertIn("input;dur=6.000", headers["Server-Timing"])
        self.assertEqual(self.preview.inputs[0][0], self.run_id)
        log_entry = json.loads(remote_ui_app.LIVE_PREVIEW_LATENCY_LOG_PATH.read_text(encoding="utf-8"))
        self.assertEqual(log_entry["status"], "ok")
        self.assertEqual(log_entry["cf_colo"], "HKG")
        self.assertEqual(log_entry["cf_country"], "CN")
        self.assertEqual(log_entry["timings"]["input_ms"], 6.0)

    def test_stale_frame_is_exposed_without_failing_the_request(self) -> None:
        self.preview.stale_frame = True

        status, headers, data = self.request("GET", f"/api/runs/{self.run_id}/live/frame")

        self.assertEqual(status, 200)
        self.assertEqual(headers["X-Harmony-Preview-Status"], "stale")
        self.assertEqual(data, b"fake-jpeg")

    def test_owner_can_negotiate_optional_webrtc_transport(self) -> None:
        status, _, data = self.request(
            "GET",
            f"/api/runs/{self.run_id}/live/webrtc/config",
        )
        self.assertEqual(status, 200)
        config = json.loads(data)
        self.assertEqual(config["available"], True)
        self.assertEqual(config["offer_path"], f"/api/runs/{self.run_id}/live/webrtc/offer")

        status, _, data = self.request(
            "POST",
            f"/api/runs/{self.run_id}/live/webrtc/offer",
            body={"type": "offer", "sdp": "offer-sdp", "signaling_id": "signal-test"},
            extra_headers={"CF-Ray": "abc123-HKG", "CF-IPCountry": "CN"},
        )
        self.assertEqual(status, 200)
        answer = json.loads(data)
        self.assertEqual(answer["type"], "answer")
        self.assertEqual(answer["peer_id"], "peer-test")
        self.assertEqual(self.webrtc_preview.last_offer["network_fields"]["cf_colo"], "HKG")
        self.assertEqual(self.webrtc_preview.last_offer["signaling_id"], "signal-test")

    def test_full_device_queue_returns_too_many_requests(self) -> None:
        self.preview.reject_input = True

        status, _, data = self.request(
            "POST",
            f"/api/runs/{self.run_id}/live/input",
            body={"type": "tap", "point": {"x": 0.5, "y": 0.5}},
        )

        self.assertEqual(status, 429)
        self.assertIn("队列已满", json.loads(data)["error"])

    def test_other_visitors_cannot_access_live_preview(self) -> None:
        status, _, _ = self.request("GET", f"/api/runs/{self.run_id}/live/frame", owner=False)
        self.assertEqual(status, 404)
        self.assertEqual(self.preview.frame_requests, [])

        status, _, _ = self.request(
            "GET",
            f"/api/runs/{self.run_id}/live/webrtc/config",
            owner=False,
        )
        self.assertEqual(status, 404)
        status, _, _ = self.request(
            "POST",
            f"/api/runs/{self.run_id}/live/webrtc/offer",
            owner=False,
            body={"type": "offer", "sdp": "offer-sdp", "signaling_id": "signal-test"},
        )
        self.assertEqual(status, 404)

    def test_share_visitor_can_watch_control_and_negotiate_live_preview(self) -> None:
        share = f"share={self.share_token}"
        status, _, data = self.request(
            "GET",
            f"/api/runs/{self.run_id}/live/frame?{share}",
            owner=False,
        )
        self.assertEqual(status, 200)
        self.assertEqual(data, b"fake-jpeg")

        status, _, data = self.request(
            "POST",
            f"/api/runs/{self.run_id}/live/input?{share}",
            owner=False,
            body={"type": "tap", "point": {"x": 0.5, "y": 0.5}},
        )
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(data)["ok"])

        status, _, data = self.request(
            "GET",
            f"/api/runs/{self.run_id}/live/webrtc/config?{share}",
            owner=False,
        )
        self.assertEqual(status, 200)
        config = json.loads(data)
        self.assertIn(f"share={self.share_token}", config["offer_path"])

        status, _, data = self.request(
            "POST",
            config["offer_path"],
            owner=False,
            body={"type": "offer", "sdp": "offer-sdp", "signaling_id": "shared-signal"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["type"], "answer")

    def test_share_visitor_can_release_preview_lease(self) -> None:
        record = remote_ui_app.load_run(self.run_id)
        assert record is not None
        record.preview_sessions = {
            "phone": {
                "status": "ready",
                "target": "phone-1",
                "lease_id": "lease-1",
                "live_available": True,
            }
        }
        remote_ui_app.save_run(record)
        with patch.object(remote_ui_app, "release_preview_lease", side_effect=lambda record, kind, **_: record):
            status, _, data = self.request(
                "POST",
                f"/api/runs/{self.run_id}/previews/phone/release?share={self.share_token}",
                owner=False,
            )

        self.assertEqual(status, 200)
        self.assertTrue(json.loads(data)["ok"])

    def test_invalid_input_is_rejected_before_reaching_the_device(self) -> None:
        status, _, data = self.request(
            "POST",
            f"/api/runs/{self.run_id}/live/input",
            body={"type": "key", "key": "POWER"},
        )
        self.assertEqual(status, 400)
        self.assertIn("不支持", json.loads(data)["error"])
        self.assertEqual(self.preview.inputs, [])


if __name__ == "__main__":
    unittest.main()
