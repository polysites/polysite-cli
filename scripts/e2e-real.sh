#!/bin/sh
# Runs the CLI against a REAL Polysite stack: real images, a real database, real containers. Not part of `npm test`.
# It creates a throwaway install in E2E_DIR, starts it on ports 80/443 of this machine, and removes it again (data volumes
# included) at the end. Never point it at an install you care about.
#
#   E2E_DIR=/tmp/polysite-e2e FROM_VERSION=0.1.0-beta.3 TO_VERSION=0.1.0-beta.4 sh scripts/e2e-real.sh
#
# Needs: Docker with Compose v2, Node.js 22+, pull access to the images. Optional:
#   POLY           the command to run (default: node <this repo>/bin/polysite.js)
#   REGISTRY       image registry (default: the CLI's own, ghcr.io/polysites)
#   KEEP=1         leave the stack running and the folder in place when done
set -u

here=$(cd "$(dirname "$0")/.." && pwd)
POLY=${POLY:-"node $here/bin/polysite.js"}
DIR=${E2E_DIR:?set E2E_DIR to an empty folder that can be created}
FROM=${FROM_VERSION:?set FROM_VERSION, for example 0.1.0-beta.3}
TO=${TO_VERSION:?set TO_VERSION, for example 0.1.0-beta.4}
SITE="$DIR/site"
REGISTRY_ARGS=""
[ -n "${REGISTRY:-}" ] && REGISTRY_ARGS="--registry $REGISTRY"

pass=0; fail=0
log() { printf '\n=== %s\n' "$*"; }
ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$*"; }
bad() { fail=$((fail + 1)); printf 'FAIL  %s\n' "$*"; }

# poly <args>: run the CLI against the install, keep the output in $OUT and the exit code in $CODE
poly() { OUT=$($POLY -C "$SITE" "$@" 2>&1 </dev/null); CODE=$?; }
# expect <label> <exit code> <regex the output must match (optional)>
expect() {
  label=$1; want=$2; re=${3:-}
  if [ "$CODE" != "$want" ]; then bad "$label (exit $CODE, wanted $want)"; printf '%s\n' "$OUT" | tail -8; return; fi
  if [ -n "$re" ] && ! printf '%s' "$OUT" | grep -Eq "$re"; then bad "$label (output did not match: $re)"; printf '%s\n' "$OUT" | tail -8; return; fi
  ok "$label"
}

[ -e "$DIR" ] && { echo "E2E_DIR $DIR already exists; use an empty path" >&2; exit 2; }
mkdir -p "$DIR"
cleanup() {
  if [ -z "${KEEP:-}" ]; then
    [ -f "$SITE/docker-compose.prod.yml" ] && (cd "$SITE" && docker compose -p polysite-site -f docker-compose.prod.yml --env-file .env down -v >/dev/null 2>&1)
    echo "removed containers and volumes; the folder $DIR is left for you to delete"
  fi
}
trap cleanup EXIT

log "init ($FROM)"
OUT=$($POLY init "$SITE" --domain localhost --cms-domain admin.localhost --scheme http --core-version "$FROM" $REGISTRY_ARGS 2>&1 </dev/null); CODE=$?
expect "init writes the install" 0 "Wrote docker-compose.prod.yml"
perm=$(stat -c %a "$SITE/.env" 2>/dev/null || stat -f %Lp "$SITE/.env")
[ "$perm" = "600" ] && ok ".env is mode 600" || bad ".env is mode $perm, wanted 600"

log "doctor before start"
poly doctor --offline; expect "doctor: no failures" 0 "0 failed"

log "up"
poly up; expect "up reaches healthy" 0 "The stack is up"
poly status; expect "status: all services up on $FROM" 0 "cms +running +healthy +$FROM"
poly version; expect "version reports $FROM" 0 "running +cms $FROM"
poly doctor --offline --deep; expect "doctor --deep on the running stack" 0 "0 failed"

log "demo data"
poly site create Demo-Site --domain demo.localhost; expect "site create" 0 "Created site"
poly user create e2e@example.org --super-admin --generate-password; expect "user create" 0 "Created e2e@example.org"
poly user list; expect "user list" 0 "e2e@example.org"
poly user reset-password e2e@example.org --generate-password; expect "user reset-password" 0 "Password"
poly theme list; expect "theme list" 0
poly plugin list; expect "plugin list (image has no plugins)" 0 "No plugins installed"

log "backup, verify, restore"
poly backup; expect "backup verifies" 0 "Verified: it restores completely"
poly backups; expect "backups lists it" 0 "polysite-.*tar"
archive=$(printf '%s' "$OUT" | grep -Eo 'polysite-[0-9TZ]+\.tar[.a-z]*' | head -1)
poly restore latest --verify-only; expect "restore --verify-only" 0 "restores completely"
poly site create After-Backup --domain after.localhost; expect "site created after the backup" 0
poly restore "$archive" --confirm "$archive"; expect "restore" 0 "running on the restored data"
poly site list
printf '%s' "$OUT" | grep -q "demo.localhost" && ! printf '%s' "$OUT" | grep -q "after.localhost" && ok "restore: demo data back, later data gone" || bad "restore: unexpected sites: $OUT"

log "safety refusals"
poly down --volumes; expect "down --volumes needs a typed confirmation" 4
poly restore latest; expect "restore needs the name typed back" 4
poly status; expect "status still healthy after refusals" 0 "cms +running +healthy"

log "upgrade $FROM -> $TO"
poly upgrade --to "v$TO" --dry-run; expect "upgrade --dry-run changes nothing" 0 "dry-run"
poly upgrade --to "v$TO"; expect "upgrade" 0 "Upgraded $FROM -> $TO"
poly status; expect "status: running $TO" 0 "cms +running +healthy +$TO"
poly site list; printf '%s' "$OUT" | grep -q "demo.localhost" && ok "demo data survived the upgrade" || bad "demo data missing after upgrade"
poly migrate --check; expect "migrate --check" 0 "delete nothing"
poly doctor --offline --deep; expect "doctor after upgrade" 0 "0 failed"

log "down"
poly down; expect "down keeps data" 0 "Stopped"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
