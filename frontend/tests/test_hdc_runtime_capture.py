import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "scripts" / "hdc_runtime_capture.py"
)
SPEC = importlib.util.spec_from_file_location("hdc_runtime_capture", MODULE_PATH)
hdc_runtime_capture = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
sys.modules[SPEC.name] = hdc_runtime_capture
SPEC.loader.exec_module(hdc_runtime_capture)


def make_bounds(x1: int, y1: int, x2: int, y2: int) -> str:
    return f"[{x1},{y1}][{x2},{y2}]"


def make_text_node(text: str, x1: int, y1: int, x2: int, y2: int) -> dict:
    return {
        "attributes": {
            "type": "Text",
            "text": text,
            "bounds": make_bounds(x1, y1, x2, y2),
        },
        "children": [],
    }


class SafeSlugTests(unittest.TestCase):
    def test_safe_slug_normalizes_and_falls_back(self) -> None:
        self.assertEqual(hdc_runtime_capture.safe_slug("  Hello World!  "), "hello-world")
        self.assertEqual(hdc_runtime_capture.safe_slug("###", "fallback"), "fallback")


class ExtractTabTitleTests(unittest.TestCase):
    def test_extract_tab_title_prefers_center_title_for_center_builder(self) -> None:
        title = hdc_runtime_capture.extract_tab_title(
            "CenterTabBuilder",
            "'+', 'ignored'",
            "Create",
        )
        self.assertEqual(title, "Create")

    def test_extract_tab_title_uses_last_literal_for_tab_builder(self) -> None:
        title = hdc_runtime_capture.extract_tab_title(
            "TabBuilder",
            "0, 'unused-icon', 'Today'",
            "Center",
        )
        self.assertEqual(title, "Today")

    def test_extract_tab_title_uses_first_literal_for_generic_builder(self) -> None:
        title = hdc_runtime_capture.extract_tab_title(
            "TabBarItem",
            "0, 'Inbox', 'mail'",
            "Center",
        )
        self.assertEqual(title, "Inbox")


class GeometryPlanTests(unittest.TestCase):
    def test_apply_geometry_to_plan_sets_tap_and_scroll_defaults(self) -> None:
        plan = {
            "tabs": [
                {
                    "slot_index": 0,
                    "name": "home",
                    "is_center": False,
                    "activate_via_tap": True,
                    "scroll_count": 1,
                },
                {
                    "slot_index": 1,
                    "name": "compose",
                    "is_center": True,
                    "activate_via_tap": True,
                    "scroll_count": 0,
                },
                {
                    "slot_index": 2,
                    "name": "settings",
                    "activate_via_tap": False,
                    "scroll_count": 0,
                },
            ]
        }

        updated = hdc_runtime_capture.apply_geometry_to_plan(plan, 1200, 2000)

        self.assertEqual(updated["screen"], {"width": 1200, "height": 2000})
        self.assertEqual(updated["tabs"][0]["tap"], {"x": 200, "y": 1840})
        self.assertEqual(updated["tabs"][1]["tap"], {"x": 600, "y": 1800})
        self.assertEqual(updated["tabs"][2]["tap"], {})
        self.assertEqual(len(updated["tabs"][0]["scrolls"]), 1)
        self.assertFalse(updated["tabs"][1]["runtime_scroll_detection"])
        self.assertTrue(updated["tabs"][0]["capture_before_scroll"])
        self.assertEqual(updated["tabs"][0]["wait_after_tap_sec"], 1.0)


