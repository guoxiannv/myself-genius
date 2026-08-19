from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "app.py"
SPEC = importlib.util.spec_from_file_location("remote_ui_capture_status_app", MODULE_PATH)
remote_ui_app = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
sys.modules[SPEC.name] = remote_ui_app
SPEC.loader.exec_module(remote_ui_app)


class EffectiveCaptureStatusTests(unittest.TestCase):
    def test_preview_policy_separates_pro_and_expo_transports(self) -> None:
        base = dict(
            run_id="r" * 32,
            session_name="preview-policy",
            prompt="test",
            workspace="/tmp",
            variant="test",
            created_at=remote_ui_app.to_iso(),
            updated_at=remote_ui_app.to_iso(),
        )
        pro = remote_ui_app.RunRecord(**base)
        expo = remote_ui_app.RunRecord(**{**base, "run_id": "x" * 32, "runtime": "expo"})

        pro_policy = remote_ui_app.preview_policy(pro)
        expo_policy = remote_ui_app.preview_policy(expo)

        self.assertEqual(pro_policy["default_kind"], "phone")
        self.assertEqual(set(pro_policy["previews"]), {"phone"})
        self.assertEqual(pro_policy["previews"]["phone"]["start_mode"], "automatic")
        self.assertEqual(expo_policy["default_kind"], "desktop")
        self.assertEqual(expo_policy["previews"]["desktop"]["transport"], "hap_install")

    def test_phone_target_discovery_skips_a_timed_out_desktop_probe(self) -> None:
        def run_probe(command, **kwargs):
            if command[2] == "desktop-stuck":
                raise remote_ui_app.subprocess.TimeoutExpired(command, kwargs["timeout"])
            return remote_ui_app.subprocess.CompletedProcess(
                command,
                0,
                stdout="phone\n",
                stderr="",
            )

        with patch.object(
            remote_ui_app.LIVE_PREVIEW,
            "_resolve_hdc_bin",
            return_value="/fake/hdc",
        ), patch.object(
            remote_ui_app,
            "connected_hdc_targets",
            return_value=["desktop-stuck", "phone-ready"],
        ), patch.object(
            remote_ui_app,
            "configured_preview_target_pools",
            return_value={"desktop": [], "phone": []},
        ), patch.object(remote_ui_app.subprocess, "run", side_effect=run_probe) as runner:
            targets = remote_ui_app.discover_preview_targets("phone")

        self.assertEqual(targets, ["phone-ready"])
        self.assertEqual(runner.call_count, 2)
        self.assertTrue(all(
            call.kwargs["timeout"] == remote_ui_app.PREVIEW_DEVICE_PROBE_TIMEOUT_SEC
            for call in runner.call_args_list
        ))

    def test_start_phone_preview_is_idempotent_while_queued(self) -> None:
        record = remote_ui_app.RunRecord(
            run_id="i" * 32,
            session_name="preview-idempotent",
            prompt="test",
            workspace="/tmp",
            variant="test",
            created_at=remote_ui_app.to_iso(),
            updated_at=remote_ui_app.to_iso(),
            preview_sessions={"phone": {"status": "queued", "transport": "hap_install"}},
        )
        remote_ui_app.PHONE_PREVIEW_IN_FLIGHT.add(record.run_id)
        try:
            with patch.object(remote_ui_app, "preview_hap_artifact") as resolver:
                latest, accepted = remote_ui_app.start_phone_preview(record)
        finally:
            remote_ui_app.PHONE_PREVIEW_IN_FLIGHT.discard(record.run_id)
        resolver.assert_not_called()
        self.assertIs(latest, record)
        self.assertFalse(accepted)

    def test_expo_phone_preview_prefers_local_hap_over_distribution_hap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / "workspace"
            hap_dir = workspace / ".expo-fast" / "hap"
            hap_dir.mkdir(parents=True)
            local_hap = hap_dir / "local-preview.hap"
            local_hap.write_bytes(b"local-preview")
            (hap_dir / "build-result.json").write_text(
                json.dumps({"status": "success", "hapPath": str(local_hap)}),
                encoding="utf-8",
            )
            signed_hap = Path(directory) / "entry-default-signed.hap"
            signed_hap.write_bytes(b"internal-testing-distribution")
            record = remote_ui_app.RunRecord(
                run_id="u" * 32,
                session_name="preview-local-hap",
                prompt="test",
                workspace=str(workspace),
                variant="expo-fast",
                created_at=remote_ui_app.to_iso(),
                updated_at=remote_ui_app.to_iso(),
                runtime="expo",
            )

            with patch.object(
                remote_ui_app,
                "load_hpack_manifest",
                return_value={"signed_hap_path": str(signed_hap)},
            ):
                selected = remote_ui_app.preview_hap_artifact(record)

            self.assertEqual(selected, local_hap.resolve())

    def test_phone_preview_uses_signed_hap_only_without_local_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            signed_hap = Path(directory) / "entry-default-signed.hap"
            signed_hap.write_bytes(b"signed")
            record = remote_ui_app.RunRecord(
                run_id="f" * 32,
                session_name="preview-signed-fallback",
                prompt="test",
                workspace=str(Path(directory) / "missing-workspace"),
                variant="expo-fast",
                created_at=remote_ui_app.to_iso(),
                updated_at=remote_ui_app.to_iso(),
                runtime="expo",
            )

            with patch.object(
                remote_ui_app,
                "load_hpack_manifest",
                return_value={"signed_hap_path": str(signed_hap)},
            ):
                selected = remote_ui_app.preview_hap_artifact(record)

            self.assertEqual(selected, signed_hap.resolve())

    def test_start_desktop_preview_is_idempotent_while_installing(self) -> None:
        record = remote_ui_app.RunRecord(
            run_id="d" * 32,
            session_name="desktop-preview-idempotent",
            prompt="test",
            workspace="/tmp",
            variant="expo-fast",
            created_at=remote_ui_app.to_iso(),
            updated_at=remote_ui_app.to_iso(),
            runtime="expo",
            preview_sessions={"desktop": {"status": "installing", "transport": "hap_install"}},
        )
        remote_ui_app.DESKTOP_PREVIEW_IN_FLIGHT.add(record.run_id)
        try:
            with patch.object(remote_ui_app, "preview_hap_artifact") as resolver:
                latest, accepted = remote_ui_app.start_desktop_preview(record)
        finally:
            remote_ui_app.DESKTOP_PREVIEW_IN_FLIGHT.discard(record.run_id)
        resolver.assert_not_called()
        self.assertIs(latest, record)
        self.assertFalse(accepted)

    def test_stalled_desktop_queue_is_restarted_when_worker_is_gone(self) -> None:
        record = remote_ui_app.RunRecord(
            run_id="s" * 32,
            session_name="desktop-preview-stalled-queue",
            prompt="test",
            workspace="/tmp/project",
            variant="expo-fast",
            created_at=remote_ui_app.to_iso(),
            updated_at=remote_ui_app.to_iso(),
            runtime="expo",
            preview_sessions={"desktop": {"status": "queued", "transport": "hap_install"}},
        )
        with tempfile.NamedTemporaryFile(suffix=".hap") as hap, patch.object(
            remote_ui_app, "preview_hap_artifact", return_value=Path(hap.name)
        ), patch.object(
            remote_ui_app, "save_run", side_effect=lambda value: value
        ), patch.object(remote_ui_app, "update_preview_session", side_effect=lambda value, _kind, **changes: value), patch.object(
            remote_ui_app.threading, "Thread"
        ) as thread:
            latest, accepted = remote_ui_app.start_desktop_preview(record)

        self.assertIs(latest, record)
        self.assertTrue(accepted)
        thread.assert_called_once()

    def test_viewer_state_releases_hidden_idle_and_long_sessions(self) -> None:
        run_id = "v" * 32
        kind = "desktop"
        key = remote_ui_app.preview_viewer_key(run_id, kind)
        try:
            with patch.object(remote_ui_app, "PREVIEW_HIDDEN_GRACE_SECONDS", 30), patch.object(
                remote_ui_app, "PREVIEW_IDLE_SECONDS", 90
            ), patch.object(remote_ui_app, "PREVIEW_MAX_SESSION_SECONDS", 600):
                remote_ui_app.PREVIEW_VIEWERS[key] = {
                    "lease_started_at": 100,
                    "last_seen_at": 190,
                    "hidden_since": 200,
                }
                self.assertEqual(
                    remote_ui_app.preview_viewer_release_reason(run_id, kind, now=231),
                    "hidden",
                )
                remote_ui_app.PREVIEW_VIEWERS[key] = {
                    "lease_started_at": 100,
                    "last_seen_at": 200,
                    "hidden_since": 0,
                }
                self.assertEqual(
                    remote_ui_app.preview_viewer_release_reason(run_id, kind, now=291),
                    "viewer_timeout",
                )
                remote_ui_app.PREVIEW_VIEWERS[key] = {
                    "lease_started_at": 100,
                    "last_seen_at": 699,
                    "hidden_since": 0,
                }
                self.assertEqual(
                    remote_ui_app.preview_viewer_release_reason(run_id, kind, now=700),
                    "max_session",
                )
        finally:
            remote_ui_app.clear_preview_viewer(run_id, kind)

    def test_new_owner_preview_preempts_the_same_owners_old_session(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory)
            base = dict(
                session_name="owner-preview",
                prompt="test",
                workspace=directory,
                variant="expo-fast",
                created_at=remote_ui_app.to_iso(),
                updated_at=remote_ui_app.to_iso(),
                runtime="expo",
                owner_id="same-owner",
            )
            old = remote_ui_app.RunRecord(
                **base,
                run_id="o" * 32,
                preview_sessions={
                    "desktop": {
                        "status": "ready",
                        "target": "desktop-1",
                        "lease_id": "old-lease",
                        "live_available": True,
                    }
                },
            )
            current = remote_ui_app.RunRecord(**base, run_id="n" * 32)
            with patch.object(remote_ui_app, "RUNS_DIR", runs_dir):
                remote_ui_app.save_run(old)
                remote_ui_app.save_run(current)
                with patch.object(
                    remote_ui_app,
                    "preview_sessions_payload",
                    side_effect=lambda value: value.preview_sessions,
                ), patch.object(
                    remote_ui_app,
                    "release_preview_lease",
                    side_effect=lambda value, _kind: value,
                ) as release:
                    released = remote_ui_app.preempt_owner_preview_leases(current, "desktop")

            self.assertEqual(released, [old.run_id])
            release.assert_called_once_with(old, "desktop")

    def test_ready_desktop_session_without_live_lease_is_released(self) -> None:
        record = remote_ui_app.RunRecord(
            run_id="l" * 32,
            session_name="desktop-preview-lease",
            prompt="test",
            workspace="/tmp",
            variant="expo-fast",
            created_at=remote_ui_app.to_iso(),
            updated_at=remote_ui_app.to_iso(),
            runtime="expo",
            preview_sessions={
                "desktop": {
                    "status": "ready",
                    "transport": "hap_install",
                    "target": "desktop-1",
                    "lease_id": "expired",
                    "live_available": True,
                }
            },
        )

        with patch.object(remote_ui_app, "read_json", return_value=None):
            session = remote_ui_app.preview_sessions_payload(record)["desktop"]

        self.assertEqual(session["status"], "released")
        self.assertFalse(session["live_available"])

    def test_existing_desktop_session_adopts_hap_transport(self) -> None:
        record = remote_ui_app.RunRecord(
            run_id="m" * 32,
            session_name="desktop-preview-migration",
            prompt="test",
            workspace="/tmp",
            variant="expo-fast",
            created_at=remote_ui_app.to_iso(),
            updated_at=remote_ui_app.to_iso(),
            runtime="expo",
            preview_sessions={"desktop": {"status": "idle", "transport": "bundle_shell"}},
        )

        session = remote_ui_app.preview_sessions_payload(record)["desktop"]

        self.assertEqual(session["transport"], "hap_install")

    def test_stale_allocating_session_without_worker_or_lease_is_released(self) -> None:
        record = remote_ui_app.RunRecord(
            run_id="z" * 32,
            session_name="desktop-preview-stale-worker",
            prompt="test",
            workspace="/tmp",
            variant="expo-fast",
            created_at=remote_ui_app.to_iso(),
            updated_at=remote_ui_app.to_iso(),
            runtime="expo",
            preview_sessions={
                "desktop": {
                    "status": "allocating",
                    "transport": "hap_install",
                    "target": "",
                    "lease_id": "",
                }
            },
        )

        session = remote_ui_app.preview_sessions_payload(record)["desktop"]

        self.assertEqual(session["status"], "released")

    def test_expo_payload_exposes_desktop_and_phone_previews_from_one_build(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            state_dir = workspace / ".expo-fast"
            state_dir.mkdir()
            (state_dir / "state.json").write_text(
                json.dumps({"state": "completed", "detail": "done"}),
                encoding="utf-8",
            )
            (state_dir / "launch-screenshot-desktop.jpeg").write_bytes(b"desktop")
            (state_dir / "launch-screenshot-phone.jpeg").write_bytes(b"phone")
            record = remote_ui_app.RunRecord(
                run_id="e" * 32,
                session_name="expo-preview",
                prompt="test",
                workspace=str(workspace),
                variant="expo-fast",
                created_at=remote_ui_app.to_iso(),
                updated_at=remote_ui_app.to_iso(),
                runtime="expo",
                expo_package_status="not_implemented",
                preview_targets={"desktop": "desktop-target", "phone": "phone-target"},
            )

            with patch.object(remote_ui_app, "start_desktop_preview") as starter:
                payload = remote_ui_app.build_expo_progress_payload(record)

            previews = payload["artifacts"]["previews"]
            self.assertEqual(set(previews), {"desktop", "phone"})
            self.assertEqual(previews["desktop"]["target"], "desktop-target")
            self.assertTrue(previews["desktop"]["media_ready"])
            self.assertFalse(previews["desktop"]["live_ready"])
            self.assertEqual(previews["phone"]["status"], "idle")
            self.assertFalse(previews["phone"]["live_ready"])
            self.assertEqual(payload["preview_policy"]["default_kind"], "desktop")
            self.assertEqual(payload["preview_policy"]["previews"]["phone"]["transport"], "hap_install")
            self.assertEqual(payload["preview_policy"]["previews"]["phone"]["start_mode"], "on_demand")
            starter.assert_not_called()

    def test_pro_policy_defaults_to_automatic_phone_hap_preview(self) -> None:
        record = remote_ui_app.RunRecord(
            run_id="q" * 32,
            session_name="pro-preview",
            prompt="test",
            workspace="/tmp",
            variant="test",
            created_at=remote_ui_app.to_iso(),
            updated_at=remote_ui_app.to_iso(),
        )

        policy = remote_ui_app.preview_policy(record)

        self.assertEqual(policy["default_kind"], "phone")
        self.assertEqual(policy["previews"]["phone"]["transport"], "hap_install")
        self.assertEqual(policy["previews"]["phone"]["start_mode"], "automatic")
        self.assertNotIn("desktop", policy["previews"])

    def test_preview_session_state_is_persisted_per_kind(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory)
            record = remote_ui_app.RunRecord(
                run_id="r" * 32,
                session_name="expo-preview",
                prompt="test",
                workspace=directory,
                variant="test",
                created_at=remote_ui_app.to_iso(),
                updated_at=remote_ui_app.to_iso(),
                runtime="expo",
            )
            with patch.object(remote_ui_app, "RUNS_DIR", runs_dir):
                remote_ui_app.update_preview_session(
                    record,
                    "phone",
                    status="installing",
                    target="phone-1",
                )
                loaded = remote_ui_app.load_run(record.run_id)

            self.assertEqual(loaded.preview_sessions["phone"]["status"], "installing")
            self.assertEqual(loaded.preview_sessions["phone"]["target"], "phone-1")
            self.assertEqual(loaded.preview_targets["phone"], "phone-1")

    def test_json_writes_replace_atomically_without_trailing_content(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text('{"value":"' + ("x" * 1000) + '"}', encoding="utf-8")

            remote_ui_app.write_json(path, {"value": "short"})

            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"value": "short"})
            self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_current_manifest_is_the_shared_source_of_live_availability(self) -> None:
        record = remote_ui_app.RunRecord(
            run_id="m" * 32,
            session_name="capture-status",
            prompt="test",
            workspace="/tmp",
            variant="test",
            created_at=remote_ui_app.to_iso(),
            updated_at=remote_ui_app.to_iso(),
            capture_status="running",
            capture_hap_mtime=10,
        )
        manifest = {"status": "complete"}

        with patch.object(remote_ui_app, "file_mtime", return_value=11):
            status = remote_ui_app.effective_capture_status(record, manifest)

        self.assertEqual(status, "complete")

    def test_stale_manifest_does_not_override_the_record(self) -> None:
        record = remote_ui_app.RunRecord(
            run_id="n" * 32,
            session_name="capture-status",
            prompt="test",
            workspace="/tmp",
            variant="test",
            created_at=remote_ui_app.to_iso(),
            updated_at=remote_ui_app.to_iso(),
            capture_status="complete",
            capture_hap_mtime=20,
        )

        with patch.object(remote_ui_app, "file_mtime", return_value=19):
            status = remote_ui_app.effective_capture_status(record, {"status": "failed"})

        self.assertEqual(status, "complete")

    def test_legacy_null_hap_mtime_is_treated_as_zero(self) -> None:
        record = remote_ui_app.RunRecord(
            run_id="p" * 32,
            session_name="capture-status",
            prompt="test",
            workspace="/tmp",
            variant="test",
            created_at=remote_ui_app.to_iso(),
            updated_at=remote_ui_app.to_iso(),
            capture_status="running",
        )
        record.capture_hap_mtime = None

        with patch.object(remote_ui_app, "file_mtime", return_value=1):
            status = remote_ui_app.effective_capture_status(record, {"status": "complete"})

        self.assertEqual(status, "complete")


if __name__ == "__main__":
    unittest.main()
