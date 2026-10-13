#!/bin/sh
# Builds the release files the installer downloads: dist/polysite-cli-<version>.tgz, its .sha256, and the stable
# aliases polysite-cli.tgz(.sha256) that "latest" uses. Needs only tar and a sha256 tool, no Node.
#   scripts/pack.sh [output-dir]
set -eu
cd "$(dirname "$0")/.."
OUT=${1:-dist}
VERSION=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' package.json | head -1)
[ -n "$VERSION" ] || { echo "could not read the version from package.json" >&2; exit 1; }
mkdir -p "$OUT"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/package"
cp -R bin src templates package.json README.md CHANGELOG.md "$STAGE/package/"
[ ! -f LICENSE.md ] || cp LICENSE.md "$STAGE/package/"
FILE="$OUT/polysite-cli-$VERSION.tgz"
tar -czf "$FILE" -C "$STAGE" package
if command -v sha256sum >/dev/null 2>&1; then SUM=$(sha256sum "$FILE" | cut -d' ' -f1); else SUM=$(shasum -a 256 "$FILE" | cut -d' ' -f1); fi
printf '%s  %s\n' "$SUM" "$(basename "$FILE")" > "$FILE.sha256"
cp "$FILE" "$OUT/polysite-cli.tgz"
printf '%s  %s\n' "$SUM" "polysite-cli.tgz" > "$OUT/polysite-cli.tgz.sha256"
echo "$FILE"
echo "sha256 $SUM"
