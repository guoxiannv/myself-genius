import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "profile_pool_manager.py"
SPEC = importlib.util.spec_from_file_location("profile_pool_manager", MODULE_PATH)
profile_pool_manager = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
sys.modules[SPEC.name] = profile_pool_manager
SPEC.loader.exec_module(profile_pool_manager)


class ProfilePoolSlotTests(unittest.TestCase):
    def test_slot_without_explicit_cert_is_not_ready(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            profile_path = root / "profile.p7b"
            profile_path.write_text("bundle-name: com.example.app", encoding="utf-8")

            slots = profile_pool_manager.load_slots_from_payload(
                {
                    "defaults": {
                        "cert": "shared.cer",
                        "keystore": "shared.p12",
                        "alias": "alias",
                    },
                    "slots": [{"id": "slot-01", "profile": "profile.p7b"}],
                },
                root,
            )

            self.assertEqual(len(slots), 1)
            ready, reason = slots[0].readiness()
            self.assertFalse(ready)
            self.assertIn("显式配置 cert", reason)


if __name__ == "__main__":
    unittest.main()
