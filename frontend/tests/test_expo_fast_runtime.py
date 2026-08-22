import http.client
import importlib.util
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Optional
from unittest.mock import patch
from urllib.parse import urlparse

from scan_install.expo_gateway import ExpoPublicGateway
from tests.test_expo_public_gateway import write_harmony_go_export


MODULE_PATH = Path(__file__).resolve().parents[1] / "app.py"
SPEC = importlib.util.spec_from_file_location("remote_ui_expo_app", MODULE_PATH)
remote_ui_app = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
sys.modules[SPEC.name] = remote_ui_app
SPEC.loader.exec_module(remote_ui_app)


class ExpoFastRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.original_runs_dir = remote_ui_app.RUNS_DIR
        self.original_expo_root = remote_ui_app.EXPO_FAST_ROOT
        self.original_expo_launcher = remote_ui_app.EXPO_FAST_LAUNCHER
        self.original_expo_app_root = remote_ui_app.EXPO_FAST_APP_ROOT
        self.original_run_expo = remote_ui_app.run_expo_fast_in_background
        self.original_get_signing_pool = remote_ui_app.get_signing_pool
        self.original_hpack_enabled = remote_ui_app.HPACK_ENABLED
        self.original_trace_cache = dict(remote_ui_app.EXPO_TRACE_CACHE)

        remote_ui_app.RUNS_DIR = root / "runs"
        remote_ui_app.RUNS_DIR.mkdir()
        remote_ui_app.EXPO_FAST_ROOT = root / "runtime"
        remote_ui_app.EXPO_FAST_ROOT.mkdir()
        remote_ui_app.EXPO_FAST_LAUNCHER = remote_ui_app.EXPO_FAST_ROOT / "start-livetest.sh"
        remote_ui_app.EXPO_FAST_LAUNCHER.write_text("#!/bin/sh\n", encoding="utf-8")
        remote_ui_app.EXPO_FAST_APP_ROOT = root / "apps"
        # HTTP tests must never acquire leases from the repository's real Profile pool.
        class FakeSlot:
            id = "test-slot"
            cert = root / "test.cer"
            profile = root / "test.p7b"
            keystore = root / "test.p12"
            alias = "test-alias"

            @staticmethod
            def resolved_bundle_name() -> str:
                return "com.example.test.slot"

        class FakePool:
            def cleanup_stale(self) -> None:
                return None

            def acquire(self, _run_id: str, _session_name: str):
                return FakeSlot()

            def release(self, _run_id: str) -> bool:
                return True

        self.fake_signing_pool = FakePool()
        remote_ui_app.get_signing_pool = lambda: self.fake_signing_pool
        remote_ui_app.HPACK_ENABLED = True
        remote_ui_app.EXPO_TRACE_CACHE.clear()
        self.started: list[str] = []
        self.resumed: list[str] = []
        self.actions: list[str] = []
        self.start_event = threading.Event()

        def fake_start(record, *, action: str = "initial", **_options) -> None:
            self.started.append(record.run_id)
            self.actions.append(action)
            if action != "initial":
                self.resumed.append(record.run_id)
            self.start_event.set()

        remote_ui_app.run_expo_fast_in_background = fake_start
        self.server = remote_ui_app.ThreadingHTTPServer(("127.0.0.1", 0), remote_ui_app.RemoteUIHandler)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server_thread.join()
        self.server.server_close()
        remote_ui_app.RUNS_DIR = self.original_runs_dir
        remote_ui_app.EXPO_FAST_ROOT = self.original_expo_root
        remote_ui_app.EXPO_FAST_LAUNCHER = self.original_expo_launcher
        remote_ui_app.EXPO_FAST_APP_ROOT = self.original_expo_app_root
        remote_ui_app.run_expo_fast_in_background = self.original_run_expo
        remote_ui_app.get_signing_pool = self.original_get_signing_pool
        remote_ui_app.HPACK_ENABLED = self.original_hpack_enabled
        remote_ui_app.EXPO_TRACE_CACHE.clear()
        remote_ui_app.EXPO_TRACE_CACHE.update(self.original_trace_cache)
        self.temp_dir.cleanup()

    def request(self, method: str, path: str, *, body: Optional[dict] = None, cookie: str = ""):
        connection = http.client.HTTPConnection(*self.server.server_address)
        headers = {"Content-Type": "application/json"}
        if cookie:
            headers["Cookie"] = cookie
        data = json.dumps(body).encode("utf-8") if body is not None else None
        connection.request(method, path, body=data, headers=headers)
        response = connection.getresponse()
        payload = json.loads(response.read() or b"{}")
        result = response.status, dict(response.getheaders()), payload
        connection.close()
        return result

    def test_create_expo_run_creates_empty_workspace_and_markdown_prompt(self) -> None:
        prompt = "做一个支持每日打卡与连续天数统计的应用"
        status, headers, payload = self.request(
            "POST",
            "/api/runs",
            body={
                "prompt": prompt,
                "runtime": "expo",
                "interactive_questions": True,
            },
        )

        self.assertEqual(status, 201)
        self.assertEqual(payload["runtime"], "expo")
        self.assertTrue(self.start_event.wait(timeout=1))
        self.assertEqual(self.started, [payload["run_id"]])
        self.assertIn("harmony_pilot_visitor=", headers["Set-Cookie"])

        record = remote_ui_app.load_run(payload["run_id"])
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.runtime, "expo")
        self.assertEqual(record.variant, "expo-fast")
        self.assertFalse(record.interactive_questions)
        self.assertEqual(list(Path(record.workspace).iterdir()), [])
        self.assertEqual(Path(record.prompt_file).read_text(encoding="utf-8"), f"{prompt}\n")
        self.assertEqual(
            remote_ui_app.build_expo_fast_command(record),
            [
                str(remote_ui_app.EXPO_FAST_LAUNCHER),
                "--project",
                record.workspace,
                "--prompt-file",
                record.prompt_file,
                "--session",
                record.session_name,
                "--hap",
                "true",
                "--launch",
                "false",
            ],
        )
        self.assertEqual(
            remote_ui_app.build_expo_fast_command(record, action="rebuild")[-1],
            "--rebuild",
        )
        self.assertEqual(
            remote_ui_app.build_expo_fast_command(record, action="preview")[-3:],
            ["--launch", "true", "--preview-only"],
        )

    def test_expo_process_env_uses_the_leased_profile_bundle(self) -> None:
        now = remote_ui_app.to_iso()
        record = remote_ui_app.RunRecord(
            run_id="b" * 32,
            session_name="expo-fast-signed",
            prompt="签名 bundle 测试",
            workspace=str(remote_ui_app.EXPO_FAST_APP_ROOT / "signed"),
            variant="expo-fast",
            created_at=now,
            updated_at=now,
            runtime="expo",
            signing_bundle_name="com.example.profile.slot06",
        )

        env = remote_ui_app.build_expo_fast_env(record)

        self.assertEqual(env["EXPO_FAST_BUNDLE_IDENTIFIER"], "com.example.profile.slot06")

    def test_expo_follow_up_calls_runner_owned_controller(self) -> None:
        controller = remote_ui_app.EXPO_FAST_ROOT / "follow-up-control.sh"
        controller.write_text(
            "#!/bin/sh\n"
            "printf '%s\\n' '{\"ok\":true,\"follow_up\":{\"runtime\":\"expo\",\"status\":\"idle\",\"queue_length\":0,\"queue\":[],\"history\":[]}}'\n",
            encoding="utf-8",
        )
        controller.chmod(0o755)
        now = remote_ui_app.to_iso()
        record = remote_ui_app.RunRecord(
            run_id="c" * 32,
            session_name="expo-follow-up",
            prompt="续跑控制测试",
            workspace=str(remote_ui_app.EXPO_FAST_APP_ROOT / "follow-up"),
            variant="expo-fast",
            created_at=now,
            updated_at=now,
            runtime="expo",
        )

        response = remote_ui_app.call_follow_up_control(record, "status")

        self.assertTrue(response["ok"])
        self.assertEqual(response["follow_up"]["runtime"], "expo")
        self.assertEqual(remote_ui_app.follow_up_cli_path(record), controller)

    def test_expo_follow_up_status_does_not_invoke_controller_before_session(self) -> None:
        now = remote_ui_app.to_iso()
        workspace = remote_ui_app.EXPO_FAST_APP_ROOT / "pending"
        record = remote_ui_app.RunRecord(
            run_id="d" * 32,
            session_name="expo-pending",
            prompt="首轮轮询测试",
            workspace=str(workspace),
            variant="expo-fast",
            created_at=now,
            updated_at=now,
            runtime="expo",
        )

        with patch.object(remote_ui_app, "call_follow_up_control") as control:
            follow_up = remote_ui_app.load_follow_up_status(record, None)

        control.assert_not_called()
        self.assertEqual(follow_up["status"], "unavailable")
        self.assertFalse((workspace / ".expo-fast").exists())

    def test_failed_preview_can_resume_without_regenerating_project(self) -> None:
        status, headers, payload = self.request(
            "POST",
            "/api/runs",
            body={"prompt": "预览重试测试", "runtime": "expo"},
        )
        self.assertEqual(status, 201)
        self.assertTrue(self.start_event.wait(timeout=1))
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        run_id = payload["run_id"]
        record = remote_ui_app.load_run(run_id)
        self.assertIsNotNone(record)
        assert record is not None
        workspace = Path(record.workspace)
        state_dir = workspace / ".expo-fast"
        state_dir.mkdir(parents=True, exist_ok=True)
        (state_dir / "manifest.json").write_text("{}", encoding="utf-8")
        write_harmony_go_export(workspace)
        record.status = "failed"
        record.process_pid = None
        remote_ui_app.save_run(record)
        self.start_event.clear()

        status, _, retry_payload = self.request(
            "POST",
            f"/api/runs/{run_id}/preview/retry",
            body={},
            cookie=cookie,
        )

        self.assertEqual(status, 202)
        self.assertTrue(retry_payload["accepted"])
        self.assertEqual(retry_payload["status"], "preview_queued")
        self.assertTrue(self.start_event.wait(timeout=1))
        self.assertEqual(self.resumed, [run_id])
        self.assertEqual(self.actions[-1], "preview")

    def test_completed_state_maps_to_unsigned_hap_and_launch_preview(self) -> None:
        workspace = remote_ui_app.EXPO_FAST_APP_ROOT / "completed-app"
        state_dir = workspace / ".expo-fast"
        state_dir.mkdir(parents=True)
        (state_dir / "launch-screenshot.jpeg").write_bytes(b"jpeg")
        state = {
            "state": "completed",
            "label": "Completed",
            "status": "completed",
            "detail": "done",
            "detailLabel": "Done",
            "updatedAt": "2026-08-11T00:04:00.000Z",
            "history": [
                {
                    "state": "generating_code",
                    "label": "Generating Code",
                    "detail": "preparing",
                    "detailLabel": "Preparing",
                    "at": "2026-08-11T00:00:00.000Z",
                },
                {
                    "state": "generating_code",
                    "label": "Generating Code",
                    "detail": "model_generation",
                    "detailLabel": "Model Generation",
                    "at": "2026-08-11T00:01:00.000Z",
                },
                {
                    "state": "repairing",
                    "label": "Repairing",
                    "detail": "verification",
                    "detailLabel": "Verification",
                    "at": "2026-08-11T00:02:00.000Z",
                },
                {
                    "state": "generating_code",
                    "label": "Generating Code",
                    "detail": "launching",
                    "detailLabel": "Launching",
                    "at": "2026-08-11T00:03:00.000Z",
                },
                {
                    "state": "completed",
                    "label": "Completed",
                    "detail": "done",
                    "detailLabel": "Done",
                    "at": "2026-08-11T00:04:00.000Z",
                },
            ],
        }
        (state_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")
        hap_root = state_dir / "hap"
        hap_root.mkdir()
        hap_path = hap_root / "completed-app.hap"
        hap_path.write_bytes(b"unsigned-hap")
        (hap_root / "build-result.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "status": "success",
                    "jobId": "hap-completed-app",
                    "slotId": "slot-01",
                    "productRoot": str(workspace),
                    "durationMs": 23000,
                    "hapPath": str(hap_path),
                    "hapSha256": "test-sha",
                    "bundleName": "com.example.completed",
                    "completedAt": "2026-08-11T00:04:00.000Z",
                }
            ),
            encoding="utf-8",
        )
        now = remote_ui_app.to_iso()
        record = remote_ui_app.RunRecord(
            run_id="e6f6a000000000000000000000000006",
            session_name="expo-fast-completed",
            prompt="完成态测试",
            workspace=str(workspace),
            variant="expo-fast",
            created_at=now,
            updated_at=now,
            runtime="expo",
            status="completed",
        )
        remote_ui_app.save_run(record)

        with (
            patch.object(remote_ui_app, "start_hpack_packaging") as start_packaging,
            patch.object(
                remote_ui_app,
                "load_follow_up_status",
                return_value={"status": "idle", "session_id": "session-1"},
            ),
        ):
            payload = remote_ui_app.build_progress_payload(record)

        start_packaging.assert_called_once()
        self.assertEqual(start_packaging.call_args.args[0].run_id, record.run_id)

        self.assertEqual(payload["runtime"], "expo")
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(payload["stage"], "done")
        self.assertEqual(payload["expo"]["package"]["status"], "ready")
        self.assertEqual(payload["expo"]["package"]["slot_id"], "slot-01")
        self.assertEqual(payload["artifacts"]["distribution_status"], "ready_to_package")
        self.assertTrue(payload["artifacts"]["package_can_start"])
        self.assertTrue(payload["artifacts"]["hap_found"])
        self.assertEqual(payload["artifacts"]["hap_path"], str(hap_path.resolve()))
        self.assertEqual(
            payload["artifacts"]["hap_download_path"],
            "/api/runs/e6f6a000000000000000000000000006/hap",
        )
        self.assertEqual(
            payload["artifacts"]["hap_qr_path"],
            "/api/runs/e6f6a000000000000000000000000006/hap-qr",
        )
        self.assertTrue(payload["artifacts"]["media_ready"])
        self.assertEqual(
            payload["artifacts"]["media_path"],
            "/api/runs/e6f6a000000000000000000000000006/media",
        )
        self.assertEqual(payload["ui"]["waiting_message"], "Expo 生成流程已完成。")
        self.assertEqual(payload["events"][-1]["summary"], "unsigned HAP 构建完成，可以下载。")

        saved = remote_ui_app.load_run(record.run_id)
        self.assertIsNotNone(saved)
        assert saved is not None
        self.assertEqual(saved.expo_package_status, "ready")
        self.assertIn("unsigned HAP 已生成", saved.notes)

    def test_icon_generation_state_has_specific_waiting_message(self) -> None:
        workspace = remote_ui_app.EXPO_FAST_APP_ROOT / "icon-generation-app"
        state_dir = workspace / ".expo-fast"
        state_dir.mkdir(parents=True)
        (state_dir / "state.json").write_text(
            json.dumps(
                {
                    "state": "generating_code",
                    "label": "生成代码",
                    "status": "running",
                    "detail": "app_icon_generation",
                    "detailLabel": "生成应用图标",
                }
            ),
            encoding="utf-8",
        )
        now = remote_ui_app.to_iso()
        record = remote_ui_app.RunRecord(
            run_id="e6f6a000000000000000000000000008",
            session_name="expo-fast-icon-generation",
            prompt="图标状态测试",
            workspace=str(workspace),
            variant="expo-fast",
            created_at=now,
            updated_at=now,
            runtime="expo",
            status="running",
        )
        remote_ui_app.save_run(record)

        payload = remote_ui_app.build_progress_payload(record)

        self.assertEqual(payload["status"], "running")
        self.assertEqual(payload["stage"], "app_icon_generation")
        self.assertEqual(payload["ui"]["waiting_message"], "正在根据应用 Brief 生成图标…")

    def test_hap_keeps_package_flow_available_when_preview_media_is_missing(self) -> None:
        workspace = remote_ui_app.EXPO_FAST_APP_ROOT / "hap-without-preview"
        state_dir = workspace / ".expo-fast"
        state_dir.mkdir(parents=True)
        (state_dir / "state.json").write_text(
            json.dumps({"state": "completed", "status": "completed", "detail": "preview_failed"}),
            encoding="utf-8",
        )
        hap_root = state_dir / "hap"
        hap_root.mkdir()
        hap_path = hap_root / "app.hap"
        hap_path.write_bytes(b"unsigned-hap")
        (hap_root / "build-result.json").write_text(
            json.dumps({"status": "success", "hapPath": str(hap_path), "bundleName": "com.example.app"}),
            encoding="utf-8",
        )
        record = remote_ui_app.RunRecord(
            run_id="e6f6a000000000000000000000000007",
            session_name="expo-fast-no-preview",
            prompt="HAP without preview",
            workspace=str(workspace),
            variant="expo-fast",
            created_at=remote_ui_app.to_iso(),
            updated_at=remote_ui_app.to_iso(),
            runtime="expo",
            status="completed",
        )
        remote_ui_app.save_run(record)
        with (
            patch.object(remote_ui_app, "start_hpack_packaging"),
            patch.object(
                remote_ui_app,
                "load_follow_up_status",
                return_value={"status": "idle", "session_id": "session-1"},
            ),
        ):
            payload = remote_ui_app.build_progress_payload(record)

        self.assertTrue(payload["artifacts"]["hap_found"])
        self.assertTrue(payload["artifacts"]["package_can_start"])
        self.assertEqual(payload["artifacts"]["distribution_status"], "ready_to_package")

    def test_expo_package_requires_completed_run_and_idle_follow_up(self) -> None:
        now = remote_ui_app.to_iso()
        record = remote_ui_app.RunRecord(
            run_id="e6f6a000000000000000000000000016",
            session_name="expo-package-operation-gate",
            prompt="打包互斥测试",
            workspace=str(remote_ui_app.EXPO_FAST_APP_ROOT / "package-operation-gate"),
            variant="expo-fast",
            created_at=now,
            updated_at=now,
            runtime="expo",
            status="completed",
        )

        self.assertTrue(
            remote_ui_app.expo_package_operation_ready(
                record,
                "completed",
                {"status": "idle"},
            )
        )
        self.assertFalse(
            remote_ui_app.expo_package_operation_ready(
                record,
                "completed",
                {"status": "running"},
            )
        )
        self.assertFalse(
            remote_ui_app.expo_package_operation_ready(
                record,
                "running",
                {"status": "idle"},
            )
        )
        record.status = "running"
        # The runtime state passed as ``completed`` is authoritative after a
        # launcher restart; a stale persisted status must not block packaging.
        self.assertTrue(
            remote_ui_app.expo_package_operation_ready(
                record,
                "completed",
                {"status": "idle"},
            )
        )

    def test_expo_hpack_start_rechecks_follow_up_state_under_operation_lock(self) -> None:
        workspace = remote_ui_app.EXPO_FAST_APP_ROOT / "hpack-follow-up-busy"
        state_dir = workspace / ".expo-fast"
        hap_dir = state_dir / "hap"
        hap_dir.mkdir(parents=True)
        (hap_dir / "busy.hap").write_bytes(b"unsigned-hap")
        (state_dir / "state.json").write_text(
            json.dumps({"state": "completed", "detail": "done"}),
            encoding="utf-8",
        )
        now = remote_ui_app.to_iso()
        record = remote_ui_app.RunRecord(
            run_id="e6f6a000000000000000000000000017",
            session_name="expo-hpack-follow-up-busy",
            prompt="签名互斥测试",
            workspace=str(workspace),
            variant="expo-fast",
            created_at=now,
            updated_at=now,
            runtime="expo",
            status="completed",
        )
        remote_ui_app.save_run(record)

        with (
            patch.object(remote_ui_app, "HPACK_ENABLED", True),
            patch.object(remote_ui_app, "load_follow_up_status", return_value={"status": "running"}),
            patch.object(remote_ui_app.threading, "Thread") as worker,
        ):
            started = remote_ui_app.start_hpack_packaging(record)

        self.assertFalse(started)
        worker.assert_not_called()

    def test_expo_hap_download_rejects_artifacts_outside_the_run_output(self) -> None:
        workspace = remote_ui_app.EXPO_FAST_APP_ROOT / "escaped-hap-app"
        hap_root = workspace / ".expo-fast" / "hap"
        hap_root.mkdir(parents=True)
        outside_hap = Path(self.temp_dir.name) / "outside.hap"
        outside_hap.write_bytes(b"not-run-owned")
        result = {
            "status": "success",
            "productRoot": str(workspace),
            "hapPath": str(outside_hap),
        }
        (hap_root / "build-result.json").write_text(json.dumps(result), encoding="utf-8")

        self.assertIsNone(remote_ui_app.resolve_expo_hap_artifact(workspace, result))
        state = {
            "state": "completed",
            "status": "passed",
            "detail": "done",
            "context": {"hap": {"status": "ready"}},
        }
        (workspace / ".expo-fast" / "state.json").write_text(json.dumps(state), encoding="utf-8")
        now = remote_ui_app.to_iso()
        record = remote_ui_app.RunRecord(
            run_id="e6f6a000000000000000000000000007",
            session_name="expo-fast-escaped-hap",
            prompt="越界 HAP 测试",
            workspace=str(workspace),
            variant="expo-fast",
            created_at=now,
            updated_at=now,
            runtime="expo",
            status="completed",
        )
        remote_ui_app.save_run(record)

        payload = remote_ui_app.build_progress_payload(record)
        self.assertEqual(payload["expo"]["package"]["status"], "failed")
        self.assertEqual(payload["expo"]["package"]["error"], "unsigned HAP 产物缺失或路径无效。")
        self.assertFalse(payload["artifacts"]["hap_found"])

    def test_claude_trace_is_incremental_grouped_and_redacted(self) -> None:
        workspace = remote_ui_app.EXPO_FAST_APP_ROOT / "trace-app"
        trace_dir = workspace / ".expo-fast"
        trace_dir.mkdir(parents=True)
        state = {
            "state": "generating_code",
            "detail": "model_generation",
            "startedAt": "2026-08-11T00:00:00.000Z",
        }
        trace_path = trace_dir / "agent-trace.jsonl"
        init_row = {
            "type": "system",
            "subtype": "init",
            "session_id": "claude-session-1",
            "model": "k3-256k",
        }
        assistant_row = {
            "type": "assistant",
            "timestamp": "2026-08-11T00:01:00.000Z",
            "message": {
                "content": [
                    {"type": "thinking", "thinking": "PRIVATE THINKING MUST NOT LEAK"},
                    {
                        "type": "tool_use",
                        "id": "tool-1",
                        "name": "Write",
                        "input": {
                            "file_path": str(workspace / "src/App.tsx"),
                            "content": "SECRET FILE CONTENT MUST NOT LEAK",
                        },
                    },
                    {"type": "text", "text": "  已完成首页和本地存储。  "},
                ]
            },
        }
        assistant_json = json.dumps(assistant_row, ensure_ascii=False)
        midpoint = len(assistant_json) // 2
        trace_path.write_text(
            json.dumps(init_row) + "\n" + assistant_json[:midpoint],
            encoding="utf-8",
        )

        first_groups = remote_ui_app.load_expo_claude_trace_groups(workspace, state)
        self.assertEqual(len(first_groups), 1)
        self.assertEqual(first_groups[0]["status"], "running")
        self.assertEqual(first_groups[0]["event_count"], 1)
        self.assertEqual(first_groups[0]["events"][0]["kind"], "session")

        with trace_path.open("a", encoding="utf-8") as stream:
            stream.write(assistant_json[midpoint:] + "\n")

        running_groups = remote_ui_app.load_expo_claude_trace_groups(workspace, state)
        generation = running_groups[0]
        self.assertEqual(generation["label"], "代码生成")
        self.assertEqual(generation["action_count"], 1)
        self.assertEqual(generation["message_count"], 1)
        self.assertEqual(generation["event_count"], 3)
        action = next(event for event in generation["events"] if event["kind"] == "action")
        self.assertEqual(action["summary"], "写入 · src/App.tsx")
        self.assertEqual(action["target"], "src/App.tsx")
        serialized = json.dumps(running_groups, ensure_ascii=False)
        self.assertNotIn("SECRET FILE CONTENT", serialized)
        self.assertNotIn("PRIVATE THINKING", serialized)

        unchanged = remote_ui_app.load_expo_claude_trace_groups(workspace, state)
        self.assertEqual(unchanged[0]["event_count"], 3)
        self.assertEqual(unchanged[0]["events"], generation["events"])

        result_row = {
            "type": "result",
            "subtype": "success",
            "num_turns": 4,
            "duration_ms": 12_400,
            "is_error": False,
        }
        with trace_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(result_row) + "\n")

        completed = remote_ui_app.load_expo_claude_trace_groups(workspace, state)[0]
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["event_count"], 4)
        self.assertEqual(completed["events"][-1]["summary"], "Genius 会话完成 · 4 轮 · 12 秒")

        # A retry may append another failed result before the final successful
        # result in the same trace. The detail timeline should show only the
        # final outcome.
        retry_rows = [
            {"type": "result", "subtype": "error", "num_turns": 0, "duration_ms": 0, "is_error": True},
            {"type": "result", "subtype": "success", "num_turns": 5, "duration_ms": 2_000, "is_error": False},
        ]
        with trace_path.open("a", encoding="utf-8") as stream:
            stream.write("".join(json.dumps(row) + "\n" for row in retry_rows))
        recovered = remote_ui_app.load_expo_claude_trace_groups(workspace, state)[0]
        result_events = [event for event in recovered["events"] if event["kind"] == "result"]
        self.assertEqual(len(result_events), 1)
        self.assertEqual(result_events[0]["status"], "completed")

        repair_path = trace_dir / "agent-repair-trace.jsonl"
        repair_rows = [
            {
                "type": "system",
                "subtype": "init",
                "session_id": "claude-session-1",
                "model": "k3-256k",
            },
            {
                "type": "assistant",
                "timestamp": "2026-08-11T00:02:00.000Z",
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "tool-2",
                            "name": "Edit",
                            "input": {"file_path": str(workspace / "src/store.tsx")},
                        },
                        {"type": "text", "text": "已修复验证阶段发现的类型问题。"},
                    ]
                },
            },
            {"type": "result", "subtype": "success", "num_turns": 2, "duration_ms": 3_000},
        ]
        repair_path.write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in repair_rows),
            encoding="utf-8",
        )

        grouped = remote_ui_app.load_expo_claude_trace_groups(
            workspace,
            {**state, "state": "repairing", "detail": "model_repair"},
        )
        self.assertEqual([group["id"] for group in grouped], ["generation", "repair-1"])
        self.assertEqual(grouped[1]["label"], "自动修复 #1")
        self.assertEqual(grouped[1]["action_count"], 1)
        self.assertEqual(grouped[1]["message_count"], 1)

        revision_dir = trace_dir / "revisions" / "001-follow-up"
        revision_dir.mkdir(parents=True)
        follow_up_path = revision_dir / "agent-trace.jsonl"
        follow_up_path.write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in repair_rows),
            encoding="utf-8",
        )
        follow_up_repair_path = revision_dir / "agent-repair-trace.jsonl"
        follow_up_repair_path.write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in repair_rows),
            encoding="utf-8",
        )
        revised = remote_ui_app.load_expo_claude_trace_groups(workspace, state)
        self.assertEqual(
            [group["id"] for group in revised],
            ["generation", "repair-1", "follow-up-1", "follow-up-1-repair-1"],
        )
        self.assertEqual(revised[2]["trace_file"], "revisions/001-follow-up/agent-trace.jsonl")
        self.assertEqual(revised[2]["label"], "续跑调整 #1")

    def test_expo_package_endpoint_rejects_before_hap_is_ready(self) -> None:
        status, headers, payload = self.request(
            "POST",
            "/api/runs",
            body={"prompt": "打包占位测试", "runtime": "expo"},
        )
        self.assertEqual(status, 201)
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        self.assertTrue(self.start_event.wait(timeout=1))

        status, _, package_payload = self.request(
            "POST",
            f"/api/runs/{payload['run_id']}/package",
            body={},
            cookie=cookie,
        )

        self.assertEqual(status, 409)
        self.assertEqual(package_payload["code"], "package_not_ready")

    def test_expo_follow_up_enqueue_rejects_rebuild_and_packaging_operations(self) -> None:
        status, headers, payload = self.request(
            "POST",
            "/api/runs",
            body={"prompt": "续跑互斥测试", "runtime": "expo"},
        )
        self.assertEqual(status, 201)
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        run_id = payload["run_id"]
        self.assertTrue(self.start_event.wait(timeout=1))
        record = remote_ui_app.load_run(run_id)
        self.assertIsNotNone(record)
        assert record is not None
        record.status = "running"
        record.process_pid = None
        remote_ui_app.save_run(record)

        with patch.object(remote_ui_app, "call_follow_up_control") as control:
            status, _, busy = self.request(
                "POST",
                f"/api/runs/{run_id}/follow-up/messages",
                body={"text": "改成绿色", "clientMessageId": "busy-rebuild"},
                cookie=cookie,
            )
        self.assertEqual(status, 409)
        self.assertEqual(busy["code"], "control_busy")
        control.assert_not_called()

        record = remote_ui_app.load_run(run_id)
        self.assertIsNotNone(record)
        assert record is not None
        record.status = "completed"
        record.process_pid = None
        remote_ui_app.save_run(record)
        remote_ui_app.HPACK_PACKAGE_IN_FLIGHT.add(run_id)
        try:
            with patch.object(remote_ui_app, "call_follow_up_control") as control:
                status, _, busy = self.request(
                    "POST",
                    f"/api/runs/{run_id}/follow-up/messages",
                    body={"text": "改成蓝色", "clientMessageId": "busy-package"},
                    cookie=cookie,
                )
            self.assertEqual(status, 409)
            self.assertEqual(busy["code"], "control_busy")
            control.assert_not_called()
        finally:
            remote_ui_app.HPACK_PACKAGE_IN_FLIGHT.discard(run_id)

    def test_completed_expo_run_can_publish_and_revoke_gateway_preview(self) -> None:
        status, headers, payload = self.request(
            "POST",
            "/api/runs",
            body={"prompt": "外网预览测试", "runtime": "expo"},
        )
        self.assertEqual(status, 201)
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        record = remote_ui_app.load_run(payload["run_id"])
        self.assertIsNotNone(record)
        assert record is not None

        status, _, not_ready = self.request(
            "POST",
            f"/api/runs/{record.run_id}/expo-serve",
            body={},
            cookie=cookie,
        )
        self.assertEqual(status, 409)
        self.assertEqual(not_ready["code"], "expo_run_not_ready")

        state_root = Path(record.workspace) / ".expo-fast"
        state_root.mkdir(parents=True)
        (state_root / "state.json").write_text(
            json.dumps({"state": "completed", "detail": "done", "updatedAt": "2026-08-11T00:00:00Z"}),
            encoding="utf-8",
        )
        write_harmony_go_export(Path(record.workspace))

        original_gateway = remote_ui_app.EXPO_PUBLIC_GATEWAY
        gateway = ExpoPublicGateway(
            enabled=True,
            host="127.0.0.1",
            port=0,
            public_origin="https://devkit.yorha2b.cc/",
            state_path=Path(self.temp_dir.name) / "expo-publications.json",
            allowed_root=remote_ui_app.EXPO_FAST_APP_ROOT,
        )
        self.assertTrue(gateway.start())
        remote_ui_app.EXPO_PUBLIC_GATEWAY = gateway
        try:
            status, _, automatic = self.request("GET", f"/api/runs/{record.run_id}", cookie=cookie)
            self.assertEqual(status, 200)
            self.assertEqual(automatic["expo"]["serve"]["status"], "serving")
            self.assertTrue(
                automatic["expo"]["serve"]["public_url"].startswith(
                    "https://devkit.yorha2b.cc/p/"
                )
            )

            status, _, published = self.request(
                "POST",
                f"/api/runs/{record.run_id}/expo-serve",
                body={},
                cookie=cookie,
            )
            self.assertEqual(status, 200)
            self.assertFalse(published["accepted"])
            self.assertEqual(published["serve"]["status"], "serving")
            self.assertTrue(published["serve"]["public_url"].startswith("https://devkit.yorha2b.cc/p/"))

            local = urlparse(published["serve"]["local_url"])
            connection = http.client.HTTPConnection(local.hostname, local.port)
            connection.request("GET", local.path + "/catalog.json")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read())[0]["id"], "sample-app")
            connection.close()

            status, _, progress = self.request("GET", f"/api/runs/{record.run_id}", cookie=cookie)
            self.assertEqual(status, 200)
            self.assertEqual(progress["expo"]["serve"]["status"], "serving")

            status, _, revoked = self.request(
                "DELETE",
                f"/api/runs/{record.run_id}/expo-serve",
                body={},
                cookie=cookie,
            )
            self.assertEqual(status, 200)
            self.assertTrue(revoked["accepted"])
            self.assertEqual(revoked["serve"]["status"], "stopped")
            self.assertTrue(revoked["serve"]["can_publish"])

            connection = http.client.HTTPConnection(local.hostname, local.port)
            connection.request("GET", local.path + "/catalog.json")
            response = connection.getresponse()
            self.assertEqual(response.status, 404)
            response.read()
            connection.close()
        finally:
            remote_ui_app.EXPO_PUBLIC_GATEWAY = original_gateway
            gateway.stop()


if __name__ == "__main__":
    unittest.main()
