#!/bin/sh
# Installs the Polysite command line tool (polysite, polysites, poly).
#
#   curl -fsSL https://get.polysite.example/install.sh | sh
#   sh install.sh [options]
#
# What it does, and nothing more: checks Node.js 22+ is present, downloads the release tarball and its checksum,
# refuses to go on if the checksum does not match, unpacks it under <prefix>/lib/polysite-cli/<version>, and links
# polysite, polysites and poly into <bin-dir>. No sudo, no package manager, no changes outside those folders.
#
# Options:
#   --version X.Y.Z    the release to install (default: the latest)
#   --prefix DIR       where the tool lives (default: ~/.local)
#   --bin-dir DIR      where the commands are linked (default: <prefix>/bin)
#   --base-url URL     where release files are downloaded from (default: the GitHub releases of polysite-cli);
#                      a folder with polysite-cli-<version>.tgz and polysite-cli-<version>.tgz.sha256. file:// works.
#   --sha256 HEX       expected checksum of the tarball, instead of the .sha256 file next to it
#   --dry-run          print what would be done; change nothing and download nothing
#   --force            replace an existing install of the same version
#   -h, --help         this text
set -eu

REPO="polysites/polysite-cli"
VERSION=""
PREFIX="${HOME:-.}/.local"
BIN_DIR=""
BASE_URL=""
SHA256=""
DRY=0
FORCE=0

say() { printf '%s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }
usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION=${2:?--version needs a value}; shift ;;
    --prefix) PREFIX=${2:?--prefix needs a value}; shift ;;
    --bin-dir) BIN_DIR=${2:?--bin-dir needs a value}; shift ;;
    --base-url) BASE_URL=${2:?--base-url needs a value}; shift ;;
    --sha256) SHA256=${2:?--sha256 needs a value}; shift ;;
    --dry-run) DRY=1 ;;
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown option $1"; usage >&2; exit 2 ;;
  esac
  shift
done

