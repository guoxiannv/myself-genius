#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DEST="$ROOT/deploy/signing"

# Usage: sync_deploy_signing_assets.sh <cer> <p12> <p7b> [<p7b> ...]
#
# Example:
#   scripts/sync_deploy_signing_assets.sh \
#     ~/signing/release.cer \
#     ~/signing/release.p12 \
#     ~/signing/app-aRelease.p7b \
#     ~/signing/app-bRelease.p7b

mkdir -p "$DEST"

if [ $# -lt 3 ]; then
  echo "Usage: $0 <cer_file> <p12_file> <p7b_file> [<p7b_file> ...]"
  echo ""
  echo "Copies the provided signing files into deploy/signing/ so the"
  echo "profile pool and HPack packager can find them at relative paths."
  exit 1
fi

cer="$1"; shift
p12="$1"; shift

cp "$cer" "$DEST/release.cer"
echo "copied release.cer from $cer"
cp "$p12" "$DEST/release.p12"
echo "copied release.p12 from $p12"

for p7b in "$@"; do
  basename="$(basename "$p7b")"
  cp "$p7b" "$DEST/$basename"
  echo "copied $basename from $p7b"
done

echo "Signing assets synced to $DEST"