import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[2] / "app.py"
SPEC = importlib.util.spec_from_file_location("remote_ui_manual_package_app", MODULE_PATH)
remote_ui_app = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
sys.modules[SPEC.name] = remote_ui_app
SPEC.loader.exec_module(remote_ui_app)


class ManualPackageStateTests(unittest.TestCase):
    def test_enqueue_then_remove_rolls_back_to_previous_revision(self) -> None:
        previous_revision = "2026-08-20T02:39:34+00:00"
        cancelled_revision = "2026-08-20T02:40:00+00:00"
        manifest = {"status": "ready", "created_at": "2026-08-20T02:39:50+00:00"}

        for cancelled_status in ("cancelled", "canceled"):
            with self.subTest(status=cancelled_status):
                record = remote_ui_app.RunRecord(
                    run_id="r" * 32,
                    session_name="preview-refresh",
                    prompt="test",
                    workspace="/tmp/project",
                    variant="expo-fast",
                    created_at="2026-08-20T02:00:00+00:00",
                    updated_at="2026-08-20T02:00:00+00:00",
                    runtime="expo",
                    latest_adjustment_at=cancelled_revision,
                    preview_source_adjustment_at=previous_revision,
                    preview_refresh_status="failed",
                    preview_refresh_target_at=cancelled_revision,
                    preview_refresh_error="最近一次续跑已取消。",
                )
                follow_up = {
                    "status": "idle",
                    "queue_length": 0,
                    "active_command": None,
                    "queue": [],
                    "history": [
                        {
                            "type": "message",
                            "status": "completed",
                            "created_at": previous_revision,
                        },
                        {
                            "type": "message",
                            "status": cancelled_status,
                            "created_at": cancelled_revision,
                        },
                    ],
                }
                response = {
                    "command": follow_up["history"][-1],
                    "follow_up": follow_up,
                }

                with patch.object(remote_ui_app, "load_run", return_value=record):
                    with patch.object(remote_ui_app, "save_run", side_effect=lambda current: current):
                        updated = remote_ui_app.persist_latest_adjustment(
                            record,
                            response,
                            replace_from_state=True,
                        )

                self.assertEqual(updated.latest_adjustment_at, previous_revision)
                self.assertEqual(updated.preview_source_adjustment_at, previous_revision)
                self.assertEqual(updated.preview_refresh_status, "ready")
                self.assertEqual(updated.preview_refresh_target_at, previous_revision)
                self.assertEqual(updated.preview_refresh_error, "")
                self.assertFalse(
                    remote_ui_app.follow_up_changed_after_manifest(
                        follow_up,
                        manifest,
                        updated.latest_adjustment_at,
                    )
                )

    def test_completed_follow_up_with_legacy_acceptance_timestamp_is_refreshable(self) -> None:
        record = remote_ui_app.RunRecord(
            run_id="r" * 32,
            session_name="preview-refresh",
            prompt="test",
            workspace="/tmp/project",
            variant="expo-fast",
            created_at="2026-08-20T02:00:00+00:00",
            updated_at="2026-08-20T02:00:00+00:00",
            runtime="expo",
            latest_adjustment_at="2026-08-20T02:39:34.690588+00:00",
        )
        follow_up = {
            "status": "idle",
            "queue_length": 0,
            "active_command": None,
            "queue": [],
            "history": [{
                "type": "message",
                "status": "completed",
                "created_at": "2026-08-20T02:39:34.686Z",
            }],
        }

        ready, error = remote_ui_app.follow_up_ready_for_preview_refresh(record, follow_up)

        self.assertTrue(ready)
        self.assertEqual(error, "")

    def test_adjustment_newer_than_manifest_marks_package_outdated(self) -> None:
        manifest = {"status": "ready", "created_at": "2026-07-27T10:00:00+00:00"}
        follow_up = {
            "active_command": {
                "type": "message",
                "created_at": "2026-07-27T10:01:00+00:00",
            },
            "history": [],
        }

        self.assertTrue(
            remote_ui_app.follow_up_changed_after_manifest(follow_up, manifest)
        )

    def test_queued_adjustment_immediately_marks_package_outdated(self) -> None:
        manifest = {"status": "ready", "created_at": "2026-07-27T10:00:00+00:00"}
        follow_up = {
            "active_command": None,
            "queue": [
                {
                    "type": "message",
                    "status": "queued",
                    "created_at": "2026-07-27T10:01:00+00:00",
                }
            ],
            "history": [],
        }

        self.assertTrue(
            remote_ui_app.follow_up_changed_after_manifest(follow_up, manifest)
        )

    def test_persisted_adjustment_survives_unavailable_controller(self) -> None:
        manifest = {"status": "ready", "created_at": "2026-07-27T10:00:00+00:00"}

        self.assertTrue(
            remote_ui_app.follow_up_changed_after_manifest(
                {"status": "unavailable"},
                manifest,
                "2026-07-27T10:01:00+00:00",
            )
        )

    def test_package_stays_current_when_only_older_adjustments_exist(self) -> None:
        manifest = {"status": "ready", "created_at": "2026-07-27T10:00:00+00:00"}
        follow_up = {
            "active_command": None,
            "history": [
                {
                    "type": "message",
                    "status": "completed",
                    "created_at": "2026-07-27T09:59:00+00:00",
                }
            ],
        }

        self.assertFalse(
            remote_ui_app.follow_up_changed_after_manifest(follow_up, manifest)
        )

    def test_interrupted_before_assistant_activity_does_not_outdate_package(self) -> None:
        manifest = {"status": "ready", "created_at": "2026-07-27T10:00:00+00:00"}
        follow_up = {
            "active_command": None,
            "history": [
                {
                    "type": "message",
                    "status": "interrupted",
                    "created_at": "2026-07-27T10:01:00+00:00",
                    "interrupted_before_assistant_activity": True,
                }
            ],
        }

        self.assertFalse(
            remote_ui_app.follow_up_changed_after_manifest(follow_up, manifest)
        )
        self.assertEqual(
            remote_ui_app.newest_follow_up_message_at(follow_up),
            "",
        )

    def test_interrupted_after_assistant_activity_still_outdates_package(self) -> None:
        manifest = {"status": "ready", "created_at": "2026-07-27T10:00:00+00:00"}
        follow_up = {
            "active_command": None,
            "history": [
                {
                    "type": "message",
                    "status": "interrupted",
                    "created_at": "2026-07-27T10:01:00+00:00",
                }
            ],
        }

        self.assertTrue(
            remote_ui_app.follow_up_changed_after_manifest(follow_up, manifest)
        )

    def test_follow_up_package_skips_qa_gate(self) -> None:
        self.assertTrue(
            remote_ui_app.package_qa_gate_ready(True, "waiting")
        )

    def test_initial_package_still_requires_qa(self) -> None:
        self.assertFalse(
            remote_ui_app.package_qa_gate_ready(False, "waiting")
        )
        self.assertTrue(
            remote_ui_app.package_qa_gate_ready(False, "complete")
        )

    def test_adjustment_submitted_during_packaging_keeps_result_outdated(self) -> None:
        self.assertTrue(
            remote_ui_app.package_revision_outdated(
                "2026-07-27T10:02:00+00:00",
                "2026-07-27T10:01:00+00:00",
            )
        )

    def test_package_is_current_when_it_uses_latest_adjustment_revision(self) -> None:
        revision = "2026-07-27T10:02:00+00:00"
        self.assertFalse(
            remote_ui_app.package_revision_outdated(revision, revision)
        )


if __name__ == "__main__":
    unittest.main()
