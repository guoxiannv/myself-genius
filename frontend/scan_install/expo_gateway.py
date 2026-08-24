from __future__ import annotations

import json
import mimetypes
import os
import re
import secrets
import threading
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlparse


TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{24,128}$")
RUN_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")


class ExpoGatewayError(RuntimeError):
    pass


class ExpoExportValidationError(ExpoGatewayError):
    pass


@dataclass(frozen=True)
class ExpoPublication:
    run_id: str
    token: str
    artifact_root: str
    published_at: str
    public: bool = True


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def path_is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def resolve_export_file(root: Path, url_path: str) -> Path:
    value = str(url_path or "")
    if not value or "\\" in value:
        raise ExpoExportValidationError(f"Harmony Go artifact path is invalid: {value or '<empty>'}")
    parts = value.lstrip("/").split("/")
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise ExpoExportValidationError(f"Harmony Go artifact path is invalid: {value}")
    candidate = (root / Path(*parts)).resolve()
    if not path_is_within(candidate, root):
        raise ExpoExportValidationError(f"Harmony Go artifact escapes the export root: {value}")
    return candidate


def read_json_file(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ExpoExportValidationError(f"Unable to read {label}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ExpoExportValidationError(f"Invalid {label}: {exc}") from exc


def validate_harmony_go_export(artifact_root: Path, allowed_root: Path | None) -> dict[str, Any]:
    root = artifact_root.expanduser().resolve()
    if allowed_root is None:
        raise ExpoExportValidationError("HP_EXPO_FAST_APP_ROOT is not configured")
    allowed = allowed_root.expanduser().resolve()
    if not path_is_within(root, allowed):
        raise ExpoExportValidationError("Harmony Go export is outside HP_EXPO_FAST_APP_ROOT")
    if not root.is_dir():
        raise ExpoExportValidationError(f"Harmony Go export directory does not exist: {root}")
    if not (root / ".expo-harmony-go-export").is_file():
        raise ExpoExportValidationError("Harmony Go export marker is missing")
    if not (root / "runtime.json").is_file():
        raise ExpoExportValidationError("Harmony Go runtime.json is missing")

    catalog_path = root / "catalog.json"
    catalog = read_json_file(catalog_path, "catalog.json")
    if not isinstance(catalog, list) or not catalog:
        raise ExpoExportValidationError("Harmony Go catalog.json must contain at least one app")

    checked_files = {catalog_path.resolve(), (root / "runtime.json").resolve()}
    for entry in catalog:
        if not isinstance(entry, dict):
            raise ExpoExportValidationError("Harmony Go catalog entry must be an object")
        app_id = str(entry.get("id") or "").strip()
        if not app_id:
            raise ExpoExportValidationError("Harmony Go catalog entry is missing id")
        manifest_path = resolve_export_file(root, str(entry.get("manifestUrl") or ""))
        if not manifest_path.is_file():
            raise ExpoExportValidationError(f"Harmony Go manifest is missing for {app_id}")
        checked_files.add(manifest_path)
        manifest = read_json_file(manifest_path, f"manifest for {app_id}")
        if not isinstance(manifest, dict) or str(manifest.get("id") or "") != app_id:
            raise ExpoExportValidationError(f"Harmony Go manifest id does not match catalog entry {app_id}")

        resources: list[tuple[str, dict[str, Any]]] = []
        bundle = manifest.get("bundle")
        if not isinstance(bundle, dict):
            raise ExpoExportValidationError(f"Harmony Go manifest bundle is invalid for {app_id}")
        resources.append(("bundle", bundle))
        assets = manifest.get("assets") or []
        if not isinstance(assets, list):
            raise ExpoExportValidationError(f"Harmony Go manifest assets are invalid for {app_id}")
        for index, asset in enumerate(assets):
            if not isinstance(asset, dict):
                raise ExpoExportValidationError(f"Harmony Go asset {index} is invalid for {app_id}")
            resources.append((f"asset {index}", asset))

        for label, resource in resources:
            resource_path = resolve_export_file(root, str(resource.get("url") or ""))
            if not resource_path.is_file():
                raise ExpoExportValidationError(f"Harmony Go {label} is missing for {app_id}")
            expected_bytes = resource.get("bytes")
            if not isinstance(expected_bytes, int) or expected_bytes < 0:
                raise ExpoExportValidationError(f"Harmony Go {label} size is invalid for {app_id}")
            if resource_path.stat().st_size != expected_bytes:
                raise ExpoExportValidationError(f"Harmony Go {label} size does not match for {app_id}")
            checked_files.add(resource_path)

    return {
        "artifact_root": str(root),
        "app_count": len(catalog),
        "file_count": len(checked_files),
    }


def validate_expo_web_export(artifact_root: Path, allowed_root: Path | None) -> dict[str, Any]:
    root = artifact_root.expanduser().resolve()
    if allowed_root is None:
        raise ExpoExportValidationError("HP_EXPO_FAST_APP_ROOT is not configured")
    allowed = allowed_root.expanduser().resolve()
    if not path_is_within(root, allowed):
        raise ExpoExportValidationError("Expo web export is outside HP_EXPO_FAST_APP_ROOT")
    if not root.is_dir():
        raise ExpoExportValidationError(f"Expo web export directory does not exist: {root}")

    marker_path = root / ".expo-web-export.json"
    if not marker_path.is_file():
        raise ExpoExportValidationError("Expo web export marker is missing")
    marker = read_json_file(marker_path, "Expo web export marker")
    if not isinstance(marker, dict) or marker.get("schemaVersion") != 1 or marker.get("status") != "ready":
        raise ExpoExportValidationError("Expo web export marker is invalid")
    if marker.get("entryPoint") != "index.html":
        raise ExpoExportValidationError("Expo web export entry point is invalid")

    entry_path = root / "index.html"
    if not entry_path.is_file():
        raise ExpoExportValidationError("Expo web export index.html is missing")
    javascript_files = []
    for candidate in root.rglob("*.js"):
        resolved = candidate.resolve()
        if not path_is_within(resolved, root):
            raise ExpoExportValidationError("Expo web export contains a file outside its root")
        if resolved.is_file():
            javascript_files.append(resolved)
    if not javascript_files:
        raise ExpoExportValidationError("Expo web export JavaScript bundle is missing")
    return {
        "artifact_root": str(root),
        "entry_point": str(entry_path),
        "javascript_file_count": len(javascript_files),
        "exported_at": str(marker.get("exportedAt") or marker_path.stat().st_mtime_ns),
    }


def expo_web_root(publication: ExpoPublication) -> Path:
    return Path(publication.artifact_root).resolve().parent / "web"


class ExpoPublicationRegistry:
    def __init__(self, state_path: Path, allowed_root: Path | None) -> None:
        self.state_path = state_path.expanduser().resolve()
        self.allowed_root = allowed_root.expanduser().resolve() if allowed_root else None
        self._lock = threading.RLock()
        self._publications: dict[str, ExpoPublication] = {}
        self._load()

    def _load(self) -> None:
        if not self.state_path.is_file():
            return
        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        rows = payload.get("publications") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            return
        loaded: dict[str, ExpoPublication] = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            try:
                publication = ExpoPublication(
                    run_id=str(row["run_id"]),
                    token=str(row["token"]),
                    artifact_root=str(row["artifact_root"]),
                    published_at=str(row["published_at"]),
                    public=bool(row.get("public", True)),
                )
            except (KeyError, TypeError):
                continue
            if not RUN_ID_PATTERN.fullmatch(publication.run_id) or not TOKEN_PATTERN.fullmatch(publication.token):
                continue
            try:
                validate_harmony_go_export(Path(publication.artifact_root), self.allowed_root)
            except ExpoExportValidationError:
                continue
            loaded[publication.run_id] = publication
        self._publications = loaded

    def _save(self) -> None:
        payload = {
            "schema_version": 1,
            "updated_at": utc_now(),
            "publications": [asdict(item) for item in self._publications.values()],
        }
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix(f"{self.state_path.suffix}.tmp-{os.getpid()}")
        try:
            temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.replace(self.state_path)
        except OSError as exc:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            raise ExpoGatewayError(f"Unable to persist Expo publication state: {exc}") from exc

    def get(self, run_id: str) -> ExpoPublication | None:
        with self._lock:
            return self._publications.get(run_id)

    def find_by_token(self, token: str) -> ExpoPublication | None:
        with self._lock:
            for publication in self._publications.values():
                if publication.public and secrets.compare_digest(publication.token, token):
                    return publication
        return None

    def publications(self) -> list[ExpoPublication]:
        with self._lock:
            return sorted(
                self._publications.values(),
                key=lambda publication: (publication.published_at, publication.run_id),
            )

    def aggregate_catalog(self) -> list[dict[str, Any]]:
        entries: dict[str, dict[str, Any]] = {}
        for publication in self.publications():
            root = Path(publication.artifact_root).resolve()
            try:
                validate_harmony_go_export(root, self.allowed_root)
                catalog = read_json_file(root / "catalog.json", "catalog.json")
            except ExpoExportValidationError:
                continue
            for entry in catalog:
                if not isinstance(entry, dict):
                    continue
                app_id = str(entry.get("id") or "").strip()
                if app_id:
                    entries[app_id] = entry
        return [entries[app_id] for app_id in sorted(entries)]

    def resolve_aggregate_file(self, relative: str) -> Path | None:
        requested = str(relative or "").lstrip("/")
        if not requested:
            return None
        # aggregate_catalog() also resolves duplicate app ids to the newest
        # registration, so file lookup must use the same newest-first order.
        publications = list(reversed(self.publications()))
        for publication in publications:
            root = Path(publication.artifact_root).resolve()
            try:
                candidate = resolve_export_file(root, requested)
                if self.allowed_root is None or not path_is_within(root, self.allowed_root):
                    continue
            except ExpoExportValidationError:
                continue
            if candidate.is_file():
                return candidate
        return None

    def _register(
        self,
        run_id: str,
        artifact_root: Path,
        *,
        make_public: bool,
    ) -> tuple[ExpoPublication, bool, dict[str, Any]]:
        if not RUN_ID_PATTERN.fullmatch(run_id):
            raise ExpoGatewayError("Invalid Expo run id")
        validation = validate_harmony_go_export(artifact_root, self.allowed_root)
        root = str(artifact_root.expanduser().resolve())
        with self._lock:
            current = self._publications.get(run_id)
            if current and current.artifact_root == root and (current.public or not make_public):
                return current, False, validation
            existing_tokens = {item.token for item in self._publications.values()}
            token = current.token if current else secrets.token_urlsafe(24)
            while not current and token in existing_tokens:
                token = secrets.token_urlsafe(24)
            publication = ExpoPublication(
                run_id=run_id,
                token=token,
                artifact_root=root,
                published_at=utc_now(),
                public=bool(make_public or current and current.public),
            )
            self._publications[run_id] = publication
            try:
                self._save()
            except ExpoGatewayError:
                if current is None:
                    self._publications.pop(run_id, None)
                else:
                    self._publications[run_id] = current
                raise
            return publication, True, validation

    def register_local(self, run_id: str, artifact_root: Path) -> tuple[ExpoPublication, bool, dict[str, Any]]:
        return self._register(run_id, artifact_root, make_public=False)

    def publish(self, run_id: str, artifact_root: Path) -> tuple[ExpoPublication, bool, dict[str, Any]]:
        return self._register(run_id, artifact_root, make_public=True)

    def unpublish(self, run_id: str) -> bool:
        with self._lock:
            current = self._publications.get(run_id)
            if current is not None and current.public:
                unpublished = ExpoPublication(
                    run_id=current.run_id,
                    token=current.token,
                    artifact_root=current.artifact_root,
                    published_at=current.published_at,
                    public=False,
                )
                self._publications[run_id] = unpublished
                try:
                    self._save()
                except ExpoGatewayError:
                    self._publications[run_id] = current
                    raise
                return True
            return False

    def unregister(self, run_id: str) -> bool:
        with self._lock:
            removed = self._publications.pop(run_id, None)
            if removed is None:
                return False
            try:
                self._save()
            except ExpoGatewayError:
                self._publications[run_id] = removed
                raise
            return True


def content_type_for_path(path: Path) -> str:
    overrides = {
        ".json": "application/json; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".map": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
    }
    return overrides.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def gateway_handler(registry: ExpoPublicationRegistry) -> type[BaseHTTPRequestHandler]:
    class ExpoGatewayHandler(BaseHTTPRequestHandler):
        server_version = "ExpoHarmonyGateway/1.0"

        def do_GET(self) -> None:
            self._serve(head_only=False)

        def do_HEAD(self) -> None:
            self._serve(head_only=True)

        def do_POST(self) -> None:
            self._publish()

        def do_DELETE(self) -> None:
            self._unpublish()

        def do_OPTIONS(self) -> None:
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _send_json(self, payload: dict[str, Any], status: HTTPStatus, *, head_only: bool = False) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

        def _send_json_value(self, payload: Any, status: HTTPStatus, *, head_only: bool = False) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

        def _send_file(self, file_path: Path, *, head_only: bool) -> None:
            try:
                size = file_path.stat().st_size
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type_for_path(file_path))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(size))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                if not head_only:
                    with file_path.open("rb") as stream:
                        while chunk := stream.read(1024 * 1024):
                            self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError, OSError):
                return

        def _read_json_body(self) -> dict[str, Any]:
            try:
                length = int(self.headers.get("Content-Length") or "0")
            except ValueError as exc:
                raise ExpoGatewayError("Invalid Content-Length") from exc
            if length <= 0 or length > 64 * 1024:
                raise ExpoGatewayError("Invalid request body size")
            try:
                payload = json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                raise ExpoGatewayError("Invalid JSON body") from exc
            if not isinstance(payload, dict):
                raise ExpoGatewayError("JSON body must be an object")
            return payload

        def _publish(self) -> None:
            if urlparse(self.path).path != "/internal/publications":
                self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
                return
            try:
                payload = self._read_json_body()
                publication, created, validation = registry.register_local(
                    str(payload.get("run_id") or ""),
                    Path(str(payload.get("artifact_root") or "")),
                )
            except (ExpoGatewayError, ExpoExportValidationError) as exc:
                self._send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
                return
            self._send_json(
                {
                    "ok": True,
                    "created": created,
                    "publication": asdict(publication),
                    "validation": validation,
                    "catalog_path": "/catalog.json",
                },
                HTTPStatus.CREATED if created else HTTPStatus.OK,
            )

        def _unpublish(self) -> None:
            pathname = urlparse(self.path).path
            match = re.fullmatch(r"/internal/publications/([a-f0-9]{32})", pathname)
            if not match:
                self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
                return
            try:
                removed = registry.unregister(match.group(1))
            except ExpoGatewayError as exc:
                self._send_json({"error": str(exc)}, HTTPStatus.SERVICE_UNAVAILABLE)
                return
            self._send_json({"ok": True, "removed": removed}, HTTPStatus.OK)

        def _serve(self, *, head_only: bool) -> None:
            try:
                pathname = unquote(urlparse(self.path).path)
            except ValueError:
                self._send_json({"error": "Malformed URL"}, HTTPStatus.BAD_REQUEST, head_only=head_only)
                return
            if pathname == "/health":
                self._send_json(
                    {
                        "ok": True,
                        "service": "expo-harmony-gateway",
                        "publication_count": len(registry.publications()),
                    },
                    HTTPStatus.OK,
                    head_only=head_only,
                )
                return
            if pathname in {"/", "/catalog.json"}:
                self._send_json_value(registry.aggregate_catalog(), HTTPStatus.OK, head_only=head_only)
                return
            if pathname == "/runtime.json" or pathname.startswith("/miniapps/"):
                aggregate_file = registry.resolve_aggregate_file(pathname)
                if aggregate_file is None:
                    self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND, head_only=head_only)
                    return
                self._send_file(aggregate_file, head_only=head_only)
                return
            parts = pathname.lstrip("/").split("/")
            if len(parts) < 2 or parts[0] != "p" or not TOKEN_PATTERN.fullmatch(parts[1]):
                self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND, head_only=head_only)
                return
            publication = registry.find_by_token(parts[1])
            if publication is None:
                self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND, head_only=head_only)
                return
            relative = "/".join(parts[2:]) or "catalog.json"
            try:
                if relative == "web" or relative.startswith("web/"):
                    root = expo_web_root(publication)
                    validate_expo_web_export(root, registry.allowed_root)
                    web_relative = relative.removeprefix("web/") if relative != "web" else ""
                    file_path = resolve_export_file(root, web_relative or "index.html")
                else:
                    root = Path(publication.artifact_root).resolve()
                    file_path = resolve_export_file(root, relative)
                if registry.allowed_root is None or not path_is_within(root, registry.allowed_root):
                    raise ExpoExportValidationError("Publication root is not allowed")
            except ExpoExportValidationError:
                self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND, head_only=head_only)
                return
            if not file_path.is_file():
                self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND, head_only=head_only)
                return
            self._send_file(file_path, head_only=head_only)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    return ExpoGatewayHandler