class RuntimeAnalysisTests(unittest.TestCase):
    def test_parse_ui_bounds_parses_valid_format(self) -> None:
        self.assertEqual(
            hdc_runtime_capture.parse_ui_bounds("[10,20][110,220]"),
            (10, 20, 110, 220),
        )
        self.assertIsNone(hdc_runtime_capture.parse_ui_bounds("invalid"))

    def test_analyze_scroll_runtime_state_detects_scrollable_viewport(self) -> None:
        ui_dump = {
            "attributes": {"bounds": make_bounds(0, 0, 1200, 2000)},
            "children": [
                {
                    "attributes": {
                        "type": "List",
                        "scrollable": "true",
                        "bounds": make_bounds(0, 200, 1200, 1800),
                    },
                    "children": [
                        make_text_node("Alpha", 80, 280, 420, 340),
                        make_text_node("Beta", 80, 720, 420, 780),
                        make_text_node("Gamma", 80, 1120, 420, 1180),
                        make_text_node("Delta", 80, 1480, 420, 1540),
                    ],
                }
            ],
        }

        state = hdc_runtime_capture.analyze_scroll_runtime_state(ui_dump)

        self.assertTrue(state["scrollable"])
        self.assertEqual(state["viewport"], (0, 200, 1200, 1800))
        self.assertEqual(state["viewport_type"], "List")
        self.assertEqual(state["anchor_count"], 4)
        self.assertIn("Alpha@", state["anchor_signature"])
        self.assertFalse(state["content_reaches_bottom"])
        self.assertFalse(state["low_content"])

    def test_analyze_scroll_runtime_state_marks_low_content_when_only_few_anchors(self) -> None:
        ui_dump = {
            "attributes": {"bounds": make_bounds(0, 0, 1200, 2000)},
            "children": [
                {
                    "attributes": {
                        "type": "Scroll",
                        "scrollable": "true",
                        "bounds": make_bounds(0, 200, 1200, 1800),
                    },
                    "children": [
                        make_text_node("Only one", 80, 280, 420, 340),
                        make_text_node("Only two", 80, 420, 420, 480),
                    ],
                }
            ],
        }

        state = hdc_runtime_capture.analyze_scroll_runtime_state(ui_dump)

        self.assertTrue(state["scrollable"])
        self.assertTrue(state["low_content"])
        self.assertGreaterEqual(state["bottom_gap"], 1000)


class RuntimeClassificationTests(unittest.TestCase):
    def test_classify_runtime_scroll_transition_prefers_anchor_changes(self) -> None:
        status, message = hdc_runtime_capture.classify_runtime_scroll_transition(
            {
                "scrollable": True,
                "anchor_signature": "A|B",
                "low_content": False,
                "content_reaches_bottom": False,
                "bottom_gap": 300,
            },
            {
                "scrollable": True,
                "anchor_signature": "C|D",
                "low_content": False,
                "content_reaches_bottom": False,
                "bottom_gap": 250,
            },
        )

        self.assertEqual(status, "scroll_effective")
        self.assertIn("anchors changed", message)

    def test_classify_runtime_scroll_transition_detects_bottom_and_no_effect(self) -> None:
        bottom_status, _ = hdc_runtime_capture.classify_runtime_scroll_transition(
            {
                "scrollable": True,
                "anchor_signature": "A|B",
                "low_content": False,
                "content_reaches_bottom": True,
                "bottom_gap": 90,
            },
            {
                "scrollable": True,
                "anchor_signature": "A|B",
                "low_content": False,
                "content_reaches_bottom": True,
                "bottom_gap": 90,
            },
        )
        no_effect_status, _ = hdc_runtime_capture.classify_runtime_scroll_transition(
            {
                "scrollable": True,
                "anchor_signature": "A|B",
                "low_content": False,
                "content_reaches_bottom": False,
                "bottom_gap": 300,
            },
            {
                "scrollable": True,
                "anchor_signature": "A|B",
                "low_content": False,
                "content_reaches_bottom": False,
                "bottom_gap": 320,
            },
        )

        self.assertEqual(bottom_status, "already_at_bottom")
        self.assertEqual(no_effect_status, "scroll_not_effective")


class SwipeSplitTests(unittest.TestCase):
    def test_split_swipe_into_steps_preserves_final_endpoint(self) -> None:
        steps = hdc_runtime_capture.split_swipe_into_steps(
            {
                "x1": 100,
                "y1": 900,
                "x2": 100,
                "y2": 300,
                "duration_ms": 520,
                "wait_after_sec": 0.8,
                "capture_wait_after_sec": 0.1,
            },
            4,
        )

        self.assertEqual(len(steps), 4)
        self.assertEqual(steps[0]["x1"], 100)
        self.assertEqual(steps[-1]["x2"], 100)
        self.assertEqual(steps[-1]["y2"], 300)
        self.assertTrue(all(step["duration_ms"] >= 80 for step in steps))
        self.assertTrue(all(step["wait_after_sec"] == 0.1 for step in steps))


if __name__ == "__main__":
    unittest.main()
