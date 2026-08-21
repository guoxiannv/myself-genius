import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "hpack_packager.py"
SPEC = importlib.util.spec_from_file_location("hpack_packager", MODULE_PATH)
hpack_packager = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
sys.modules[SPEC.name] = hpack_packager
SPEC.loader.exec_module(hpack_packager)

CERT_A = """-----BEGIN CERTIFICATE-----
MIICwDCCAkegAwIBAgIOCf0/tuhRfDuXGGiygTIwCgYIKoZIzj0EAwMwYjELMAkG
A1UEBgwCQ04xDzANBgNVBAoMBkh1YXdlaTETMBEGA1UECwwKSHVhd2VpIENCRzEt
MCsGA1UEAwwkSHVhd2VpIENCRyBEZXZlbG9wZXIgUmVsYXRpb25zIENBIEcyMB4X
DTI2MDYxMzAyMjYxOFoXDTI5MDYxMzAyMjYxOFowcTELMAkGA1UEBhMCQ04xEjAQ
BgNVBAoMCemDree6ouS+oDEcMBoGA1UECwwTMTg3MzE2NjM3MDI4NDI3NjczNzEw
MC4GA1UEAwwn6YOt57qi5L6gKDE4NzMxNjYzNzAyODQyNzY3MzcpXCxSZWxlYXNl
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKQb5AwAbV55iq6AImmhQkpEyDZp2
VtSkqJVqGprmZj+YiHsOZe888TNdkLl+3Gi2jVTpmURa7UeixCovsyb/z6OB0TCB
zjAdBgNVHQ4EFgQUSr+eq6D06NS3980pbormh32zgekwDAYDVR0TAQH/BAIwADAf
BgNVHSMEGDAWgBTbXpOyI+jQ5P5xembppHNHW3/zXjBZBgNVHR8EUjBQME6gTKBK
hkhodHRwOi8vaDVob3N0aW5nLWRyY24uZGJhbmtjZG4uY24vY2NoNS9jcmwvaGRy
Y2FnMi9IdWFpQ0JHSDRHMmNybC5jcmwwDgYDVR0PAQH/BAQDAgeAMBMGA1UdJQQM
MAoGCCsGAQUFBwMDMAoGCCqGSM49BAMDA2cAMGQCMEMoPXIc/GB+wPkAvlKF2Ckj
mfR9ZDwXwzGFwRL3jxgIzr+u69DF9DLJ4/MzfkHPPAIwU9e3nstcXAZDiydfwxZH
YejmTM6w008+ta68cnKdNotfnSmn5piI47u0CVBB+sC/
-----END CERTIFICATE-----
"""

CERT_B = """-----BEGIN CERTIFICATE-----
MIICwTCCAkegAwIBAgIOCf0/tuz1G2xTr3n7F70wCgYIKoZIzj0EAwMwYjELMAkG
A1UEBgwCQ04xDzANBgNVBAoMBkh1YXdlaTETMBEGA1UECwwKSHVhd2VpIENCRzEt
MCsGA1UEAwwkSHVhd2VpIENCRyBEZXZlbG9wZXIgUmVsYXRpb25zIENBIEcyMB4X
DTI2MDYxMzAyNDgwOVoXDTI5MDYxMzAyNDgwOVowcTELMAkGA1UEBhMCQ04xEjAQ
BgNVBAoMCemDree6ouS+oDEcMBoGA1UECwwTMTg3MzE2NjM3MDI4NDI3NjczNzEw
MC4GA1UEAwwn6YOt57qi5L6gKDE4NzMxNjYzNzAyODQyNzY3MzcpXCxSZWxlYXNl
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKQb5AwAbV55iq6AImmhQkpEyDZp2
VtSkqJVqGprmZj+YiHsOZe888TNdkLl+3Gi2jVTpmURa7UeixCovsyb/z6OB0TCB
zjAdBgNVHQ4EFgQUSr+eq6D06NS3980pbormh32zgekwDAYDVR0TAQH/BAIwADAf
BgNVHSMEGDAWgBTbXpOyI+jQ5P5xembppHNHW3/zXjBZBgNVHR8EUjBQME6gTKBK
hkhodHRwOi8vaDVob3N0aW5nLWRyY24uZGJhbmtjZG4uY24vY2NoNS9jcmwvaGRy
Y2FnMi9IdWFpQ0JHSDRHMmNybC5jcmwwDgYDVR0PAQH/BAQDAgeAMBMGA1UdJQQM
MAoGCCsGAQUFBwMDMAoGCCqGSM49BAMDA2gAMGUCMCxbzf5tDYYDAY01r8jPF731
ZAD+mWrI3NdR5MBSJTti68F2e11nwcxoprzYl3/OzAIxAMviTGtl7bjAumI3rR4D
mXbNot1R4miwbPE8Txi9igu9xp480b7TxHzng3xy0vnS8w==
-----END CERTIFICATE-----
"""


