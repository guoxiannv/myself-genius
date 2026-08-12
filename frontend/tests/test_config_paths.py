import unittest

from scan_install import config


class MonorepoExpoPathTests(unittest.TestCase):
    def test_expo_defaults_follow_the_genius_layout(self) -> None:
        self.assertEqual(config.DEFAULT_EXPO_FAST_ROOT, config.MONOREPO_ROOT / "runner")
        self.assertEqual(config.DEFAULT_EXPO_FAST_APP_ROOT, config.MONOREPO_ROOT / "expo-app")

    def test_relative_frontend_paths_are_anchored_to_frontend_root(self) -> None:
        self.assertEqual(config.resolve_app_path("../runner"), config.MONOREPO_ROOT / "runner")
        self.assertEqual(config.resolve_app_path("../sdk"), config.MONOREPO_ROOT / "sdk")


if __name__ == "__main__":
    unittest.main()