class ExpoPublicGateway:
    def __init__(
        self,
        *,
        enabled: bool,
        host: str,
        port: int,
        public_origin: str,
        state_path: Path,
        allowed_root: Path | None,
    ) -> None:
        self.enabled = enabled
        self.host = host
        self.port = port
        self.public_origin = public_origin.rstrip("/")
        self.registry = ExpoPublicationRegistry(state_path, allowed_root)
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._start_error = ""
        self._lock = threading.RLock()

    @property
    def running(self) -> bool:
        with self._lock:
            return bool(self._server and self._thread and self._thread.is_alive())

    @property
    def bound_port(self) -> int:
        with self._lock:
            return int(self._server.server_address[1]) if self._server else self.port

    def start(self) -> bool:
        with self._lock:
            if not self.enabled:
                return False
            if self.running:
                return True
            try:
                server = ThreadingHTTPServer((self.host, self.port), gateway_handler(self.registry))
            except OSError as exc:
                self._start_error = str(exc)
                return False
            thread = threading.Thread(target=server.serve_forever, name="expo-public-gateway", daemon=True)
            self._server = server
            self._thread = thread
            self._start_error = ""
            thread.start()
            return True

    def stop(self) -> None:
        with self._lock:
            server = self._server
            thread = self._thread
            self._server = None
            self._thread = None
        if server:
            server.shutdown()
            server.server_close()
        if thread and thread is not threading.current_thread():
            thread.join(timeout=5)

    def local_origin(self) -> str:
        host = "127.0.0.1" if self.host in {"0.0.0.0", "::"} else self.host
        return f"http://{host}:{self.bound_port}"

    def health(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "running": self.running,
            "host": self.host,
            "port": self.bound_port,
            "local_origin": self.local_origin(),
            "public_origin": self.public_origin,
            "error": self._start_error,
        }

    def describe(self, run_id: str, *, can_publish: bool) -> dict[str, Any]:
        publication = self.registry.get(run_id)
        base = {
            **self.health(),
            "status": "stopped",
            "can_publish": bool(can_publish and self.enabled and self.running),
            "public_url": "",
            "local_url": "",
            "web_status": "waiting",
            "web_url": "",
            "web_local_url": "",
            "web_error": "",
            "published_at": "",
            "error": self._start_error,
        }
        if publication is None or not publication.public:
            if not self.enabled:
                base["status"] = "disabled"
            elif not self.running:
                base["status"] = "failed"
            return base
        suffix = f"/p/{publication.token}"
        base.update(
            {
                "status": "serving" if self.running else "failed",
                "can_publish": False,
                "public_url": f"{self.public_origin}{suffix}",
                "local_url": f"{self.local_origin()}{suffix}",
                "published_at": publication.published_at,
            }
        )
        if self.running:
            try:
                validate_harmony_go_export(Path(publication.artifact_root), self.registry.allowed_root)
            except ExpoExportValidationError as exc:
                base["status"] = "failed"
                base["error"] = str(exc)
            try:
                web_export = validate_expo_web_export(expo_web_root(publication), self.registry.allowed_root)
            except ExpoExportValidationError as exc:
                base["web_status"] = "missing" if "does not exist" in str(exc) or "marker is missing" in str(exc) else "failed"
                base["web_error"] = str(exc)
            else:
                revision = quote(str(web_export["exported_at"]), safe="")
                base["web_status"] = "ready"
                base["web_url"] = f"{self.public_origin}{suffix}/web/?v={revision}"
                base["web_local_url"] = f"{self.local_origin()}{suffix}/web/?v={revision}"
        return base

    def publish(self, run_id: str, artifact_root: Path) -> tuple[dict[str, Any], bool]:
        if not self.enabled:
            raise ExpoGatewayError("Expo public gateway is disabled")
        if not self.running:
            raise ExpoGatewayError(self._start_error or "Expo public gateway is not running")
        _publication, created, _validation = self.registry.publish(run_id, artifact_root)
        return self.describe(run_id, can_publish=False), created

    def unpublish(self, run_id: str, *, can_publish: bool = False) -> tuple[dict[str, Any], bool]:
        removed = self.registry.unpublish(run_id)
        return self.describe(run_id, can_publish=can_publish), removed