VERSION=${VERSION#v}
[ -n "$BIN_DIR" ] || BIN_DIR="$PREFIX/bin"
if [ -n "$VERSION" ] && ! printf '%s' "$VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'; then
  die "'$VERSION' is not a version like 0.1.0"
fi
if [ -z "$BASE_URL" ]; then
  if [ -n "$VERSION" ]; then BASE_URL="https://github.com/$REPO/releases/download/v$VERSION"
  else BASE_URL="https://github.com/$REPO/releases/latest/download"; fi
fi
BASE_URL=${BASE_URL%/}

# ---- prerequisites --------------------------------------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

have node || die "Node.js 22 or newer is required and 'node' was not found. Install it from https://nodejs.org (or your package manager), then run this again."
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$node_major" -ge 22 ] 2>/dev/null || die "Node.js 22 or newer is required; this is $(node -v)."

if have curl; then fetch() { curl -fsSL "$1" -o "$2"; }
elif have wget; then fetch() { wget -q "$1" -O "$2"; }
else die "curl or wget is required to download the release."; fi

if have sha256sum; then sum_of() { sha256sum "$1" | cut -d' ' -f1; }
elif have shasum; then sum_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif have openssl; then sum_of() { openssl dgst -sha256 "$1" | sed 's/^.*= //'; }
else die "sha256sum, shasum or openssl is required to verify the download."; fi

have tar || die "tar is required."

# Docker is what the tool drives, not what installs it: only warn.
if ! have docker; then
  say "note: Docker was not found. polysite drives Docker Compose; install Docker Engine before running 'polysite up'."
elif ! docker compose version >/dev/null 2>&1; then
  say "note: 'docker compose' (Compose v2) was not found. Install the Compose plugin before running 'polysite up'."
fi

# ---- plan -----------------------------------------------------------------------------------------------------------
TARNAME_VERSION=${VERSION:-latest}
say "Polysite CLI installer"
say "  version    ${VERSION:-latest release}"
say "  download   $BASE_URL"
say "  install to $PREFIX/lib/polysite-cli/<version>"
say "  commands   $BIN_DIR/{polysite,polysites,poly}"

if [ "$DRY" = 1 ]; then
  say ""
  say "dry run: nothing was downloaded or changed. It would:"
  say "  1. download polysite-cli-$TARNAME_VERSION.tgz and its .sha256 from $BASE_URL"
  say "  2. verify the checksum and stop if it does not match"
  say "  3. unpack it into $PREFIX/lib/polysite-cli/<version> and point $PREFIX/lib/polysite-cli/current at it"
  say "  4. link polysite, polysites and poly in $BIN_DIR"
  exit 0
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/polysite-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

# ---- download and verify --------------------------------------------------------------------------------------------
# With "latest" the file name carries the version, which is not known yet: the release publishes a stable alias.
if [ -n "$VERSION" ]; then TARBALL="polysite-cli-$VERSION.tgz"; else TARBALL="polysite-cli.tgz"; fi
say ""
say "Downloading $TARBALL ..."
fetch "$BASE_URL/$TARBALL" "$TMP/$TARBALL" || die "could not download $BASE_URL/$TARBALL"

if [ -n "$SHA256" ]; then
  EXPECTED=$SHA256
else
  fetch "$BASE_URL/$TARBALL.sha256" "$TMP/$TARBALL.sha256" || die "could not download the checksum $BASE_URL/$TARBALL.sha256 (refusing to install without one; pass --sha256 to supply it)"
  EXPECTED=$(cut -d' ' -f1 < "$TMP/$TARBALL.sha256" | tr -d '[:space:]')
fi
ACTUAL=$(sum_of "$TMP/$TARBALL")
if [ "$EXPECTED" != "$ACTUAL" ]; then
  err "checksum mismatch for $TARBALL"
  err "  expected $EXPECTED"
  err "  got      $ACTUAL"
  die "the download is damaged or has been tampered with; nothing was installed"
fi
say "Checksum verified ($ACTUAL)."

# ---- unpack ---------------------------------------------------------------------------------------------------------
mkdir -p "$TMP/x"
tar -xzf "$TMP/$TARBALL" -C "$TMP/x" || die "could not unpack the tarball"
[ -f "$TMP/x/package/package.json" ] && [ -f "$TMP/x/package/bin/polysite.js" ] || die "the tarball does not look like the Polysite CLI"
REAL_VERSION=$(node -p 'require(process.argv[1]).version' "$TMP/x/package/package.json" 2>/dev/null || true)
[ -n "$REAL_VERSION" ] || die "could not read the version from the tarball"
if [ -n "$VERSION" ] && [ "$REAL_VERSION" != "$VERSION" ]; then
  die "asked for $VERSION but the tarball is $REAL_VERSION; nothing was installed"
fi

LIB="$PREFIX/lib/polysite-cli"
DEST="$LIB/$REAL_VERSION"
if [ -e "$DEST" ] && [ "$FORCE" != 1 ]; then
  say "Version $REAL_VERSION is already installed at $DEST (use --force to replace it)."
else
  mkdir -p "$LIB" "$BIN_DIR"
  rm -rf "$DEST.new"
  mv "$TMP/x/package" "$DEST.new"
  chmod +x "$DEST.new/bin/polysite.js"
  rm -rf "$DEST"
  mv "$DEST.new" "$DEST"
fi
mkdir -p "$LIB" "$BIN_DIR"
ln -sfn "$DEST" "$LIB/current"
for name in polysite polysites poly; do
  ln -sfn "$LIB/current/bin/polysite.js" "$BIN_DIR/$name"
done

say ""
say "Installed polysite $REAL_VERSION."
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *) say "note: $BIN_DIR is not on your PATH. Add it, for example:"
     say "        echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile" ;;
esac
say ""
say "Next steps:"
say "  polysite version"
say "  polysite init /opt/polysite --domain example.org     # a production install, secrets generated"
say "  cd /opt/polysite && polysite doctor && polysite up"
