#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import ssl
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


DEFAULT_HPACK_BIN = os.environ.get("HP_HPACK_BIN", "hpack")
DEFAULT_JAVA_HOME = "/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home"
DEFAULT_HVIGORW = "/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw"
UNSIGNED_HAP_RELATIVE_PATH = Path("entry/build/default/outputs/default/entry-default-unsigned.hap")


class PackagerError(RuntimeError):
    pass


def redact(value: str, secrets: list[str]) -> str:
    text = value
    for secret in secrets:
        if secret:
            text = text.replace(secret, "***")
    return text


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="ignore")


def extract_string_field(text: str, field: str) -> str:
    match = re.search(rf'["\']?{re.escape(field)}["\']?\s*[:=]\s*["\']([^"\']+)["\']', text)
    return match.group(1).strip() if match else ""


def parse_app_bundle_name(workspace: Path) -> str:
    app_json = workspace / "AppScope" / "app.json5"
    if not app_json.exists():
        raise PackagerError(f"缺少 AppScope/app.json5: {app_json}")
    bundle_name = extract_string_field(read_text(app_json), "bundleName")
    if not bundle_name:
        raise PackagerError("无法从 AppScope/app.json5 读取 bundleName")
    return bundle_name


def parse_product_name(workspace: Path) -> str:
    profile = workspace / "build-profile.json5"
    if not profile.exists():
        raise PackagerError(f"缺少 build-profile.json5: {profile}")
    text = read_text(profile)
    product = extract_string_field(text, "name")
    return product or "default"


def parse_compatible_sdk(workspace: Path) -> str:
    profile = workspace / "build-profile.json5"
    if not profile.exists():
        return ""
    return extract_string_field(read_text(profile), "compatibleSdkVersion")


def decode_json_string(value: str) -> str:
    try:
        return json.loads(f'"{value}"')
    except json.JSONDecodeError:
        return value.replace("\\n", "\n")


def normalize_pem_certificate(pem: str) -> str:
    match = re.search(
        r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----",
        pem,
        re.S,
    )
    if not match:
        raise PackagerError("无法读取证书 PEM 内容")
    return match.group(0)


def certificate_fingerprint_from_pem(pem: str) -> str:
    normalized = normalize_pem_certificate(pem)
    der = ssl.PEM_cert_to_DER_cert(normalized)
    digest = hashlib.sha256(der).hexdigest().upper()
    return ":".join(digest[index:index + 2] for index in range(0, len(digest), 2))


def certificate_fingerprint_from_file(cert_path: Path) -> str:
    return certificate_fingerprint_from_pem(read_text(cert_path))


def extract_profile_distribution_certificate(text: str) -> str:
    match = re.search(
        r'["\']distribution-certificate["\']\s*:\s*["\']((?:\\.|[^"\'])+)["\']',
        text,
        re.S,
    )
    if not match:
        return ""
    return decode_json_string(match.group(1))


def parse_profile(profile_path: Path) -> dict[str, object]:
    if not profile_path.exists():
        raise PackagerError(f"Profile 不存在: {profile_path}")
    text = profile_path.read_bytes().decode("utf-8", errors="ignore")
    bundle_name = extract_string_field(text, "bundle-name")
    distribution_type = extract_string_field(text, "app-distribution-type")
    profile_type = extract_string_field(text, "type")
    distribution_certificate = extract_profile_distribution_certificate(text)
    distribution_certificate_fingerprint = ""
    if distribution_certificate:
        distribution_certificate_fingerprint = certificate_fingerprint_from_pem(distribution_certificate)
    device_ids: list[str] = []
    match = re.search(r'["\']device-ids["\']\s*:\s*\[(.*?)\]', text, re.S)
    if match:
        device_ids = re.findall(r'["\']([^"\']+)["\']', match.group(1))
    return {
        "bundle_name": bundle_name,
        "distribution_type": distribution_type,
        "type": profile_type,
        "device_ids": device_ids,
        "distribution_certificate_fingerprint": distribution_certificate_fingerprint,
    }


def ensure_profile_cert_matches(profile_info: dict[str, object], cert: Path) -> None:
    profile_fingerprint = str(profile_info.get("distribution_certificate_fingerprint") or "")
    if not profile_fingerprint:
        raise PackagerError("Profile 缺少 distribution-certificate，无法校验证书匹配")
    cert_fingerprint = certificate_fingerprint_from_file(cert)
    if profile_fingerprint != cert_fingerprint:
        raise PackagerError(
            "Profile 绑定证书与 --cert 不匹配: "
            f"profile={profile_fingerprint}, cert={cert_fingerprint}, cert_path={cert}"
        )


