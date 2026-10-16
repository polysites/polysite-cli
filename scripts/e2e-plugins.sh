#!/bin/sh
# Real-stack test of the plugin commands, including `plugin purge`, which DROPS plugin tables. Not part of `npm test`.
# Plugins are baked into the images at build time, so this needs a cms and web image built WITH plugins (see below).
# It makes a throwaway install in E2E_DIR, runs it on ports 80/443 of this machine, and removes the containers and
# volumes at the end. Never point it at an install you care about.
#
#   E2E_DIR=/tmp/polysite-plugins REGISTRY=localhost:5000 VERSION=0.1.0-beta.4 \
#     PLUGINS="share analytics" PURGE=share sh scripts/e2e-plugins.sh
#
# Build the images first, from the core's source with the plugins folders copied into plugins/ (what the core's
# docker-compose.workspace.yml does), and push cms, web and backup to REGISTRY with the version label VERSION.
#   POLY    the command to run (default: node <this repo>/bin/polysite.js)
#   PLUGINS the plugin slugs the images contain (default: "share analytics")
#   PURGE   the one to purge (default: the first); the others must be left alone
#   KEEP=1  leave the stack running
set -u

here=$(cd "$(dirname "$0")/.." && pwd)
POLY=${POLY:-"node $here/bin/polysite.js"}
DIR=${E2E_DIR:?set E2E_DIR to an empty folder that can be created}
REGISTRY=${REGISTRY:?set REGISTRY to the registry holding the plugin-bearing images}
VERSION=${VERSION:?set VERSION, for example 0.1.0-beta.4}
PLUGINS=${PLUGINS:-"share analytics"}
PURGE=${PURGE:-${PLUGINS%% *}}
SITE="$DIR/site"

pass=0; fail=0
log() { printf '\n=== %s\n' "$*"; }
ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$*"; }
bad() { fail=$((fail + 1)); printf 'FAIL  %s\n' "$*"; }
poly() { OUT=$($POLY -C "$SITE" "$@" 2>&1 </dev/null); CODE=$?; }
expect() {
  label=$1; want=$2; re=${3:-}
  if [ "$CODE" != "$want" ]; then bad "$label (exit $CODE, wanted $want)"; printf '%s\n' "$OUT" | tail -10; return; fi
  if [ -n "$re" ] && ! printf '%s' "$OUT" | grep -Eq "$re"; then bad "$label (output did not match: $re)"; printf '%s\n' "$OUT" | tail -10; return; fi
  ok "$label"
}
# row <slug>: the `plugin list` line for a plugin
row() { printf '%s\n' "$OUT" | grep -E "^$1 " | head -1; }

[ -e "$DIR" ] && { echo "E2E_DIR $DIR already exists; use an empty path" >&2; exit 2; }
mkdir -p "$DIR"
cleanup() {
  if [ -z "${KEEP:-}" ]; then
    [ -f "$SITE/docker-compose.prod.yml" ] && (cd "$SITE" && docker compose -p polysite-site -f docker-compose.prod.yml --env-file .env down -v >/dev/null 2>&1)
    echo "removed containers and volumes; the folder $DIR is left for you to delete"
  fi
}
trap cleanup EXIT

log "install and start ($VERSION from $REGISTRY)"
OUT=$($POLY init "$SITE" --domain localhost --cms-domain admin.localhost --scheme http --core-version "$VERSION" --registry "$REGISTRY" 2>&1 </dev/null); CODE=$?
expect "init" 0 "Wrote docker-compose.prod.yml"
poly up; expect "up reaches healthy" 0 "The stack is up"
poly site create Plugin-Test --domain plugin.localhost; expect "site create" 0 "Created site"

