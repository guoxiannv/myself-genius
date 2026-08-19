import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


MODULE_PATH = Path(__file__).resolve().parents[1] / "app.py"
SPEC = importlib.util.spec_from_file_location("remote_ui_initial_package_app", MODULE_PATH)
remote_ui_app = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
sys.modules[SPEC.name] = remote_ui_app
SPEC.loader.exec_module(remote_ui_app)


class InitialPackageMonitorTests(unittest.TestCase):
    def test_ready_run_starts_first_package(self) -> None:
        with tempfile.TemporaryDirectory() as workspace:
            record = SimpleNamespace(
                run_id="ready-run",
                workspace=workspace,
                created_at="2026-07-28T00:00:00Z",
                first_install_url="",
                capture_status="complete",
            )
            started: list[str] = []
            originals = {
                "load_run": remote_ui_app.load_run,
                "find_latest_hap": remote_ui_app.find_latest_hap,
                "load_ui_qa_status": remote_ui_app.load_ui_qa_status,
                "start_hpack_packaging": remote_ui_app.start_hpack_packaging,
            }
            remote_ui_app.load_run = lambda _run_id: record
            remote_ui_app.find_latest_hap = lambda _workspace, _created_at: Path(workspace) / "entry.hap"
            remote_ui_app.load_ui_qa_status = lambda _workspace, _session_name: "complete"
            remote_ui_app.start_hpack_packaging = lambda latest: started.append(latest.run_id) or True
            record.session_name = "hp-ready-run"
            try:
                remote_ui_app.wait_for_initial_package(record)
            finally:
                for name, value in originals.items():
                    setattr(remote_ui_app, name, value)

            self.assertEqual(started, ["ready-run"])

    def test_failed_preview_does_not_block_first_package(self) -> None:
        with tempfile.TemporaryDirectory() as workspace:
            record = SimpleNamespace(
                run_id="preview-failed-run",
                workspace=workspace,
                created_at="2026-07-28T00:00:00Z",
                first_install_url="",
                capture_status="failed",
                session_name="preview-failed",
            )
            started: list[str] = []
            originals = {
                "load_run": remote_ui_app.load_run,
                "find_latest_hap": remote_ui_app.find_latest_hap,
                "load_ui_qa_status": remote_ui_app.load_ui_qa_status,
                "start_hpack_packaging": remote_ui_app.start_hpack_packaging,
            }
            remote_ui_app.load_run = lambda _run_id: record
            remote_ui_app.find_latest_hap = lambda _workspace, _created_at: Path(workspace) / "entry.hap"
            remote_ui_app.load_ui_qa_status = lambda _workspace, _session_name: "complete"
            remote_ui_app.start_hpack_packaging = lambda latest: started.append(latest.run_id) or True
            try:
                remote_ui_app.wait_for_initial_package(record)
            finally:
                for name, value in originals.items():
                    setattr(remote_ui_app, name, value)

            self.assertEqual(started, ["preview-failed-run"])


if __name__ == "__main__":
    unittest.main()
