from __future__ import annotations

from datetime import datetime, timezone


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_iso(dt: datetime | None = None) -> str:
    return (dt or utc_now()).isoformat()


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        # Python 3.9 does not accept the RFC 3339 ``Z`` suffix emitted by the
        # Runner's Node.js controller; normalize it before parsing.
        normalized = f"{value[:-1]}+00:00" if value.endswith(("Z", "z")) else value
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None