def ensure_hvigor_wrapper(workspace: Path, hvigorw_path: str) -> None:
    wrapper = workspace / "hvigorw"
    if wrapper.exists():
        return
    wrapper.write_text(
        "#!/usr/bin/env sh\n"
        f'exec "{hvigorw_path}" "$@"\n',
        encoding="utf-8",
    )
    wrapper.chmod(0o755)


def ensure_hpack_dir(workspace: Path, hpack_bin: str, env: dict[str, str]) -> None:
    hpack_dir = workspace / "hpack"
    if hpack_dir.exists():
        return
    run_command([hpack_bin, "init"], workspace, env, [])


def copy_signing_files(sign_dir: Path, cert: Path, profile: Path, keystore: Path) -> dict[str, str]:
    sign_dir.mkdir(parents=True, exist_ok=True)
    targets = {
        "cert": sign_dir / "release.cer",
        "profile": sign_dir / "release.p7b",
        "keystore": sign_dir / "release.p12",
    }
    shutil.copy2(cert, targets["cert"])
    shutil.copy2(profile, targets["profile"])
    shutil.copy2(keystore, targets["keystore"])
    return {key: value.name for key, value in targets.items()}


def write_config(
    workspace: Path,
    *,
    deploy_domain: str,
    base_url: str,
    app_icon_url: str,
    app_name: str,
    alias: str,
    key_pwd: str,
    keystore_pwd: str,
    sign_files: dict[str, str],
    product: str,
    hvigorw_path: str,
) -> None:
    config_path = workspace / "hpack" / "config.py"
    content = f"""# -*- coding: utf-8 -*-
import os


class Config:
    DeployDomain = {deploy_domain!r}
    BaseURL = {base_url!r}

    AppIcon = {app_icon_url!r}
    AppName = {app_name!r}
    Badge = "鸿蒙版"
    IndexTemplate = "default"

    Alias = {alias!r}
    KeyPwd = {key_pwd!r}
    KeystorePwd = {keystore_pwd!r}
    SignDir = "sign"
    Cert = os.path.join(SignDir, {sign_files["cert"]!r})
    Profile = os.path.join(SignDir, {sign_files["profile"]!r})
    Keystore = os.path.join(SignDir, {sign_files["keystore"]!r})

    Product = {product!r}
    Debug = False
    HvigorwCommand = [
        {hvigorw_path!r},
        "assembleHap",
        "--mode",
        "module",
        "-p",
        "product={product}",
        "-p",
        "debuggable=false",
        "--no-daemon",
    ]

    HistoryBtn = False
    HistoryBtnTitle = "历史版本"
    HistoryBtnUrl = ""
"""
    config_path.write_text(content, encoding="utf-8")


