#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import os
import re
import shutil
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


def exists_file(path: str) -> bool:
    return bool(path) and Path(path).expanduser().is_file()


def exists_dir(path: str) -> bool:
    return bool(path) and Path(path).expanduser().is_dir()


def executable_path(value: str) -> str:
    if not value:
        return ""
    expanded = str(Path(value).expanduser()) if value.startswith(("~", "/")) else value
    return expanded if Path(expanded).is_file() else (shutil.which(value) or "")


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

    runner = os.environ.get("HP_TMUX_RUNNER", "")
    workspace = os.environ.get("HP_TARGET_WORKSPACE", "")
    failures += not check("HP_TMUX_RUNNER", exists_file(runner), runner)
    failures += not check("HP_TARGET_WORKSPACE", exists_dir(workspace), workspace)

    hdc = os.environ.get("HDC_PATH", "") or "/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc"
    failures += not check("hdc", bool(executable_path(hdc)), hdc)
    hpack = os.environ.get("HP_HPACK_BIN", "hpack")
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

    def resolve_app_path(value: str) -> Path:
        path = Path(value).expanduser()
        if path.is_absolute():
            return path.resolve()
        return (APP_ROOT / path).resolve()

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
            if name == "HP_HPACK_STATIC_ROOT" and value:
                Path(value).expanduser().mkdir(parents=True, exist_ok=True)
            failures += not check(name, ok, value)
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
                Path(value).expanduser().mkdir(parents=True, exist_ok=True) if value else None
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
