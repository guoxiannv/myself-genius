from __future__ import annotations

import os
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable

from scan_install.config import (
    PROFILE_POOL_CONFIG_PATH,
    PROFILE_POOL_ENABLED,
    PROFILE_POOL_SCRIPT_PATH,
    PROFILE_POOL_STATE_PATH,
)
from scan_install.time_utils import parse_iso, to_iso, utc_now

_PROFILE_POOL: Any = None


def get_profile_pool():
    global _PROFILE_POOL
    if _PROFILE_POOL is not None:
        return _PROFILE_POOL if _PROFILE_POOL is not False else None
    if not PROFILE_POOL_ENABLED or not PROFILE_POOL_SCRIPT_PATH.exists():
        _PROFILE_POOL = False
        return None
    script_dir = str(PROFILE_POOL_SCRIPT_PATH.parent)
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)
    try:
        from profile_pool_manager import ProfilePool
    except ImportError:
        _PROFILE_POOL = False
        return None
    if not PROFILE_POOL_CONFIG_PATH.is_file():
        _PROFILE_POOL = False
        return None
    _PROFILE_POOL = ProfilePool(
        config_path=PROFILE_POOL_CONFIG_PATH,
        state_path=PROFILE_POOL_STATE_PATH,
    )
    return _PROFILE_POOL


get_signing_pool = get_profile_pool


def apply_signing_slot_to_record(record: Any, slot: Any) -> None:
    bundle_name = slot.resolved_bundle_name()
    if not bundle_name:
        raise ValueError(f"无法从 Profile 解析 bundleName: {slot.profile}")
    record.signing_slot_id = slot.id
    record.signing_bundle_name = bundle_name
    record.signing_cert_path = str(Path(slot.cert).expanduser())
    record.signing_profile_path = str(Path(slot.profile).expanduser())
    record.signing_keystore_path = str(Path(slot.keystore).expanduser())
    record.signing_alias = slot.alias or os.environ.get("HP_HPACK_ALIAS", "")
    record.signing_leased_at = to_iso()
    record.signing_released_at = ""


def sync_record_bundle_to_workspace(record: Any) -> None:
    if not record.signing_bundle_name:
        return
    script_dir = str(PROFILE_POOL_SCRIPT_PATH.parent)
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)
    from profile_pool_manager import sync_app_bundle_name

    sync_app_bundle_name(Path(record.workspace), record.signing_bundle_name)


def release_signing_slot_for_record(record: Any) -> bool:
    pool = get_signing_pool()
    if not pool or not record.signing_slot_id or record.signing_released_at:
        return False
    released = pool.release(record.run_id)
    if released:
        record.signing_released_at = to_iso()
    return released


def build_tmux_env(record: Any) -> dict[str, str]:
    env = os.environ.copy()
    env["ARKPILOT_INTERACTIVE_QUESTIONS"] = "1" if record.interactive_questions else "0"
    if record.signing_bundle_name:
        env["ARKPILOT_BUNDLE_NAME"] = record.signing_bundle_name
    else:
        env.pop("ARKPILOT_BUNDLE_NAME", None)
    return env


def build_signing_payload(record: Any) -> dict[str, Any]:
    pool = get_signing_pool()
    lease_info = None
    if pool and record.signing_slot_id and not record.signing_released_at:
        lease = pool.get_lease(record.run_id)
        if lease:
            lease_info = asdict(lease)
    return {
        "pool_enabled": bool(pool),
        "slot_id": record.signing_slot_id,
        "bundle_name": record.signing_bundle_name,
        "leased_at": record.signing_leased_at,
        "released_at": record.signing_released_at,
        "lease": lease_info,
    }


def profile_pool_status_payload() -> dict[str, Any]:
    pool = get_profile_pool()
    if not pool:
        return {
            "enabled": False,
            "reason": "HP_PROFILE_POOL_ENABLED=0 或缺少 deploy/profile-pool.json",
        }
    pool.cleanup_stale()
    return pool.status()


signing_pool_status_payload = profile_pool_status_payload


def maybe_release_signing_slot(
    record: Any,
    *,
    process_alive: Callable[[int | None], bool],
    load_hpack_manifest: Callable[[str], dict[str, Any] | None],
    save_run: Callable[[Any], Any],
) -> None:
    pool = get_signing_pool()
    if not pool or not record.signing_slot_id or record.signing_released_at:
        return

    pool.cleanup_stale()
    hpack_manifest = load_hpack_manifest(record.run_id)

    if record.distribution_status == "ready" and hpack_manifest:
        ready_at = parse_iso(str(hpack_manifest.get("created_at") or ""))
        pool.mark_install_ready(record.run_id, ready_at)

    should_release = False
    if (
        process_alive(record.process_pid)
        or process_alive(record.capture_process_pid)
        or process_alive(record.distribution_process_pid)
    ):
        return
    if record.status == "failed":
        should_release = True
    elif record.distribution_status in {"failed", "disabled"}:
        should_release = True
    elif record.distribution_status == "ready":
        lease = pool.get_lease(record.run_id)
        release_after_ready_at = parse_iso(lease.release_after_ready_at if lease else None)
        if release_after_ready_at and release_after_ready_at <= utc_now():
            should_release = True

    if should_release and release_signing_slot_for_record(record):
        save_run(record)
