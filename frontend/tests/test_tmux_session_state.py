from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "app.py"
SPEC = importlib.util.spec_from_file_location("remote_ui_app_tmux_state", MODULE_PATH)
remote_ui_app = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
sys.modules[SPEC.name] = remote_ui_app
SPEC.loader.exec_module(remote_ui_app)


class TmuxSessionStateTests(unittest.TestCase):
    def test_session_name_is_stable_unique_and_independent_of_prompt_text(self) -> None:
        first = remote_ui_app.build_tmux_session_name("66b34e3e520e40e49158b32eb9508bd7")
        second = remote_ui_app.build_tmux_session_name("77c45f4f520e40e49158b32eb9508bd7")

        self.assertLessEqual(len(first), 48)
        self.assertEqual(first, "hp-66b34e3e520e")
        self.assertEqual(second, "hp-77c45f4f520e")
        self.assertNotEqual(first, second)

    def test_legacy_overlong_session_name_resolves_runner_state(self) -> None:
        legacy_name = "0-1-colorlog-app-ai-c-1-------llm---8---------ll-66b34e3e"
        runner_name = remote_ui_app.normalize_tmux_session_name(legacy_name)

        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            state_path = workspace / ".arkpilot" / "state" / "tmux-runs" / f"{runner_name}.json"
            state_path.parent.mkdir(parents=True)
            state_path.write_text(
                json.dumps({"status": "complete", "ui_qa": {"status": "complete"}}),
                encoding="utf-8",
            )

            state = remote_ui_app.load_tmux_run_state(workspace, legacy_name)

        self.assertIsNotNone(state)
        self.assertEqual(state["status"], "complete")
        self.assertEqual(remote_ui_app.ui_qa_status(state), "complete")


if __name__ == "__main__":
    unittest.main()
