#!/usr/bin/env python3
"""Generate server.env values for the single Root administrator login."""

import base64
import getpass
import hashlib
import secrets
import sys


def base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def main() -> int:
    password = getpass.getpass("Root password: ")
    confirmation = getpass.getpass("Confirm password: ")
    if not password:
        print("Password must not be empty.", file=sys.stderr)
        return 1
    if password != confirmation:
        print("Passwords do not match.", file=sys.stderr)
        return 1

    iterations = 600000
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=32)
    password_hash = "$".join(
        ["pbkdf2_sha256", str(iterations), base64url_encode(salt), base64url_encode(digest)]
    )
    print(f"HP_ROOT_PASSWORD_HASH={password_hash}")
    print(f"HP_AUTH_SIGNING_SECRET={secrets.token_urlsafe(32)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
