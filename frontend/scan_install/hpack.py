from __future__ import annotations

import mimetypes
import os
import subprocess
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from scan_install.config import (
    APP_ROOT,
    CAPTURE_POLL_INTERVAL_SEC,
    DEFAULT_ARTIFACTS_DIR,
    EXPECTED_HAP_RELATIVE_PATH,
    HPACK_ENABLED,
    HPACK_PACKAGER_SCRIPT_PATH,
    HPACK_PYTHON_BIN,
    HPACK_WAIT_TIMEOUT_SEC,
    LOG_DIR,
)
from scan_install.profile_pool import get_signing_pool
from scan_install.time_utils import parse_iso


def build_install_store_url(manifest_url: str) -> str:
    manifest_url = manifest_url.strip()
    if not manifest_url:
        return ""
    return f"store://enterprise/manifest?url={quote(manifest_url, safe='')}"


def install_qr_use_store_scheme() -> bool:
    return os.environ.get("HP_INSTALL_QR_USE_STORE", "0").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def build_install_qr_content(
    *,
    install_url: str = "",
    install_store_url: str = "",
    manifest_url: str = "",
) -> str:
    """Pick QR payload. Default HTTPS install page (system camera friendly)."""
    install_url = install_url.strip()
    store_url = install_store_url.strip() or build_install_store_url(manifest_url)
    if install_qr_use_store_scheme():
        return store_url or install_url
    return install_url or store_url


def content_type_for_path(file_path: Path) -> str:
    suffix = file_path.suffix.lower()
    if suffix == ".json5":
        return "application/json; charset=utf-8"
    if suffix == ".hap":
        return "application/octet-stream"
    return mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"


def hpack_run_dir(run_id: str) -> Path:
    return DEFAULT_ARTIFACTS_DIR / "hpack" / run_id


def hpack_manifest_path(run_id: str) -> Path:
    return hpack_run_dir(run_id) / "hpack-result.json"


def load_hpack_manifest(run_id: str, *, read_json: Callable[[Path], dict[str, Any] | None]) -> dict[str, Any] | None:
    return read_json(hpack_manifest_path(run_id))


def build_hpack_command(record: Any) -> list[str]:
    command = [
        HPACK_PYTHON_BIN,
        str(HPACK_PACKAGER_SCRIPT_PATH),
        "--workspace",
        record.workspace,
        "--run-id",
        record.run_id,
        "--output",
        str(hpack_manifest_path(record.run_id)),
        "--desc",
        f"Harmony Pilot {record.run_id[:8]} 扫码安装",
    ]
    if record.signing_cert_path:
        command.extend(["--cert", record.signing_cert_path])
    if record.signing_profile_path:
        command.extend(["--profile", record.signing_profile_path])
    if record.signing_keystore_path:
        command.extend(["--keystore", record.signing_keystore_path])
    if record.signing_alias:
        command.extend(["--alias", record.signing_alias])
    return command