def profile_text(cert: str) -> str:
    escaped = cert.replace("\n", "\\n")
    payload = {
        "app-distribution-type": "internaltesting",
        "type": "release",
        "bundle-info": {
            "bundle-name": "com.example.app",
            "distribution-certificate": cert,
        },
        "debug-info": {"device-ids": ["device-1"]},
    }
    return __import__("json").dumps(payload)


class HPackPackagerSigningTests(unittest.TestCase):
    def test_reads_expo_prebuilt_hap_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            hap_path = Path(temp_dir) / "expo-app.hap"
            with zipfile.ZipFile(hap_path, "w") as archive:
                archive.writestr(
                    "pack.info",
                    json.dumps(
                        {
                            "summary": {
                                "app": {
                                    "bundleName": "com.example.expo",
                                    "version": {"code": 8, "name": "1.2.3"},
                                },
                                "modules": [
                                    {"apiVersion": {"compatible": 21, "target": 22}}
                                ],
                            }
                        }
                    ),
                )
                archive.writestr(
                    "module.json",
                    json.dumps({
                        "app": {
                            "debug": False,
                            "buildMode": "release",
                            "minAPIVersion": 60001021,
                            "targetAPIVersion": 60002022,
                        },
                        "module": {"deviceTypes": ["phone"]},
                    }),
                )

            metadata = hpack_packager.read_hap_metadata(hap_path)

            self.assertEqual(metadata["bundle_name"], "com.example.expo")
            self.assertEqual(metadata["version_code"], 8)
            self.assertEqual(metadata["version_name"], "1.2.3")
            self.assertEqual(metadata["compatible_sdk"], 21)
            self.assertEqual(metadata["target_sdk"], 22)
            self.assertEqual(metadata["manifest_min_api"], "6.0.1(21)")
            self.assertEqual(metadata["manifest_target_api"], "6.0.2(22)")
            self.assertFalse(metadata["debug"])
            self.assertEqual(metadata["build_mode"], "release")
            self.assertEqual(metadata["device_types"], ["phone"])

    def test_rejects_debug_expo_hap_for_phone_distribution(self) -> None:
        with self.assertRaisesRegex(hpack_packager.PackagerError, "必须使用 release 构建"):
            hpack_packager.ensure_release_hap({"debug": True, "build_mode": "debug"})

    def test_rejects_hap_without_phone_device_type(self) -> None:
        with self.assertRaisesRegex(hpack_packager.PackagerError, "必须支持 phone"):
            hpack_packager.ensure_phone_hap({"device_types": ["2in1"]})

    def test_rejects_hap_without_pc_device_type(self) -> None:
        with self.assertRaisesRegex(hpack_packager.PackagerError, "必须支持 2in1"):
            hpack_packager.ensure_pc_hap({"device_types": ["phone"]})

    def test_normalizes_pro_workspace_for_phone_and_pc(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            module_path = Path(temp_dir) / "entry" / "src" / "main" / "module.json5"
            module_path.parent.mkdir(parents=True)
            module_path.write_text(
                '{\n  "module": {\n    "deviceTypes": [\n      "phone",\n      "tablet",\n      "2in1"\n    ]\n  }\n}\n',
                encoding="utf-8",
            )

            hpack_packager.normalize_workspace_for_device_distribution(Path(temp_dir))

            normalized = module_path.read_text(encoding="utf-8")
            self.assertIn('"deviceTypes": [\n      "phone",\n      "2in1"\n    ]', normalized)

    def test_packages_prebuilt_expo_hap_into_install_distribution(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            workspace = root / "workspace"
            workspace.mkdir()
            static_root = root / "static"
            unsigned_hap = root / "expo-unsigned.hap"
            unsigned_hap.write_bytes(b"unsigned-hap")
            cert = root / "release.cer"
            profile = root / "release.p7b"
            keystore = root / "release.p12"
            for signing_file in (cert, profile, keystore):
                signing_file.write_bytes(b"test")
            args = SimpleNamespace(
                static_root=str(static_root),
                base_url="https://downloads.example.com/static/hpack",
                deploy_domain="downloads.example.com",
                app_name="Expo Test",
                run_id="a" * 32,
                output=str(root / "result" / "hpack-result.json"),
                java_home="/fake/java",
                hpack_bin="hpack",
                alias="test-alias",
                key_pwd="test-key-password",
                keystore_pwd="test-store-password",
                check_urls=False,
            )
            metadata = {
                "bundle_name": "com.example.expo",
                "version_code": 8,
                "version_name": "1.2.3",
                "compatible_sdk": 21,
                "target_sdk": 22,
                "manifest_min_api": "6.0.1(21)",
                "manifest_target_api": "6.0.2(22)",
                "debug": False,
                "build_mode": "release",
                "device_types": ["phone", "2in1"],
            }

            def fake_run(command, cwd, _env, _secrets):
                if command[:2] == ["hpack", "sign"]:
                    source = Path(command[2])
                    shutil.copy2(source, source.with_name(f"hpack-signed-{source.name}"))
                elif "-operation" in command and command[command.index("-operation") + 1] == "sign":
                    source = Path(command[command.index("-inputFile") + 1])
                    output = Path(command[command.index("-outputFile") + 1])
                    shutil.copy2(source, output)

            def fake_icon(_workspace, destination):
                icon = destination / "assets" / "AppIcon.png"
                icon.parent.mkdir(parents=True, exist_ok=True)
                icon.write_bytes(b"png")

            def fake_manifest_sign(source, output, **_kwargs):
                shutil.copy2(source, output)

            with patch.object(hpack_packager, "run_command", side_effect=fake_run), \
                 patch.object(hpack_packager, "ensure_app_icon", side_effect=fake_icon), \
                 patch.object(hpack_packager, "verify_signed_hap"), \
                 patch.object(hpack_packager, "sign_install_manifest", side_effect=fake_manifest_sign):
                result = hpack_packager.package_prebuilt_hap(
                    args,
                    workspace=workspace,
                    unsigned_hap=unsigned_hap,
                    metadata=metadata,
                    cert=cert,
                    profile=profile,
                    keystore=keystore,
                    profile_info={"bundle_name": "com.example.expo"},
                )

            published = Path(result["published_dir"])
            self.assertEqual(result["status"], "ready")
            self.assertEqual(result["source"], "expo-prebuilt-hap")
            self.assertTrue((published / "entry-default-signed.hap").is_file())
            self.assertTrue((published / "manifest.json5").is_file())
            self.assertTrue((published / "index.html").is_file())
            manifest = json.loads((published / "manifest.json5").read_text(encoding="utf-8"))
            self.assertEqual(manifest["app"]["bundleName"], "com.example.expo")
            self.assertEqual(manifest["app"]["minAPIVersion"], "6.0.1(21)")
            self.assertEqual(manifest["app"]["targetAPIVersion"], "6.0.2(22)")
            self.assertEqual(manifest["app"]["modules"][0]["deviceTypes"], ["phone", "2in1"])
            install_page = (published / "index.html").read_text(encoding="utf-8")
            self.assertIn("一键安装到本机", install_page)
            self.assertIn("不需要 DevEco Studio、HDC、终端或开发者选项", install_page)

    def test_rebuild_command_targets_release_hap_for_selected_product(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            hap_path = workspace / hpack_packager.UNSIGNED_HAP_RELATIVE_PATH
            hap_path.parent.mkdir(parents=True)

            commands: list[list[str]] = []

            def fake_run(command, cwd, env, secrets):
                commands.append(command)
                with zipfile.ZipFile(hap_path, "w") as archive:
                    archive.writestr(
                        "pack.info",
                        json.dumps({
                            "summary": {
                                "app": {"bundleName": "com.example.app"},
                                "modules": [{"apiVersion": {"compatible": 22, "target": 22}}],
                            }
                        }),
                    )
                    archive.writestr(
                        "module.json",
                        json.dumps({
                            "app": {"debug": False, "buildMode": "release"},
                            "module": {"deviceTypes": ["phone", "2in1"]},
                        }),
                    )
                return None

            original_run = hpack_packager.run_command
            hpack_packager.run_command = fake_run
            try:
                result = hpack_packager.rebuild_unsigned_hap(
                    workspace,
                    hvigorw_path="/tools/hvigorw",
                    product="release",
                    env={},
                    secrets=[],
                )
            finally:
                hpack_packager.run_command = original_run

            self.assertEqual(result, hap_path)
            self.assertEqual(
                commands,
                [[
                    "/tools/hvigorw", "assembleHap", "--mode", "module",
                    "-p", "product=release", "-p", "debuggable=false", "--no-daemon",
                ]],
            )

    def test_parse_profile_records_distribution_certificate_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            profile_path = Path(temp_dir) / "profile.p7b"
            profile_path.write_text(profile_text(CERT_A), encoding="utf-8")

            info = hpack_packager.parse_profile(profile_path)

            self.assertEqual(info["bundle_name"], "com.example.app")
            self.assertEqual(
                info["distribution_certificate_fingerprint"],
                hpack_packager.certificate_fingerprint_from_pem(CERT_A),
            )

    def test_matching_profile_and_cert_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            cert_path = Path(temp_dir) / "release.cer"
            cert_path.write_text(CERT_A, encoding="utf-8")
            info = {
                "distribution_certificate_fingerprint":
                    hpack_packager.certificate_fingerprint_from_pem(CERT_A),
            }

            hpack_packager.ensure_profile_cert_matches(info, cert_path)

    def test_mismatched_profile_and_cert_fails_before_packaging(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            cert_path = Path(temp_dir) / "release.cer"
            cert_path.write_text(CERT_B, encoding="utf-8")
            info = {
                "distribution_certificate_fingerprint":
                    hpack_packager.certificate_fingerprint_from_pem(CERT_A),
            }

            with self.assertRaisesRegex(hpack_packager.PackagerError, "不匹配"):
                hpack_packager.ensure_profile_cert_matches(info, cert_path)

    def test_keystore_identity_accepts_the_same_release_certificate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            keytool = root / "java" / "bin" / "keytool"
            keytool.parent.mkdir(parents=True)
            keytool.write_text("", encoding="utf-8")
            keystore = root / "release.p12"
            keystore.write_bytes(b"p12")
            cert = root / "release.cer"
            cert.write_text(CERT_A, encoding="utf-8")

            def fake_run(command, _cwd, _env, _secrets):
                output = Path(command[command.index("-file") + 1])
                output.write_text(CERT_A, encoding="utf-8")
                return SimpleNamespace(stdout="")

            with patch.object(hpack_packager, "run_command", side_effect=fake_run), \
                 patch.object(hpack_packager, "certificate_public_key_sha256", return_value="same-key"):
                identity = hpack_packager.inspect_keystore_signing_identity(
                    keystore,
                    cert,
                    alias="release",
                    keystore_pwd="secret",
                    java_home=str(root / "java"),
                    env={},
                )

            self.assertTrue(identity["source_certificate_matches"])
            self.assertTrue(identity["public_key_matches"])

    def test_keystore_identity_allows_certificate_alignment_for_the_same_public_key(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            keytool = root / "java" / "bin" / "keytool"
            keytool.parent.mkdir(parents=True)
            keytool.write_text("", encoding="utf-8")
            keystore = root / "release.p12"
            keystore.write_bytes(b"p12")
            cert = root / "release.cer"
            cert.write_text(CERT_A, encoding="utf-8")

            def fake_run(command, _cwd, _env, _secrets):
                output = Path(command[command.index("-file") + 1])
                output.write_text(CERT_B, encoding="utf-8")
                return SimpleNamespace(stdout="")

            with patch.object(hpack_packager, "run_command", side_effect=fake_run), \
                 patch.object(hpack_packager, "certificate_public_key_sha256", return_value="same-key"):
                identity = hpack_packager.inspect_keystore_signing_identity(
                    keystore,
                    cert,
                    alias="release",
                    keystore_pwd="secret",
                    java_home=str(root / "java"),
                    env={},
                )

            self.assertFalse(identity["source_certificate_matches"])
            self.assertTrue(identity["public_key_matches"])

    def test_keystore_identity_rejects_a_different_public_key(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            keytool = root / "java" / "bin" / "keytool"
            keytool.parent.mkdir(parents=True)
            keytool.write_text("", encoding="utf-8")
            keystore = root / "release.p12"
            keystore.write_bytes(b"p12")
            cert = root / "release.cer"
            cert.write_text(CERT_A, encoding="utf-8")

            def fake_run(command, _cwd, _env, _secrets):
                output = Path(command[command.index("-file") + 1])
                output.write_text(CERT_B, encoding="utf-8")
                return SimpleNamespace(stdout="")

            with patch.object(hpack_packager, "run_command", side_effect=fake_run), \
                 patch.object(hpack_packager, "certificate_public_key_sha256", side_effect=["key-b", "key-a"]):
                with self.assertRaisesRegex(hpack_packager.PackagerError, "公钥不匹配"):
                    hpack_packager.inspect_keystore_signing_identity(
                        keystore,
                        cert,
                        alias="release",
                        keystore_pwd="secret",
                        java_home=str(root / "java"),
                        env={},
                    )


if __name__ == "__main__":
    unittest.main()
