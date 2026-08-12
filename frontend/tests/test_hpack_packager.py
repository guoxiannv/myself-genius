import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


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
    def test_rebuild_command_targets_release_hap_for_selected_product(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            hap_path = workspace / hpack_packager.UNSIGNED_HAP_RELATIVE_PATH
            hap_path.parent.mkdir(parents=True)

            commands: list[list[str]] = []

            def fake_run(command, cwd, env, secrets):
                commands.append(command)
                hap_path.write_bytes(b"fresh-hap")
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


if __name__ == "__main__":
    unittest.main()