def summarize_hpack_events(hpack_manifest: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not hpack_manifest:
        return []
    status = hpack_manifest.get("status")
    if status == "ready":
        return [
            {
                "kind": "distribution",
                "timestamp": hpack_manifest.get("created_at"),
                "summary": f"扫码安装页已生成: {hpack_manifest.get('install_url')}",
            }
        ]
    if status == "failed":
        return [
            {
                "kind": "distribution",
                "timestamp": hpack_manifest.get("created_at"),
                "summary": f"扫码安装生成失败: {hpack_manifest.get('error') or '未知错误'}",
            }
        ]
    return []


def serve_hpack_static(
    static_root: Path,
    path: str,
    *,
    prefix: str,
    send_file: Callable[..., None],
    send_file_head: Callable[..., None],
    send_error: Callable[..., None],
    head_only: bool = False,
) -> None:
    relative = path.removeprefix(prefix)
    file_path = (static_root / relative).resolve()
    try:
        file_path.relative_to(static_root)
    except ValueError:
        send_error(403, "Forbidden")
        return
    if head_only:
        send_file_head(file_path)
    else:
        send_file(file_path)


def wait_for_hap_and_package(
    record: Any,
    *,
    find_latest_hap: Callable[[Path, str | None], Path | None],
    load_ui_qa_status: Callable[[Path, str], str],
    load_run: Callable[[str], Any | None],
    save_run: Callable[[Any], Any],
    maybe_release_signing_slot: Callable[[Any], None],
    read_json: Callable[[Path], dict[str, Any] | None],
) -> None:
    workspace = Path(record.workspace)
    if not HPACK_ENABLED:
        latest = load_run(record.run_id)
        if latest:
            latest.distribution_status = "disabled"
            save_run(latest)
        return
    if not HPACK_PACKAGER_SCRIPT_PATH.exists():
        latest = load_run(record.run_id)
        if latest:
            latest.distribution_status = "failed"
            latest.notes = f"hpack_packager.py 不存在: {HPACK_PACKAGER_SCRIPT_PATH}"
            save_run(latest)
        return

    def load_manifest(run_id: str) -> dict[str, Any] | None:
        return load_hpack_manifest(run_id, read_json=read_json)

    started_at = time.monotonic()
    while time.monotonic() - started_at < HPACK_WAIT_TIMEOUT_SEC:
        latest = load_run(record.run_id)
        if not latest:
            return
        hpack_manifest = load_manifest(latest.run_id)
        if hpack_manifest and hpack_manifest.get("status") == "ready":
            latest.distribution_status = "ready"
            latest.distribution_process_pid = None
            save_run(latest)
            return
        if latest.distribution_status in {"packaging", "ready", "failed", "disabled"}:
            return

        hap_path = find_latest_hap(workspace, latest.created_at)
        if not hap_path:
            time.sleep(CAPTURE_POLL_INTERVAL_SEC)
            continue

        ui_qa = load_ui_qa_status(workspace, str(latest.session_name or ""))
        if ui_qa in {"failed", "error", "cancelled", "canceled"}:
            latest.distribution_status = "failed"
            latest.distribution_process_pid = None
            latest.notes = f"UI QA 未通过（status={ui_qa}），已阻止生成扫码安装页。"
            save_run(latest)
            maybe_release_signing_slot(latest)
            return
        if ui_qa not in {"complete", "disabled"}:
            time.sleep(CAPTURE_POLL_INTERVAL_SEC)
            continue

        if record.signing_bundle_name:
            try:
                from scan_install.profile_pool import sync_record_bundle_to_workspace

                sync_record_bundle_to_workspace(latest)
            except Exception as exc:  # noqa: BLE001
                latest.distribution_status = "failed"
                latest.notes = f"签名前对齐 bundleName 失败: {exc}"
                save_run(latest)
                maybe_release_signing_slot(latest)
                return

        command = build_hpack_command(latest)
        latest.distribution_status = "packaging"
        latest.distribution_command = command
        save_run(latest)
        log_path = LOG_DIR / f"{latest.run_id}.hpack.log"
        log_stream = None
        exit_code = 1
        try:
            log_stream = log_path.open("ab")
            log_stream.write(f"$ {' '.join(command)}\n".encode("utf-8", errors="ignore"))
            log_stream.flush()
            process = subprocess.Popen(
                command,
                cwd=str(APP_ROOT),
                stdout=log_stream,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            latest.distribution_process_pid = process.pid
            latest.notes = f"已检测到 HAP，开始生成扫码安装页。日志: {log_path}"
            save_run(latest)
            exit_code = process.wait()
        except OSError as exc:
            latest = load_run(record.run_id) or latest
            latest.distribution_status = "failed"
            latest.distribution_process_pid = None
            latest.notes = f"启动 HPack 打包失败: {exc}"
            save_run(latest)
            return
        finally:
            if log_stream is not None and not log_stream.closed:
                log_stream.close()

        latest = load_run(record.run_id) or latest
        latest.distribution_process_pid = None
        hpack_manifest = load_manifest(latest.run_id)
        if exit_code == 0 and hpack_manifest and hpack_manifest.get("status") == "ready":
            latest.distribution_status = "ready"
            latest.notes = f"扫码安装页已生成: {hpack_manifest.get('install_url')}"
            pool = get_signing_pool()
            if pool:
                ready_at = parse_iso(str(hpack_manifest.get("created_at") or ""))
                pool.mark_install_ready(latest.run_id, ready_at)
        else:
            latest.distribution_status = "failed"
            latest.notes = (
                f"扫码安装生成失败: {hpack_manifest.get('error') if hpack_manifest else f'exit_code={exit_code}'}"
            )
        save_run(latest)
        maybe_release_signing_slot(latest)
        return

    latest = load_run(record.run_id)
    if latest and latest.distribution_status not in {"ready", "failed", "disabled"}:
        latest.distribution_status = "failed"
        latest.notes = f"等待 HAP 超时，未生成扫码安装页。超时 {int(HPACK_WAIT_TIMEOUT_SEC)} 秒。"
        save_run(latest)
        maybe_release_signing_slot(latest)
