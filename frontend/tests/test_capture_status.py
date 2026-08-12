from __future__ import annotations

import importlib.util
import sys
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
