#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENV = APP_ROOT / "deploy" / "server.env"
LOCAL_ENV = APP_ROOT / ".env.local"
LOCAL_DEPS = APP_ROOT / ".venv" / "deps"
if LOCAL_DEPS.is_dir():
    sys.path.insert(0, str(LOCAL_DEPS))


def load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def env_path() -> Path:
    return Path(os.environ.get("HP_REMOTE_UI_ENV", str(DEFAULT_ENV))).expanduser().resolve()


def resolve_app_path(value: str) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path.resolve()
    return (APP_ROOT / path).resolve()


def resolve_runner_path(value: str, runner_root: Path) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path.resolve()
    return (runner_root / path).resolve()


def exists_file(path: str) -> bool:
    return bool(path) and Path(path).expanduser().is_file()


def exists_dir(path: str) -> bool:
    return bool(path) and Path(path).expanduser().is_dir()


def executable_path(value: str) -> str:
    if not value:
        return ""
    expanded = str(Path(value).expanduser()) if value.startswith(("~", "/")) else value
    return expanded if Path(expanded).is_file() else (shutil.which(value) or "")


def node_version(executable: str) -> tuple[int, int] | None:
    if not executable:
        return None
    try:
        result = subprocess.run(
            [executable, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except OSError:
        return None
    match = re.search(r"v(\d+)\.(\d+)", result.stdout)
    return (int(match.group(1)), int(match.group(2))) if result.returncode == 0 and match else None


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="ignore")


def field(text: str, name: str) -> str:
    match = re.search(rf'["\']?{re.escape(name)}["\']?\s*[:=]\s*["\']([^"\']+)["\']', text)
    return match.group(1).strip() if match else ""


def check(label: str, ok: bool, detail: str = "") -> bool:
    mark = "OK" if ok else "MISSING"
    suffix = f" - {detail}" if detail else ""
    print(f"[{mark}] {label}{suffix}")
    return ok


def main() -> int:
    env_file = env_path()
    load_env_file(DEFAULT_ENV)
    load_env_file(env_file)
    if LOCAL_ENV.is_file():
        load_env_file(LOCAL_ENV)

    failures = 0
    print(f"Preflight env: {DEFAULT_ENV}")
    failures += not check("deploy/server.env", DEFAULT_ENV.is_file(), str(DEFAULT_ENV))

    for module in ["qrcode", "PIL"]:
        failures += not check(f"python module {module}", importlib.util.find_spec(module) is not None)

    runner_value = os.environ.get("HP_TMUX_RUNNER", "").strip()
    runner = resolve_app_path(runner_value) if runner_value else Path()
    workspace_value = os.environ.get("HP_TARGET_WORKSPACE", "").strip()
    workspace = resolve_app_path(workspace_value) if workspace_value else Path()
    failures += not check("HP_TMUX_RUNNER", runner.is_file(), str(runner) if runner_value else "")
    failures += not check("HP_TARGET_WORKSPACE", workspace.is_dir(), str(workspace) if workspace_value else "")

    expo_root_value = os.environ.get("HP_EXPO_FAST_ROOT", "").strip()
    expo_root = resolve_app_path(expo_root_value) if expo_root_value else Path()
    expo_app_root_value = os.environ.get("HP_EXPO_FAST_APP_ROOT", "").strip()
    expo_app_root = resolve_app_path(expo_app_root_value) if expo_app_root_value else Path()
    expo_env_value = os.environ.get("HP_EXPO_FAST_ENV_FILE", "").strip()
    expo_env_file = resolve_app_path(expo_env_value) if expo_env_value else None
    failures += not check("HP_EXPO_FAST_ROOT", expo_root.is_dir(), str(expo_root) if expo_root_value else "")
    failures += not check(
        "Expo Runner launcher",
        bool(expo_root_value) and (expo_root / "start-livetest.sh").is_file(),
        str(expo_root / "start-livetest.sh") if expo_root_value else "",
    )
    failures += not check(
        "HP_EXPO_FAST_APP_ROOT parent",
        bool(expo_app_root_value) and expo_app_root.parent.is_dir(),
        str(expo_app_root) if expo_app_root_value else "",
    )
    if expo_env_file is not None:
        failures += not check("HP_EXPO_FAST_ENV_FILE", expo_env_file.is_file(), str(expo_env_file))
        load_env_file(expo_env_file)

    node_value = os.environ.get("EXPO_FAST_NODE", "node").strip() or "node"
    node_executable = executable_path(node_value)
    version = node_version(node_executable)
    failures += not check(
        "Expo Runner Node >=22.13",
        version is not None and version >= (22, 13),
        f"{node_executable or node_value} ({'.'.join(map(str, version)) if version else 'unknown'})",
    )
    sdk_value = os.environ.get("EXPO_HARMONY_SDK_ROOT", "").strip()
    sdk_root = resolve_runner_path(sdk_value, expo_root) if sdk_value and expo_root_value else Path()
    failures += not check("EXPO_HARMONY_SDK_ROOT", sdk_root.is_dir(), str(sdk_root) if sdk_value else "")
    cache_value = os.environ.get("EXPO_FAST_MODULE_CACHE", "").strip()
    for index, value in enumerate(filter(None, cache_value.split(os.pathsep)), start=1):
        cache = resolve_runner_path(value, expo_root)
        failures += not check(f"EXPO_FAST_MODULE_CACHE[{index}]", cache.is_dir(), str(cache))

    hdc = os.environ.get("HDC_PATH", "") or "/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc"
    failures += not check("hdc", bool(executable_path(hdc)), hdc)
    hpack = os.environ.get("HP_HPACK_BIN", "hpack")
    if "/" in hpack and not Path(hpack).expanduser().is_absolute():
        hpack = str(resolve_app_path(hpack))
    failures += not check("hpack", bool(executable_path(hpack)), hpack)
    hvigorw = os.environ.get("HP_HVIGORW", "/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw")
    failures += not check("hvigorw", bool(executable_path(hvigorw)), hvigorw)
    java_home = os.environ.get("HP_DEVECO_JAVA_HOME", "/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home")
    failures += not check("JAVA_HOME", exists_dir(java_home), java_home)
    check("ffmpeg for preview video", bool(shutil.which("ffmpeg")), shutil.which("ffmpeg") or "optional for install QR")

    if workspace:
        root = Path(workspace).expanduser()
        app_json = root / "AppScope" / "app.json5"
        build_profile = root / "build-profile.json5"
        hap = root / "entry" / "build" / "default" / "outputs" / "default" / "entry-default-unsigned.hap"
        check("AppScope/app.json5", app_json.is_file(), str(app_json))
        check("build-profile.json5", build_profile.is_file(), str(build_profile))
        check("unsigned HAP", hap.is_file(), str(hap))
        if app_json.is_file():
            bundle = field(read_text(app_json), "bundleName")
            check("bundleName", bool(bundle), bundle or "not found")
        if build_profile.is_file():
            product = field(read_text(build_profile), "name") or "default"
            check("product", bool(product), product)

    hpack_enabled = os.environ.get("HP_HPACK_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}
    failures += not check("HP_HPACK_ENABLED", hpack_enabled, os.environ.get("HP_HPACK_ENABLED", ""))

    pool_config = resolve_app_path(
        os.environ.get("HP_PROFILE_POOL_CONFIG")
        or os.environ.get("HP_SIGNING_POOL_CONFIG")
        or "deploy/profile-pool.json"
    )
    pool_state = resolve_app_path(
        os.environ.get("HP_PROFILE_POOL_STATE")
        or os.environ.get("HP_SIGNING_POOL_STATE")
        or "deploy/profile-pool-state.json"
    )
    pool_flag = (
        os.environ.get("HP_PROFILE_POOL_ENABLED")
        or os.environ.get("HP_SIGNING_POOL_ENABLED")
        or "auto"
    ).strip().lower()
    pool_enabled = pool_flag in {"1", "true", "yes", "on"} or (
        pool_flag not in {"0", "false", "no", "off"} and pool_config.is_file()
    )

    if pool_enabled:
        failures += not check("profile pool config", pool_config.is_file(), str(pool_config))
        if pool_config.is_file():
            sys.path.insert(0, str(APP_ROOT / "scripts"))
            try:
                from profile_pool_manager import ProfilePool

                pool = ProfilePool(config_path=pool_config, state_path=pool_state)
                validation = pool.validate()
                failures += not check(
                    "profile pool ready slots",
                    validation.get("ready_slots", 0) >= 1,
                    f"{validation.get('ready_slots', 0)}/{validation.get('total_slots', 0)} slots ready",
                )
                for slot in validation.get("slots") or []:
                    mark = "OK" if slot.get("ok") else "MISSING"
                    detail = slot.get("bundle_name") or "; ".join(slot.get("errors") or [])
                    print(f"[{mark}] pool {slot.get('id')} bundleName={detail}")
                for warning in validation.get("warnings") or []:
                    print(f"[WARN] {warning}")
            except Exception as exc:  # noqa: BLE001
                failures += not check("profile pool validate", False, str(exc))
        failures += not check("HP_HPACK_ALIAS", bool(os.environ.get("HP_HPACK_ALIAS", "")))
        failures += not check("HP_HPACK_KEYSTORE_PASSWORD", bool(os.environ.get("HP_HPACK_KEYSTORE_PASSWORD", "")))
        failures += not check("HP_HPACK_KEY_PASSWORD", bool(os.environ.get("HP_HPACK_KEY_PASSWORD", "")))
        for name in ["HP_HPACK_BASE_URL", "HP_HPACK_STATIC_ROOT"]:
            value = os.environ.get(name, "")
            ok = bool(value)
            display = value
            if name == "HP_HPACK_STATIC_ROOT" and value:
                static_root = resolve_app_path(value)
                static_root.mkdir(parents=True, exist_ok=True)
                display = str(static_root)
            failures += not check(name, ok, display)
    else:
        for name in [
            "HP_HPACK_BASE_URL",
            "HP_HPACK_STATIC_ROOT",
            "HP_HPACK_CERT",
            "HP_HPACK_PROFILE",
            "HP_HPACK_KEYSTORE",
            "HP_HPACK_ALIAS",
            "HP_HPACK_KEYSTORE_PASSWORD",
            "HP_HPACK_KEY_PASSWORD",
        ]:
            value = os.environ.get(name, "")
            if name in {"HP_HPACK_CERT", "HP_HPACK_PROFILE", "HP_HPACK_KEYSTORE"}:
                ok = exists_file(value)
            elif name == "HP_HPACK_STATIC_ROOT":
                ok = bool(value)
                if value:
                    static_root = resolve_app_path(value)
                    static_root.mkdir(parents=True, exist_ok=True)
                    value = str(static_root)
            else:
                ok = bool(value)
            display = "***" if "PASSWORD" in name or name.endswith("_KEY_PASSWORD") else value
            failures += not check(name, ok, display)

    print()
    if failures:
        print(f"Preflight failed: {failures} required item(s) need attention.")
        return 1
    print("Preflight passed. You can run: scripts/restart_dev.sh")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
