import http.client
import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Optional
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "app.py"
SPEC = importlib.util.spec_from_file_location("remote_ui_app", MODULE_PATH)
remote_ui_app = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
sys.modules[SPEC.name] = remote_ui_app
SPEC.loader.exec_module(remote_ui_app)


class RunOwnershipTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.original_runs_dir = remote_ui_app.RUNS_DIR
        self.original_target_workspace = remote_ui_app.TARGET_WORKSPACE
        self.original_signing_pool = remote_ui_app.get_signing_pool
        self.original_run_tmux = remote_ui_app.run_tmux_in_background
        self.original_wait_capture = remote_ui_app.wait_for_hap_and_capture
        self.original_wait_package = remote_ui_app.wait_for_hap_and_package
        self.original_build_progress = remote_ui_app.build_progress_payload
        self.original_start_package = remote_ui_app.start_hpack_packaging
        self.original_start_initial_package = remote_ui_app.start_initial_package_monitor
        self.original_root_password_hash = os.environ.get("HP_ROOT_PASSWORD_HASH")
        self.original_auth_signing_secret = os.environ.get("HP_AUTH_SIGNING_SECRET")
        remote_ui_app.RUNS_DIR = root / "runs"
        remote_ui_app.RUNS_DIR.mkdir()
        remote_ui_app.TARGET_WORKSPACE = root / "workspace"
        remote_ui_app.get_signing_pool = lambda: None
        remote_ui_app.run_tmux_in_background = lambda record: None
        remote_ui_app.wait_for_hap_and_capture = lambda record: None
        remote_ui_app.wait_for_hap_and_package = lambda record: None
        self.started_initial_packages: list[str] = []
        remote_ui_app.start_initial_package_monitor = lambda record: (
            self.started_initial_packages.append(record.run_id) or True
        )
        os.environ["HP_ROOT_PASSWORD_HASH"] = self.password_hash("root-password")
        os.environ["HP_AUTH_SIGNING_SECRET"] = "test-signing-secret-must-be-at-least-32-bytes"
        self.server = remote_ui_app.ThreadingHTTPServer(("127.0.0.1", 0), remote_ui_app.RemoteUIHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        remote_ui_app.RUNS_DIR = self.original_runs_dir
        remote_ui_app.TARGET_WORKSPACE = self.original_target_workspace
        remote_ui_app.get_signing_pool = self.original_signing_pool
        remote_ui_app.run_tmux_in_background = self.original_run_tmux
        remote_ui_app.wait_for_hap_and_capture = self.original_wait_capture
        remote_ui_app.wait_for_hap_and_package = self.original_wait_package
        remote_ui_app.build_progress_payload = self.original_build_progress
        remote_ui_app.start_hpack_packaging = self.original_start_package
        remote_ui_app.start_initial_package_monitor = self.original_start_initial_package
        self.restore_env("HP_ROOT_PASSWORD_HASH", self.original_root_password_hash)
        self.restore_env("HP_AUTH_SIGNING_SECRET", self.original_auth_signing_secret)
        self.temp_dir.cleanup()

    @staticmethod
    def restore_env(name: str, value: Optional[str]) -> None:
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value

    @staticmethod
    def password_hash(password: str) -> str:
        salt = b"ownership-test-salt"
        iterations = 1000
        digest = remote_ui_app.hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=32)
        return "pbkdf2_sha256$%s$%s$%s" % (
            iterations,
            remote_ui_app.base64url_encode(salt),
            remote_ui_app.base64url_encode(digest),
        )

    def request(self, method: str, path: str, *, body: Optional[dict] = None, cookie: str = ""):
        connection = http.client.HTTPConnection(*self.server.server_address)
        headers = {"Content-Type": "application/json"}
        if cookie:
            headers["Cookie"] = cookie
        data = json.dumps(body).encode("utf-8") if body is not None else None
        connection.request(method, path, body=data, headers=headers)
        response = connection.getresponse()
        payload = response.read()
        try:
            parsed = json.loads(payload or b"{}")
        except json.JSONDecodeError:
            parsed = payload.decode("utf-8", errors="replace")
        result = response.status, dict(response.getheaders()), parsed
        connection.close()
        return result

    def test_runs_are_scoped_to_anonymous_visitor_cookie(self) -> None:
        status, headers, created = self.request("POST", "/api/runs", body={"prompt": "生成一个应用"})
        self.assertEqual(status, 201)
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        run_id = created["run_id"]

        status, _, listed = self.request("GET", "/api/runs", cookie=cookie)
        self.assertEqual(status, 200)
        self.assertEqual([item["run_id"] for item in listed["runs"]], [run_id])

        status, second_headers, second_created = self.request("POST", "/api/runs", body={"prompt": "另一个应用"})
        self.assertEqual(status, 201)
        second_cookie = second_headers["Set-Cookie"].split(";", 1)[0]
        second_run_id = second_created["run_id"]

        status, _, listed = self.request("GET", "/api/runs", cookie=second_cookie)
        self.assertEqual(status, 200)
        self.assertEqual([item["run_id"] for item in listed["runs"]], [second_run_id])

        status, _, listed = self.request("GET", "/api/runs")
        self.assertEqual(status, 200)
        self.assertEqual(listed["runs"], [])

        status, _, _ = self.request("GET", f"/api/runs/{run_id}")
        self.assertEqual(status, 404)

        status, _, progress = self.request("GET", f"/api/runs/{run_id}", cookie=cookie)
        self.assertEqual(status, 200)
        self.assertEqual(progress["run"]["run_id"], run_id)
        self.assertTrue(progress["access"]["can_write"])
        self.assertIn(f"/runs/{run_id}?share=", progress["access"]["share_url"])

        status, root_headers, auth = self.request("POST", "/api/auth/login", body={"password": "root-password"})
        self.assertEqual(status, 200)
        self.assertEqual(auth["role"], "root")
        root_cookie = root_headers["Set-Cookie"].split(";", 1)[0]

        status, _, listed = self.request("GET", "/api/runs", cookie=root_cookie)
        self.assertEqual(status, 200)
        self.assertEqual({item["run_id"] for item in listed["runs"]}, {run_id, second_run_id})

        status, _, progress = self.request("GET", f"/api/runs/{second_run_id}", cookie=root_cookie)
        self.assertEqual(status, 200)
        self.assertEqual(progress["run"]["run_id"], second_run_id)

        record = remote_ui_app.load_run(run_id)
        self.assertIsNotNone(record)
        hap_path = Path(record.workspace) / remote_ui_app.EXPECTED_HAP_RELATIVE_PATH
        hap_path.parent.mkdir(parents=True)
        hap_path.write_bytes(b"hap")

        status, _, _ = self.request("GET", f"/api/runs/{run_id}/hap")
        self.assertEqual(status, 404)

        status, _, _ = self.request("GET", f"/api/runs/{run_id}/hap?share={record.share_token}")
        self.assertEqual(status, 200)

        status, _, _ = self.request("GET", f"/api/runs/{run_id}?share=incorrect-token")
        self.assertEqual(status, 404)

        status, _, shared = self.request("GET", f"/api/runs/{run_id}?share={record.share_token}")
        self.assertEqual(status, 200)
        self.assertFalse(shared["access"]["can_write"])
        self.assertTrue(shared["access"]["can_preview"])
        self.assertEqual(shared["access"]["mode"], "share")
        self.assertNotIn("owner_id", shared["run"])
        self.assertNotIn("share_token", shared["run"])
        self.assertNotIn("command", shared["distribution"])
        self.assertNotIn("manifest", shared["distribution"])
        self.assertIn(f"share={record.share_token}", shared["artifacts"]["hap_download_path"])

        with patch.object(
            remote_ui_app,
            "start_phone_preview",
            return_value=(record, False),
        ):
            status, _, preview = self.request(
                "POST",
                f"/api/runs/{run_id}/previews/phone/start?share={record.share_token}",
                body={"viewer_id": "shared-tab"},
            )
        self.assertEqual(status, 200)
        self.assertTrue(preview["ok"])
        self.assertEqual(
            remote_ui_app.preview_viewer_snapshot(run_id, "phone")["viewer_count"],
            1,
        )

        status, _, heartbeat = self.request(
            "POST",
            f"/api/runs/{run_id}/previews/phone/heartbeat?share={record.share_token}",
            body={"viewer_id": "shared-tab", "visible": True},
        )
        self.assertEqual(status, 200)
        self.assertTrue(heartbeat["ok"])

        status, _, left = self.request(
            "POST",
            f"/api/runs/{run_id}/previews/phone/heartbeat?share={record.share_token}",
            body={"viewer_id": "shared-tab", "leaving": True},
        )
        self.assertEqual(status, 200)
        self.assertEqual(left["viewer_count"], 0)

        status, _, _ = self.request(
            "POST",
            f"/api/runs/{run_id}/package?share={record.share_token}",
            body={},
        )
        self.assertEqual(status, 404)

    def test_create_run_starts_first_package_monitor(self) -> None:
        status, _, created = self.request("POST", "/api/runs", body={"prompt": "生成一个应用"})

        self.assertEqual(status, 201)
        record = remote_ui_app.load_run(created["run_id"])
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(
            Path(record.workspace),
            (remote_ui_app.TARGET_WORKSPACE / "current").resolve(),
        )
        self.assertEqual(
            self.started_initial_packages,
            [created["run_id"]],
        )

    def test_create_run_requires_configured_target_workspace(self) -> None:
        remote_ui_app.TARGET_WORKSPACE = Path()

        status, _, payload = self.request("POST", "/api/runs", body={"prompt": "生成一个应用"})

        self.assertEqual(status, 503)
        self.assertIn("HP_TARGET_WORKSPACE", payload["error"])
        self.assertEqual(list(remote_ui_app.RUNS_DIR.glob("*.json")), [])

    def test_cleanup_rejects_source_and_git_roots(self) -> None:
        with self.assertRaisesRegex(ValueError, "受保护目录"):
            remote_ui_app.clear_workspace_contents(remote_ui_app.APP_ROOT)

        git_workspace = Path(self.temp_dir.name) / "git-workspace"
        (git_workspace / ".git").mkdir(parents=True)
        marker = git_workspace / "keep.txt"
        marker.write_text("keep", encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "Git 仓库根目录"):
            remote_ui_app.clear_workspace_contents(git_workspace)
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep")

    def test_list_marks_complete_only_after_hpack_is_ready(self) -> None:
        status, headers, created = self.request("POST", "/api/runs", body={"prompt": "生成一个应用"})
        self.assertEqual(status, 201)
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        run_id = created["run_id"]

        record = remote_ui_app.load_run(run_id)
        self.assertIsNotNone(record)
        assert record is not None
        record.status = "succeeded"
        remote_ui_app.save_run(record)

        original_capture_manifest = remote_ui_app.load_capture_manifest
        original_hpack_manifest = remote_ui_app.load_hpack_manifest
        hpack_status: dict[str, str] | None = None
        remote_ui_app.load_capture_manifest = lambda _run_id: {"status": "complete"}
        remote_ui_app.load_hpack_manifest = lambda _run_id: hpack_status
        try:
            status, _, listed = self.request("GET", "/api/runs", cookie=cookie)
            self.assertEqual(status, 200)
            self.assertEqual(listed["runs"][0]["status"], "active")

            hpack_status = {"status": "ready"}
            status, _, listed = self.request("GET", "/api/runs", cookie=cookie)
            self.assertEqual(status, 200)
            self.assertEqual(listed["runs"][0]["status"], "complete")

            record = remote_ui_app.load_run(run_id)
            assert record is not None
            record.latest_adjustment_at = "2026-07-29T10:01:00+00:00"
            record.package_source_adjustment_at = ""
            remote_ui_app.save_run(record)
            status, _, listed = self.request("GET", "/api/runs", cookie=cookie)
            self.assertEqual(status, 200)
            self.assertEqual(listed["runs"][0]["status"], "active")

            record.package_source_adjustment_at = record.latest_adjustment_at
            remote_ui_app.save_run(record)
            status, _, listed = self.request("GET", "/api/runs", cookie=cookie)
            self.assertEqual(status, 200)
            self.assertEqual(listed["runs"][0]["status"], "complete")
        finally:
            remote_ui_app.load_capture_manifest = original_capture_manifest
            remote_ui_app.load_hpack_manifest = original_hpack_manifest

    def test_manual_package_requires_owner_and_ready_artifacts(self) -> None:
        status, headers, created = self.request("POST", "/api/runs", body={"prompt": "生成一个应用"})
        self.assertEqual(status, 201)
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        run_id = created["run_id"]

        status, _, _ = self.request("POST", f"/api/runs/{run_id}/package", body={})
        self.assertEqual(status, 404)

        remote_ui_app.build_progress_payload = lambda _record: {
            "artifacts": {
                "package_current": False,
                "package_can_start": False,
                "distribution_status": "waiting_preview",
            }
        }
        status, _, payload = self.request(
            "POST",
            f"/api/runs/{run_id}/package",
            body={},
            cookie=cookie,
        )
        self.assertEqual(status, 409)
        self.assertEqual(payload["code"], "package_not_ready")

        started = []
        remote_ui_app.build_progress_payload = lambda _record: {
            "artifacts": {
                "package_current": False,
                "package_can_start": True,
                "distribution_status": "ready_to_package",
            }
        }
        remote_ui_app.start_hpack_packaging = lambda record, replace_manifest=False: (
            started.append((record.run_id, replace_manifest)) or True
        )
        status, _, payload = self.request(
            "POST",
            f"/api/runs/{run_id}/package",
            body={},
            cookie=cookie,
        )
        self.assertEqual(status, 202)
        self.assertTrue(payload["accepted"])
        self.assertEqual(started, [(run_id, False)])


if __name__ == "__main__":
    unittest.main()
