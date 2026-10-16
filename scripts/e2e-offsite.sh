#!/bin/sh
# Real-stack test of the OFF-SITE backup copy, against a throwaway S3-compatible store (`rclone serve s3`, run from the backup image) next to the stack.
# It checks that a backup is copied off the machine encrypted, that the stack can be restored from that copy alone after
# the local backups are gone, and that nothing is sent off-site without an encryption passphrase. Not part of `npm test`.
# It makes a throwaway install in E2E_DIR (ports 80/443) and removes the containers and volumes at the end.
#
#   E2E_DIR=/tmp/polysite-offsite VERSION=0.1.0-beta.4 sh scripts/e2e-offsite.sh
#
#   POLY      the command to run (default: node <this repo>/bin/polysite.js)
#   REGISTRY  image registry (default: the CLI's own, ghcr.io/polysites)
#   KEEP=1    leave everything running
set -u

here=$(cd "$(dirname "$0")/.." && pwd)
POLY=${POLY:-"node $here/bin/polysite.js"}
DIR=${E2E_DIR:?set E2E_DIR to an empty folder that can be created}
VERSION=${VERSION:?set VERSION, for example 0.1.0-beta.4}
SITE="$DIR/site"
PROJECT=polysite-site
MINIO=polysite-e2e-minio
BUCKET=polysite-e2e
REGISTRY_ARGS=""
[ -n "${REGISTRY:-}" ] && REGISTRY_ARGS="--registry $REGISTRY"

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
compose() { (cd "$SITE" && docker compose -p "$PROJECT" -f docker-compose.prod.yml --env-file .env "$@"); }
setenv() { printf '%s=%s\n' "$1" "$2" >> "$SITE/.env"; }

[ -e "$DIR" ] && { echo "E2E_DIR $DIR already exists; use an empty path" >&2; exit 2; }
mkdir -p "$DIR"
cleanup() {
  if [ -z "${KEEP:-}" ]; then
    docker rm -f "$MINIO" >/dev/null 2>&1
    [ -f "$SITE/docker-compose.prod.yml" ] && compose down -v >/dev/null 2>&1
    echo "removed containers and volumes; the folder $DIR is left for you to delete"
  fi
}
trap cleanup EXIT

# Test-only credentials for the throwaway store, made here and never printed.
KEY=e2e$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
SECRET=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')

log "install and start ($VERSION)"
OUT=$($POLY init "$SITE" --domain localhost --cms-domain admin.localhost --scheme http --core-version "$VERSION" $REGISTRY_ARGS 2>&1 </dev/null); CODE=$?
expect "init" 0 "Wrote docker-compose.prod.yml"
poly up; expect "up reaches healthy" 0 "The stack is up"
poly site create Offsite-Demo --domain offsite.localhost; expect "demo data" 0 "Created site"

log "an S3-compatible store on the stack's network"
docker run -d --name "$MINIO" --network "${PROJECT}_default" --entrypoint rclone "${REGISTRY:-ghcr.io/polysites}/polysite-backup:v$VERSION" \
  serve s3 /data --addr :9000 --auth-key "$KEY,$SECRET" >/dev/null 2>&1 \
  && ok "store started" || bad "store did not start"
setenv BACKUP_RCLONE_REMOTE "offsite:$BUCKET/backups"
setenv RCLONE_CONFIG_OFFSITE_TYPE s3
setenv RCLONE_CONFIG_OFFSITE_PROVIDER Other
setenv RCLONE_CONFIG_OFFSITE_FORCE_PATH_STYLE true
setenv RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID "$KEY"
setenv RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY "$SECRET"
setenv RCLONE_CONFIG_OFFSITE_ENDPOINT "http://$MINIO:9000"
compose up -d backup >/dev/null 2>&1
n=0; until compose exec -T backup rclone mkdir "offsite:$BUCKET" >/dev/null 2>&1; do n=$((n + 1)); [ $n -gt 30 ] && break; sleep 2; done
[ $n -le 30 ] && ok "the backup service can reach the store" || bad "the backup service cannot reach the store"

log "backup copies off the machine"
poly backup; expect "backup verifies" 0 "Verified: it restores completely"
printf '%s' "$OUT" | grep -q "No off-site copy" && bad "backup says no off-site copy is configured" || ok "no 'no off-site copy' warning"
archive=$(printf '%s' "$OUT" | grep -Eo 'polysite-[0-9TZ]+\.tar[.a-z]*' | head -1)
remote=$(compose exec -T backup rclone lsf "offsite:$BUCKET/backups" 2>&1)
printf '%s' "$remote" | grep -q "$archive" && ok "the archive is in the store" || bad "the archive is not in the store: $remote"
printf '%s' "$remote" | grep -q "$archive.sha256" && ok "its checksum is in the store" || bad "the checksum is not in the store"
case "$archive" in *.enc) ok "the copy is encrypted ($archive)";; *) bad "the copy is not encrypted ($archive)";; esac
poly doctor --offline; printf '%s' "$OUT" | grep -q "no off-site copy" && bad "doctor still warns about off-site" || ok "doctor no longer warns about off-site"

log "lose the machine's backups, restore from the off-site copy alone"
poly site create After-Backup --domain after.localhost; expect "data created after the backup" 0
rm -f "$SITE/backups/"polysite-*
[ -z "$(ls "$SITE/backups" | grep polysite-)" ] && ok "local backups are gone" || bad "local backups remain"
poly restore "$archive" --confirm "$archive"; expect "restore of an archive that is not here is refused" 2 "No such backup"
compose exec -T backup rclone copyto "offsite:$BUCKET/backups/$archive" "/backups/$archive" >/dev/null 2>&1 \
  && compose exec -T backup rclone copyto "offsite:$BUCKET/backups/$archive.sha256" "/backups/$archive.sha256" >/dev/null 2>&1 \
  && ok "fetched the archive and checksum from the store" || bad "could not fetch from the store"
poly restore "$archive" --confirm "$archive"; expect "restore from the fetched copy" 0 "running on the restored data"
poly site list
printf '%s' "$OUT" | grep -q "offsite.localhost" && ! printf '%s' "$OUT" | grep -q "after.localhost" && ok "restored: demo data back, later data gone" || bad "unexpected sites after the restore: $OUT"

log "nothing leaves the machine without a passphrase"
sed -i 's/^BACKUP_ENCRYPTION_PASSPHRASE=.*/BACKUP_ENCRYPTION_PASSPHRASE=/' "$SITE/.env"
# the backup container reads .env when it is created, so recreate it for the change to count
compose up -d backup >/dev/null 2>&1
before=$(compose exec -T backup rclone lsf "offsite:$BUCKET/backups" 2>&1 | wc -l)
poly backup; [ "$CODE" != 0 ] && ok "backup without a passphrase fails (exit $CODE)" || bad "backup without a passphrase succeeded"
printf '%s' "$OUT" | grep -Eq "REFUSED|passphrase" && ok "the failure names the passphrase" || { bad "the failure does not name the passphrase"; printf '%s\n' "$OUT" | tail -6; }
after=$(compose exec -T backup rclone lsf "offsite:$BUCKET/backups" 2>&1 | wc -l)
[ "$before" = "$after" ] && ok "nothing new was sent to the store" || bad "the store changed ($before -> $after files)"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
