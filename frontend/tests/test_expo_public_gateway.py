import http.client
import json
import tempfile
import unittest
from pathlib import Path

from scan_install.expo_gateway import (
    ExpoExportValidationError,
    ExpoPublicGateway,
)


RUN_ID = "a" * 32


def write_harmony_go_export(root: Path, app_id: str = "sample-app") -> Path:
    artifact_root = root / "dist" / "harmony-go"
    miniapp_root = artifact_root / "miniapps" / app_id
    miniapp_root.mkdir(parents=True)
    bundle = b"globalThis.__sample = true;\n"
    (artifact_root / ".expo-harmony-go-export").write_text("", encoding="utf-8")
    (artifact_root / "runtime.json").write_text(json.dumps({"runtimeVersion": "test-runtime"}), encoding="utf-8")
    (artifact_root / "catalog.json").write_text(
        json.dumps(
            [
                {
                    "id": app_id,
                    "name": "Sample",
                    "version": "1.0.0",
                    "manifestUrl": f"/miniapps/{app_id}/manifest.json",
                }
            ]
        ),
        encoding="utf-8",
    )
    (miniapp_root / "bundle.js").write_bytes(bundle)
    (miniapp_root / "manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "id": app_id,
                "runtimeVersion": "test-runtime",
                "bundle": {
                    "url": f"/miniapps/{app_id}/bundle.js",
                    "bytes": len(bundle),
                    "sha256": "test",
                },
                "assets": [],
            }
        ),
        encoding="utf-8",
    )
    return artifact_root


class ExpoPublicGatewayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.apps_root = self.root / "apps"
        self.apps_root.mkdir()
        self.state_path = self.root / "state" / "publications.json"
        self.artifact_root = write_harmony_go_export(self.apps_root / "sample")
        self.gateway = ExpoPublicGateway(
            enabled=True,
            host="127.0.0.1",
            port=0,
            public_origin="https://devkit.yorha2b.cc/",
            state_path=self.state_path,
            allowed_root=self.apps_root,
        )
        self.assertTrue(self.gateway.start())

    def tearDown(self) -> None:
        self.gateway.stop()
        self.temp_dir.cleanup()

    def request(self, method: str, path: str):
        connection = http.client.HTTPConnection("127.0.0.1", self.gateway.bound_port)
        connection.request(method, path)
        response = connection.getresponse()
        body = response.read()
        result = response.status, dict(response.getheaders()), body
        connection.close()
        return result

    def test_publish_serves_catalog_manifest_and_bundle_then_revokes(self) -> None:
        serve, created = self.gateway.publish(RUN_ID, self.artifact_root)

        self.assertTrue(created)
        self.assertEqual(serve["status"], "serving")
        self.assertTrue(serve["public_url"].startswith("https://devkit.yorha2b.cc/p/"))
        token_path = url_path(serve["local_url"])

        status, headers, catalog_body = self.request("GET", token_path)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        catalog = json.loads(catalog_body)
        self.assertEqual(catalog[0]["id"], "sample-app")

        status, _, manifest_body = self.request("GET", token_path + "/miniapps/sample-app/manifest.json")
        self.assertEqual(status, 200)
        manifest = json.loads(manifest_body)
        self.assertEqual(manifest["bundle"]["bytes"], len(b"globalThis.__sample = true;\n"))

        status, headers, bundle_body = self.request("HEAD", token_path + "/miniapps/sample-app/bundle.js")
        self.assertEqual(status, 200)
        self.assertEqual(bundle_body, b"")
        self.assertEqual(int(headers["Content-Length"]), len(b"globalThis.__sample = true;\n"))

        status, _, _ = self.request("GET", token_path + "/%2e%2e/catalog.json")
        self.assertEqual(status, 404)

        stopped, removed = self.gateway.unpublish(RUN_ID, can_publish=True)
        self.assertTrue(removed)
        self.assertEqual(stopped["status"], "stopped")
        self.assertTrue(stopped["can_publish"])
        status, _, _ = self.request("GET", token_path + "/catalog.json")
        self.assertEqual(status, 404)

    def test_publish_is_idempotent_and_registry_survives_restart(self) -> None:
        first, created = self.gateway.publish(RUN_ID, self.artifact_root)
        second, created_again = self.gateway.publish(RUN_ID, self.artifact_root)
        self.assertTrue(created)
        self.assertFalse(created_again)
        self.assertEqual(second["public_url"], first["public_url"])

        self.gateway.stop()
        restored = ExpoPublicGateway(
            enabled=True,
            host="127.0.0.1",
            port=0,
            public_origin="https://devkit.yorha2b.cc",
            state_path=self.state_path,
            allowed_root=self.apps_root,
        )
        try:
            self.assertTrue(restored.start())
            restored_state = restored.describe(RUN_ID, can_publish=True)
            self.assertEqual(restored_state["status"], "serving")
            self.assertEqual(restored_state["public_url"], first["public_url"])
        finally:
            restored.stop()

    def test_multiple_runs_share_one_gateway_port(self) -> None:
        second_root = write_harmony_go_export(self.apps_root / "second", app_id="second-app")
        first, _ = self.gateway.publish(RUN_ID, self.artifact_root)
        second, _ = self.gateway.publish("b" * 32, second_root)

        self.assertNotEqual(first["public_url"], second["public_url"])
        first_status, _, first_body = self.request("GET", url_path(first["local_url"]) + "/catalog.json")
        second_status, _, second_body = self.request("GET", url_path(second["local_url"]) + "/catalog.json")
        self.assertEqual(first_status, 200)
        self.assertEqual(second_status, 200)
        self.assertEqual(json.loads(first_body)[0]["id"], "sample-app")
        self.assertEqual(json.loads(second_body)[0]["id"], "second-app")

        self.gateway.unpublish(RUN_ID)
        second_status, _, _ = self.request("GET", url_path(second["local_url"]) + "/catalog.json")
        self.assertEqual(second_status, 200)

    def test_publish_rejects_export_outside_configured_app_root(self) -> None:
        outside = write_harmony_go_export(self.root / "outside")
        with self.assertRaisesRegex(ExpoExportValidationError, "outside HP_EXPO_FAST_APP_ROOT"):
            self.gateway.publish(RUN_ID, outside)


def url_path(url: str) -> str:
    marker = url.find("/p/")
    if marker < 0:
        raise AssertionError(f"publication URL has no token path: {url}")
    return url[marker:]


if __name__ == "__main__":
    unittest.main()
