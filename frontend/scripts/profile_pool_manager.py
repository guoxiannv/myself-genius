from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import sys
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from hpack_packager import parse_profile  # noqa: E402


class ProfilePoolError(Exception):
    pass


SigningPoolError = ProfilePoolError


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_iso(dt: datetime | None = None) -> str:
    return (dt or utc_now()).isoformat()


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def resolve_config_path(config_dir: Path, value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    path = Path(value).expanduser()
    if path.is_absolute():
        return str(path)
    return str((config_dir / path).resolve())


def sync_app_bundle_name(workspace: Path, bundle_name: str) -> None:
    app_json = workspace / "AppScope" / "app.json5"
    if not app_json.is_file():
        raise ProfilePoolError(f"缺少 AppScope/app.json5: {app_json}")
    text = app_json.read_text(encoding="utf-8")
    if not re.search(r'["\']bundleName["\']\s*:', text):
        raise ProfilePoolError("AppScope/app.json5 中未找到 bundleName")
    updated, count = re.subn(
        r'(["\']bundleName["\']\s*:\s*["\'])([^"\']+)(["\'])',
        rf"\g<1>{bundle_name}\g<3>",
        text,
        count=1,
    )
    if count == 0:
        raise ProfilePoolError(f"无法更新 bundleName: {app_json}")
    if updated != text:
        app_json.write_text(updated, encoding="utf-8")


@dataclass
class SlotConfig:
    id: str
    cert: str
    profile: str
    keystore: str
    alias: str = ""
    key_pwd: str = ""
    keystore_pwd: str = ""
    cert_inherited: bool = False

    def resolved_bundle_name(self) -> str:
        profile_path = Path(self.profile)
        if not profile_path.is_file():
            return ""
        info = parse_profile(profile_path)
        return str(info.get("bundle_name") or "")

    def readiness(self) -> tuple[bool, str]:
        profile_path = Path(self.profile)
        if not profile_path.is_file():
            return False, f"Profile 不存在: {profile_path}"
        if self.cert_inherited:
            return False, "slot 必须显式配置 cert，避免 profile 继承错误证书后手机无法验证应用"
        try:
            bundle_name = self.resolved_bundle_name()
        except Exception as exc:  # noqa: BLE001
            return False, f"解析 Profile 失败: {exc}"
        if not bundle_name:
            return False, f"Profile 中未找到 bundle-name: {profile_path}"
        for label, path_str in [("cert", self.cert), ("keystore", self.keystore)]:
            path = Path(path_str)
            if not path.is_file():
                return False, f"{label} 不存在: {path}"
        if not self.alias:
            return False, "缺少 alias（在 defaults 或 slot 中配置）"
        return True, ""


@dataclass
class LeaseRecord:
    slot_id: str
    run_id: str
    session_name: str = ""
    leased_at: str = ""
    expires_at: str = ""
    release_after_ready_at: str = ""


@dataclass
class SlotStatus:
    id: str
    bundle_name: str
    state: str
    run_id: str = ""
    session_name: str = ""
    leased_at: str = ""
    expires_at: str = ""
    release_available_at: str = ""
    release_reason: str = ""


@dataclass
class PoolConfig:
    lease_timeout_sec: int = 7200
    release_after_ready_sec: int = 1800
    slots: list[SlotConfig] = field(default_factory=list)


def default_signing_material(payload: dict[str, Any], config_dir: Path) -> dict[str, str]:
    defaults = payload.get("defaults") or {}
    return {
        "cert": resolve_config_path(
            config_dir, str(defaults.get("cert") or os.environ.get("HP_HPACK_CERT", ""))
        ),
        "keystore": resolve_config_path(
            config_dir, str(defaults.get("keystore") or os.environ.get("HP_HPACK_KEYSTORE", ""))
        ),
        "alias": str(defaults.get("alias") or os.environ.get("HP_HPACK_ALIAS", "")).strip(),
        "key_pwd": str(defaults.get("key_pwd") or os.environ.get("HP_HPACK_KEY_PASSWORD", "")).strip(),
        "keystore_pwd": str(
            defaults.get("keystore_pwd") or os.environ.get("HP_HPACK_KEYSTORE_PASSWORD", "")
        ).strip(),
    }


def load_slots_from_payload(payload: dict[str, Any], config_dir: Path) -> list[SlotConfig]:
    shared = default_signing_material(payload, config_dir)
    slots: list[SlotConfig] = []
    for index, item in enumerate(payload.get("slots") or [], start=1):
        if isinstance(item, str):
            item = {"profile": item}
        if not isinstance(item, dict):
            continue
        slot_id = str(item.get("id") or f"slot-{index:02d}").strip()
        profile = resolve_config_path(config_dir, str(item.get("profile") or ""))
        if not profile:
            continue
        cert_value = str(item.get("cert") or "")
        slots.append(
            SlotConfig(
                id=slot_id,
                cert=resolve_config_path(config_dir, cert_value or shared["cert"]),
                profile=profile,
                keystore=resolve_config_path(config_dir, str(item.get("keystore") or shared["keystore"])),
                alias=str(item.get("alias") or shared["alias"]).strip(),
                key_pwd=str(item.get("key_pwd") or shared["key_pwd"]).strip(),
                keystore_pwd=str(item.get("keystore_pwd") or shared["keystore_pwd"]).strip(),
                cert_inherited=not bool(cert_value),
            )
        )
    return slots


class ProfilePool:
    def __init__(self, config_path: Path, state_path: Path) -> None:
        self.config_path = config_path.expanduser().resolve()
        self.state_path = state_path.expanduser().resolve()
        self.config_dir = self.config_path.parent
        self._config: PoolConfig | None = None

    @property
    def enabled(self) -> bool:
        return self.config_path.is_file()

    def load_config(self) -> PoolConfig:
        if self._config is not None:
            return self._config
        if not self.config_path.is_file():
            raise ProfilePoolError(f"Profile pool 配置不存在: {self.config_path}")
        payload = json.loads(self.config_path.read_text(encoding="utf-8"))
        slots = load_slots_from_payload(payload, self.config_dir)
        if not slots:
            raise ProfilePoolError("Profile pool 配置中没有可用 slot（每个 slot 至少填写 profile 路径）")
        self._config = PoolConfig(
            lease_timeout_sec=int(payload.get("lease_timeout_sec") or 7200),
            release_after_ready_sec=int(payload.get("release_after_ready_sec") or 1800),
            slots=slots,
        )
        return self._config

    @contextmanager
    def _locked_state(self) -> Iterator[dict[str, Any]]:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        with self.state_path.open("a+", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            handle.seek(0)
            raw = handle.read().strip()
            if raw:
                try:
                    state = json.loads(raw)
                except json.JSONDecodeError:
                    state = {"version": 1, "leases": {}}
            else:
                state = {"version": 1, "leases": {}}
            state.setdefault("leases", {})
            try:
                yield state
            finally:
                handle.seek(0)
                handle.truncate()
                handle.write(json.dumps(state, ensure_ascii=False, indent=2))
                handle.flush()
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _slot_map(self) -> dict[str, SlotConfig]:
        return {slot.id: slot for slot in self.load_config().slots}

    def _leases(self, state: dict[str, Any]) -> dict[str, Any]:
        leases = state.get("leases")
        if not isinstance(leases, dict):
            leases = {}
            state["leases"] = leases
        return leases

    def cleanup_stale(self) -> list[str]:
        config = self.load_config()
        now = utc_now()
        freed: list[str] = []
        with self._locked_state() as state:
            leases = self._leases(state)
            for slot_id, lease in list(leases.items()):
                expires_at = parse_iso(str(lease.get("expires_at") or ""))
                release_after_ready_at = parse_iso(str(lease.get("release_after_ready_at") or ""))
                should_free = False
                if expires_at and expires_at <= now:
                    should_free = True
                elif release_after_ready_at and release_after_ready_at <= now:
                    should_free = True
                if should_free:
                    leases.pop(slot_id, None)
                    freed.append(slot_id)
        return freed

    def acquire(self, run_id: str, session_name: str = "") -> SlotConfig | None:
        config = self.load_config()
        now = utc_now()
        with self._locked_state() as state:
            leases = self._leases(state)
            for lease in leases.values():
                if str(lease.get("run_id") or "") == run_id:
                    slot_id = str(lease.get("slot_id") or "")
                    slot = self._slot_map().get(slot_id)
                    if slot:
                        return slot
            for slot in config.slots:
                if slot.id in leases:
                    continue
                ready, _reason = slot.readiness()
                if not ready:
                    continue
                expires_at = now + timedelta(seconds=config.lease_timeout_sec)
                leases[slot.id] = {
                    "slot_id": slot.id,
                    "run_id": run_id,
                    "session_name": session_name,
                    "bundle_name": slot.resolved_bundle_name(),
                    "leased_at": to_iso(now),
                    "expires_at": to_iso(expires_at),
                    "release_after_ready_at": "",
                }
                return slot
        return None

    def release(self, run_id: str) -> bool:
        released = False
        with self._locked_state() as state:
            leases = self._leases(state)
            for slot_id, lease in list(leases.items()):
                if str(lease.get("run_id") or "") == run_id:
                    leases.pop(slot_id, None)
                    released = True
        return released

    def mark_install_ready(self, run_id: str, ready_at: datetime | None = None) -> bool:
        config = self.load_config()
        ready_time = ready_at or utc_now()
        updated = False
        with self._locked_state() as state:
            leases = self._leases(state)
            for lease in leases.values():
                if str(lease.get("run_id") or "") != run_id:
                    continue
                if lease.get("release_after_ready_at"):
                    updated = True
                    break
                release_at = ready_time + timedelta(seconds=config.release_after_ready_sec)
                lease["release_after_ready_at"] = to_iso(release_at)
                updated = True
                break
        return updated

    def get_lease(self, run_id: str) -> LeaseRecord | None:
        with self._locked_state() as state:
            leases = self._leases(state)
            for lease in leases.values():
                if str(lease.get("run_id") or "") == run_id:
                    return LeaseRecord(
                        slot_id=str(lease.get("slot_id") or ""),
                        run_id=run_id,
                        session_name=str(lease.get("session_name") or ""),
                        leased_at=str(lease.get("leased_at") or ""),
                        expires_at=str(lease.get("expires_at") or ""),
                        release_after_ready_at=str(lease.get("release_after_ready_at") or ""),
                    )
        return None

    def status(self) -> dict[str, Any]:
        config = self.load_config()
        now = utc_now()
        leases_by_slot: dict[str, dict[str, Any]] = {}
        with self._locked_state() as state:
            for slot_id, lease in self._leases(state).items():
                leases_by_slot[slot_id] = lease

        slots: list[dict[str, Any]] = []
        free_count = 0
        invalid_count = 0
        for slot in config.slots:
            lease = leases_by_slot.get(slot.id)
            bundle_name = slot.resolved_bundle_name()
            ready, reason = slot.readiness()
            if not lease:
                if ready:
                    free_count += 1
                    state_label = "free"
                else:
                    state_label = "invalid"
                    invalid_count += 1
                slots.append(
                    asdict(
                        SlotStatus(
                            id=slot.id,
                            bundle_name=bundle_name,
                            state=state_label,
                            release_reason=reason if not ready else "",
                        )
                    )
                )
                continue

            expires_at = parse_iso(str(lease.get("expires_at") or ""))
            release_after_ready_at = parse_iso(str(lease.get("release_after_ready_at") or ""))
            release_available_at = ""
            release_reason = ""
            if release_after_ready_at:
                release_available_at = to_iso(release_after_ready_at)
                release_reason = "install_ready_grace"
            elif expires_at:
                release_available_at = to_iso(expires_at)
                release_reason = "lease_timeout"

            if release_available_at and parse_iso(release_available_at) and parse_iso(release_available_at) <= now:
                state_label = "releasable"
            else:
                state_label = "in_use"

            slots.append(
                asdict(
                    SlotStatus(
                        id=slot.id,
                        bundle_name=bundle_name,
                        state=state_label,
                        run_id=str(lease.get("run_id") or ""),
                        session_name=str(lease.get("session_name") or ""),
                        leased_at=str(lease.get("leased_at") or ""),
                        expires_at=str(lease.get("expires_at") or ""),
                        release_available_at=release_available_at,
                        release_reason=release_reason,
                    )
                )
            )

        return {
            "enabled": True,
            "config_path": str(self.config_path),
            "state_path": str(self.state_path),
            "lease_timeout_sec": config.lease_timeout_sec,
            "release_after_ready_sec": config.release_after_ready_sec,
            "total_slots": len(config.slots),
            "free_slots": free_count,
            "invalid_slots": invalid_count,
            "in_use_slots": len(leases_by_slot),
            "slots": slots,
        }

    def validate(self) -> dict[str, Any]:
        config = self.load_config()
        results: list[dict[str, Any]] = []
        for slot in config.slots:
            ready, reason = slot.readiness()
            bundle_name = ""
            profile_info: dict[str, object] = {}
            profile_path = Path(slot.profile)
            if profile_path.is_file():
                try:
                    bundle_name = slot.resolved_bundle_name()
                    profile_info = parse_profile(profile_path)
                except Exception as exc:  # noqa: BLE001
                    reason = reason or str(exc)
            item: dict[str, Any] = {
                "id": slot.id,
                "ok": ready,
                "bundle_name": bundle_name,
                "profile": slot.profile,
                "distribution_type": profile_info.get("distribution_type"),
                "device_count": len(profile_info.get("device_ids") or []),
                "errors": [] if ready else [reason],
            }
            results.append(item)
        ready_slots = [entry for entry in results if entry["ok"]]
        bundle_names = [entry["bundle_name"] for entry in ready_slots if entry.get("bundle_name")]
        duplicate_bundle_names = sorted(
            {name for name in bundle_names if bundle_names.count(name) > 1}
        )
        warnings: list[str] = []
        if duplicate_bundle_names:
            warnings.append(
                "多个 slot 解析到相同 bundleName，同一设备上只能安装其中一个 App（后装覆盖）："
                + ", ".join(duplicate_bundle_names)
            )
        return {
            "ok": bool(ready_slots),
            "ready_slots": len(ready_slots),
            "total_slots": len(results),
            "duplicate_bundle_names": duplicate_bundle_names,
            "warnings": warnings,
            "slots": results,
        }


SigningPool = ProfilePool


def env_flag(name: str, fallback: str = "auto") -> str:
    return os.environ.get(name, os.environ.get(name.replace("PROFILE", "SIGNING"), fallback)).strip().lower()


def default_deploy_dir(app_root: Path) -> Path:
    return app_root / "deploy"


def default_profile_pool_config(app_root: Path) -> Path:
    override = os.environ.get("HP_PROFILE_POOL_CONFIG") or os.environ.get("HP_SIGNING_POOL_CONFIG", "")
    if override.strip():
        path = Path(override).expanduser()
        return path if path.is_absolute() else (app_root / path).resolve()
    return (default_deploy_dir(app_root) / "profile-pool.json").resolve()


def default_profile_pool_state(app_root: Path) -> Path:
    override = os.environ.get("HP_PROFILE_POOL_STATE") or os.environ.get("HP_SIGNING_POOL_STATE", "")
    if override.strip():
        path = Path(override).expanduser()
        return path if path.is_absolute() else (app_root / path).resolve()
    return (default_deploy_dir(app_root) / "profile-pool-state.json").resolve()


def build_pool_from_env(app_root: Path) -> ProfilePool | None:
    flag = env_flag("HP_PROFILE_POOL_ENABLED")
    config_path = default_profile_pool_config(app_root)
    if flag in {"0", "false", "no", "off"}:
        return None
    if flag not in {"1", "true", "yes", "on"} and not config_path.is_file():
        return None
    pool = ProfilePool(config_path=config_path, state_path=default_profile_pool_state(app_root))
    if not pool.enabled:
        return None
    return pool


def main() -> int:
    app_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Manage HarmonyOS profile pool (free slot + bundleName).")
    parser.add_argument("--config", default=str(default_profile_pool_config(app_root)))
    parser.add_argument("--state", default=str(default_profile_pool_state(app_root)))
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("status", help="Show free/in-use slots and release ETA")
    subparsers.add_parser("cleanup", help="Release expired leases")
    subparsers.add_parser("validate", help="Validate slot signing files")

    acquire_parser = subparsers.add_parser("acquire", help="Acquire a slot for testing")
    acquire_parser.add_argument("--run-id", required=True)
    acquire_parser.add_argument("--session-name", default="")

    release_parser = subparsers.add_parser("release", help="Release a slot by run_id")
    release_parser.add_argument("--run-id", required=True)

    args = parser.parse_args()
    pool = ProfilePool(config_path=Path(args.config), state_path=Path(args.state))
    if not pool.enabled:
        print(json.dumps({"error": f"配置不存在: {args.config}"}, ensure_ascii=False), file=sys.stderr)
        return 1

    if args.command == "status":
        pool.cleanup_stale()
        print(json.dumps(pool.status(), ensure_ascii=False, indent=2))
        return 0
    if args.command == "cleanup":
        freed = pool.cleanup_stale()
        print(json.dumps({"freed_slots": freed}, ensure_ascii=False, indent=2))
        return 0
    if args.command == "validate":
        result = pool.validate()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 1
    if args.command == "acquire":
        slot = pool.acquire(args.run_id, args.session_name)
        if not slot:
            print(json.dumps({"error": "没有空闲 Profile"}, ensure_ascii=False), file=sys.stderr)
            return 1
        print(
            json.dumps(
                {"slot_id": slot.id, "bundle_name": slot.resolved_bundle_name(), "run_id": args.run_id},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    if args.command == "release":
        released = pool.release(args.run_id)
        print(json.dumps({"released": released, "run_id": args.run_id}, ensure_ascii=False, indent=2))
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