log "plugin list: every baked-in plugin, with its tables and migrations applied"
poly plugin list; expect "plugin list" 0
for p in $PLUGINS; do
  r=$(row "$p")
  [ -n "$r" ] && ok "$p is listed" || bad "$p is not listed"
  printf '%s' "$r" | grep -Eq "enabled" && ok "$p is enabled" || bad "$p is not enabled: $r"
  printf '%s' "$r" | grep -Eq " ([0-9]+)/\1 " && ok "$p: all tables and migrations are present" || bad "$p: tables or migrations missing: $r"
done
tables_before=$(row "$PURGE" | awk '{print $(NF-1)}')

log "backup, then disable and enable keep the data"
poly backup; expect "backup verifies" 0 "Verified: it restores completely"
poly plugin disable "$PURGE" --restart; expect "plugin disable --restart" 0 "switched off"
poly plugin list; row "$PURGE" | grep -q disabled && ok "$PURGE is disabled" || bad "$PURGE not shown disabled: $(row "$PURGE")"
[ "$(row "$PURGE" | awk '{print $(NF-1)}')" = "$tables_before" ] && ok "disable kept the tables" || bad "disable changed the tables: $(row "$PURGE")"
poly plugin enable "$PURGE" --restart; expect "plugin enable --restart" 0 "switched on"
poly status; expect "stack healthy after the restart" 0 "cms +running +healthy"

log "purge: the refusals come first"
poly plugin purge "$PURGE" --confirm "$PURGE"; expect "purge refuses while the plugin is switched on" 4 "still switched on"
poly plugin disable "$PURGE" --restart; expect "disable again" 0
poly plugin purge "$PURGE"; expect "purge needs the slug typed back" 4
poly plugin purge "$PURGE" --yes; expect "--yes does not satisfy the typed confirmation" 4
poly plugin purge "$PURGE" --confirm wrong-slug; expect "a wrong slug is refused" 4
poly plugin purge not-a-plugin --confirm not-a-plugin; expect "an unknown plugin is refused" 1
poly plugin list; [ "$(row "$PURGE" | awk '{print $(NF-1)}')" = "$tables_before" ] && ok "nothing was dropped by the refusals" || bad "tables changed after refusals"

log "purge --dry-run shows the SQL and drops nothing"
poly plugin purge "$PURGE" --dry-run; expect "purge --dry-run" 0 "DROP"
printf '%s' "$OUT" | grep -Eq "DROP TABLE.*(sites|users|pages|roles)\b" && bad "the plan names a core table" || ok "the plan names no core table"
poly plugin list; [ "$(row "$PURGE" | awk '{print $(NF-1)}')" = "$tables_before" ] && ok "dry run dropped nothing" || bad "dry run changed the tables"

log "purge, confirmed"
poly plugin purge "$PURGE" --confirm "$PURGE"; expect "purge" 0
poly plugin list
case "$(row "$PURGE" | awk '{print $(NF-1)}')" in 0/*) ok "$PURGE's tables are gone";; *) bad "$PURGE's tables remain: $(row "$PURGE")";; esac
for p in $PLUGINS; do
  [ "$p" = "$PURGE" ] && continue
  [ "$(row "$p" | awk '{print $(NF-1)}')" = "$(printf '%s' "$(row "$p")" | awk '{print $(NF-1)}')" ] && printf '%s' "$(row "$p")" | grep -Eq " ([0-9]+)/\1 " && ok "$p was left alone" || bad "$p was touched: $(row "$p")"
done
poly site list; expect "core data intact (site list)" 0 "plugin.localhost"
grep -q "plugin-purge-start" "$SITE/.polysite/audit.log" && grep -q "plugin-purge-done" "$SITE/.polysite/audit.log" && ok "audit log has plugin-purge-start and -done" || bad "audit log lacks the purge lines"
poly backups; expect "a backup was taken before the purge" 0 "polysite-"
poly status; expect "stack healthy after the purge" 0 "cms +running +healthy"
poly migrate --check; expect "migrate --check after the purge" 0 "delete nothing"

log "down"
poly down; expect "down" 0 "Stopped"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