def run_command(command: list[str], cwd: Path, env: dict[str, str], secrets: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=str(cwd),
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    result.stdout = redact(result.stdout or "", secrets)
    if result.returncode != 0:
        raise PackagerError(
            f"命令执行失败 exit_code={result.returncode}: "
            f"{redact(' '.join(command), secrets)}\n{result.stdout[-4000:]}"
        )
    return result


def rebuild_unsigned_hap(
    workspace: Path,
    *,
    hvigorw_path: str,
    product: str,
    env: dict[str, str],
    secrets: list[str],
) -> Path:
    """Build the unsigned HAP again after UI QA and before HPack signs it."""
    run_command(
        [
            hvigorw_path,
            "assembleHap",
            "--mode",
            "module",
            "-p",
            f"product={product}",
            "-p",
            "debuggable=false",
            "--no-daemon",
        ],
        workspace,
        env,
        secrets,
    )
    hap_path = workspace / UNSIGNED_HAP_RELATIVE_PATH
    if not hap_path.is_file():
        raise PackagerError(f"重新构建后未生成 unsigned HAP: {hap_path}")
    return hap_path


def ensure_app_icon(workspace: Path, static_hpack_root: Path) -> None:
    icon = static_hpack_root / "assets" / "AppIcon.png"
    if icon.exists():
        return
    icon.parent.mkdir(parents=True, exist_ok=True)
    for candidate in (
        workspace / "AppScope" / "resources" / "base" / "media" / "foreground.png",
        workspace / "AppScope" / "resources" / "base" / "media" / "background.png",
    ):
        if candidate.is_file():
            shutil.copy2(candidate, icon)
            return
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return
    image = Image.new("RGB", (256, 256), "#2563eb")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((28, 28, 228, 228), radius=44, fill="#ffffff")
    draw.rounded_rectangle((70, 70, 186, 186), radius=28, fill="#111827")
    image.save(icon)


def publish_build(build_dir: Path, static_hpack_root: Path, remote_dir: str) -> Path:
    if not build_dir.is_dir():
        raise PackagerError(f"HPack build 目录不存在: {build_dir}")
    dest = static_hpack_root / remote_dir
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(build_dir, dest)
    return dest


def extract_remote_dir_from_manifest(manifest_path: Path) -> str:
    text = read_text(manifest_path)
    try:
        manifest = json.loads(text)
        modules = ((manifest.get("app") or {}).get("modules") or [])
        for module in modules:
            package_url = str((module or {}).get("packageUrl") or "")
            match = re.search(r"https://[^/]+/(?:[^/]+/)*([^/]+)/[^/\"']+?\.hap", package_url)
            if match:
                return match.group(1)
    except json.JSONDecodeError:
        pass
    match = re.search(r'["\']packageUrl["\']\s*:\s*["\']https://[^/]+/(?:[^/]+/)*([^/]+)/[^/"\']+?\.hap', text)
    if not match:
        raise PackagerError(f"无法从 manifest 提取 remote_dir: {manifest_path}")
    return match.group(1)


def check_url(url: str, timeout: float = 8.0) -> dict[str, object]:
    request = Request(url, method="HEAD")
    try:
        with urlopen(request, timeout=timeout) as response:
            return {
                "ok": 200 <= response.status < 400,
                "status": response.status,
                "content_length": response.headers.get("Content-Length", ""),
                "accept_ranges": response.headers.get("Accept-Ranges", ""),
            }
    except URLError as exc:
        return {"ok": False, "error": str(exc)}


def build_env(java_home: str, workspace: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["JAVA_HOME"] = java_home
    path_parts = [
        str(workspace),
        str(Path(java_home) / "bin"),
        env.get("PATH", ""),
    ]
    env["PATH"] = os.pathsep.join(part for part in path_parts if part)
    return env


def package(args: argparse.Namespace) -> dict[str, object]:
    workspace = Path(args.workspace).expanduser().resolve()
    if not workspace.is_dir():
        raise PackagerError(f"workspace 不存在: {workspace}")

    cert = Path(args.cert).expanduser().resolve()
    profile = Path(args.profile).expanduser().resolve()
    keystore = Path(args.keystore).expanduser().resolve()
    for required in [cert, profile, keystore]:
        if not required.is_file():
            raise PackagerError(f"签名文件不存在: {required}")

    app_bundle = parse_app_bundle_name(workspace)
    product = args.product or parse_product_name(workspace)
    compatible_sdk = parse_compatible_sdk(workspace)
    profile_info = parse_profile(profile)
    profile_bundle = str(profile_info.get("bundle_name") or "")
    if profile_bundle and profile_bundle != app_bundle:
        raise PackagerError(f"bundleName 不匹配: app={app_bundle}, profile={profile_bundle}")
    if profile_info.get("distribution_type") and profile_info.get("distribution_type") != "internaltesting":
        raise PackagerError(f"Profile 不是 internaltesting: {profile_info.get('distribution_type')}")
    ensure_profile_cert_matches(profile_info, cert)

    static_hpack_root = Path(args.static_root).expanduser().resolve()
    base_url = args.base_url.rstrip("/")
    deploy_domain = args.deploy_domain.strip() or re.sub(r"^https?://", "", base_url).split("/", 1)[0]
    app_icon_url = f"{base_url}/assets/AppIcon.png"
    secrets = [args.key_pwd, args.keystore_pwd]
    env = build_env(args.java_home, workspace)

    ensure_hvigor_wrapper(workspace, args.hvigorw)
    ensure_hpack_dir(workspace, args.hpack_bin, env)
    ensure_app_icon(workspace, static_hpack_root)
    sign_files = copy_signing_files(workspace / "hpack" / "sign", cert, profile, keystore)
    write_config(
        workspace,
        deploy_domain=deploy_domain,
        base_url=base_url,
        app_icon_url=app_icon_url,
        app_name=args.app_name or app_bundle.rsplit(".", 1)[-1],
        alias=args.alias,
        key_pwd=args.key_pwd,
        keystore_pwd=args.keystore_pwd,
        sign_files=sign_files,
        product=product,
        hvigorw_path=args.hvigorw,
    )

    # UI QA may have consumed an older artifact. Always rebuild from the final
    # workspace state before invoking HPack, whose `pr` command signs/releases it.
    rebuilt_hap = rebuild_unsigned_hap(
        workspace,
        hvigorw_path=args.hvigorw,
        product=product,
        env=env,
        secrets=secrets,
    )
    run_command([args.hpack_bin, "pr", args.desc], workspace, env, secrets)

    build_dir = workspace / "hpack" / "build" / product
    manifest_path = build_dir / "manifest.json5"
    if not manifest_path.exists():
        raise PackagerError(f"HPack manifest 不存在: {manifest_path}")
    remote_dir = extract_remote_dir_from_manifest(manifest_path)
    published_dir = publish_build(build_dir, static_hpack_root, remote_dir)

    install_url = f"{base_url}/{remote_dir}/index.html"
    manifest_url = f"{base_url}/{remote_dir}/manifest.json5"
    install_store_url = f"store://enterprise/manifest?url={quote(manifest_url, safe='')}"
    signed_haps = sorted(published_dir.glob("*.hap"))
    signed_hap_url = f"{base_url}/{remote_dir}/{signed_haps[0].name}" if signed_haps else ""
    checks = {
        "index": check_url(install_url) if args.check_urls else {"skipped": True},
        "manifest": check_url(manifest_url) if args.check_urls else {"skipped": True},
        "hap": check_url(signed_hap_url) if args.check_urls and signed_hap_url else {"skipped": True},
    }

    return {
        "status": "ready",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "workspace": str(workspace),
        "bundle_name": app_bundle,
        "profile": profile_info,
        "product": product,
        "compatible_sdk": compatible_sdk,
        "rebuilt_unsigned_hap_path": str(rebuilt_hap),
        "rebuilt_unsigned_hap_mtime_ns": rebuilt_hap.stat().st_mtime_ns,
        "remote_dir": remote_dir,
        "published_dir": str(published_dir),
        "install_url": install_url,
        "manifest_url": manifest_url,
        "install_store_url": install_store_url,
        "app_icon_url": app_icon_url,
        "signed_hap_path": str(signed_haps[0]) if signed_haps else "",
        "signed_hap_url": signed_hap_url,
        "checks": checks,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Package a HarmonyOS project with HPack and publish install assets.")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--desc", default="Harmony Pilot 扫码安装")
    parser.add_argument("--hpack-bin", default=os.environ.get("HP_HPACK_BIN", DEFAULT_HPACK_BIN))
    parser.add_argument("--java-home", default=os.environ.get("HP_DEVECO_JAVA_HOME", DEFAULT_JAVA_HOME))
    parser.add_argument("--hvigorw", default=os.environ.get("HP_HVIGORW", DEFAULT_HVIGORW))
    parser.add_argument("--base-url", default=os.environ.get("HP_HPACK_BASE_URL", ""))
    parser.add_argument("--deploy-domain", default=os.environ.get("HP_HPACK_DEPLOY_DOMAIN", ""))
    parser.add_argument("--static-root", default=os.environ.get("HP_HPACK_STATIC_ROOT", ""))
    parser.add_argument("--cert", default=os.environ.get("HP_HPACK_CERT", ""))
    parser.add_argument("--profile", default=os.environ.get("HP_HPACK_PROFILE", ""))
    parser.add_argument("--keystore", default=os.environ.get("HP_HPACK_KEYSTORE", ""))
    parser.add_argument("--alias", default=os.environ.get("HP_HPACK_ALIAS", ""))
    parser.add_argument("--key-pwd", default=os.environ.get("HP_HPACK_KEY_PASSWORD", ""))
    parser.add_argument("--keystore-pwd", default=os.environ.get("HP_HPACK_KEYSTORE_PASSWORD", ""))
    parser.add_argument("--app-name", default=os.environ.get("HP_HPACK_APP_NAME", ""))
    parser.add_argument("--product", default=os.environ.get("HP_HPACK_PRODUCT", ""))
    parser.add_argument("--check-urls", action="store_true", default=os.environ.get("HP_HPACK_CHECK_URLS", "") == "1")
    args = parser.parse_args()

    missing = [
        name
        for name in ["base_url", "static_root", "cert", "profile", "keystore", "alias", "key_pwd", "keystore_pwd"]
        if not getattr(args, name)
    ]
    if missing:
        raise PackagerError(f"缺少 HPack 配置: {', '.join(missing)}")
    return args


def main() -> int:
    try:
        args = parse_args()
        result = package(args)
    except Exception as exc:
        output = Path(sys.argv[sys.argv.index("--output") + 1]).expanduser() if "--output" in sys.argv else None
        payload = {
            "status": "failed",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "error": str(exc),
        }
        if output:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
        return 1

    output_path = Path(args.output).expanduser()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
