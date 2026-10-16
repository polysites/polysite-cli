#!/bin/sh
# Real-stack test of the HTTPS install path as far as a single machine can go: `init --scheme https`, Caddy serving TLS
# with its own internal CA (it does that for `localhost`), the http -> https redirect, and `doctor`'s HTTPS checks.
# It cannot test Let's Encrypt: that needs a public domain pointing at this server (do it once on a real server).
# Throwaway install in E2E_DIR on ports 80/443; containers and volumes are removed at the end.
#
#   E2E_DIR=/tmp/polysite-https VERSION=0.1.0-beta.4 sh scripts/e2e-https.sh
#   POLY, REGISTRY, KEEP=1 as in e2e-real.sh. Needs curl.
set -u

here=$(cd "$(dirname "$0")/.." && pwd)
POLY=${POLY:-"node $here/bin/polysite.js"}
DIR=${E2E_DIR:?set E2E_DIR to an empty folder that can be created}
VERSION=${VERSION:?set VERSION, for example 0.1.0-beta.4}
SITE="$DIR/site"
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

[ -e "$DIR" ] && { echo "E2E_DIR $DIR already exists; use an empty path" >&2; exit 2; }
mkdir -p "$DIR"
cleanup() {
  if [ -z "${KEEP:-}" ]; then
    [ -f "$SITE/docker-compose.prod.yml" ] && (cd "$SITE" && docker compose -p polysite-site -f docker-compose.prod.yml --env-file .env down -v >/dev/null 2>&1)
    echo "removed containers and volumes; the folder $DIR is left for you to delete"
  fi
}
trap cleanup EXIT

log "init with HTTPS"
OUT=$($POLY init "$SITE" --domain localhost --cms-domain admin.localhost --scheme https --core-version "$VERSION" $REGISTRY_ARGS 2>&1 </dev/null); CODE=$?
expect "init --scheme https" 0 "Wrote docker-compose.prod.yml"
poly doctor --offline; printf '%s' "$OUT" | grep -q "not set to HTTPS" && bad "doctor warns that the site is not HTTPS" || ok "doctor does not warn about HTTPS"
poly up; expect "up reaches healthy" 0 "The stack is up"

log "Caddy serves TLS and redirects http to https"
code=$(curl -s -o /dev/null -w '%{http_code}' --resolve admin.localhost:80:127.0.0.1 http://admin.localhost/admin/login)
case "$code" in 301|302|307|308) ok "http redirects (status $code)";; *) bad "http did not redirect (status $code)";; esac
loc=$(curl -s -o /dev/null -w '%{redirect_url}' --resolve admin.localhost:80:127.0.0.1 http://admin.localhost/admin/login)
case "$loc" in https://admin.localhost/*) ok "the redirect goes to https://admin.localhost";; *) bad "unexpected redirect target: $loc";; esac
code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve admin.localhost:443:127.0.0.1 https://admin.localhost/admin/login)
[ "$code" = 200 ] && ok "the admin answers over https (200)" || bad "the admin over https answered $code"
code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve localhost:443:127.0.0.1 https://localhost/)
case "$code" in 200|404) ok "the public site answers over https ($code)";; *) bad "the public site over https answered $code";; esac
issuer=$(echo | openssl s_client -connect 127.0.0.1:443 -servername admin.localhost 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null)
[ -n "$issuer" ] && ok "a certificate is served ($issuer)" || bad "no certificate was served"

log "security headers and body-size limits (the same as the core's own Caddyfile)"
adm=$(curl -skI --resolve admin.localhost:443:127.0.0.1 https://admin.localhost/admin/login | tr -d '\r')
printf '%s' "$adm" | grep -qi '^strict-transport-security: max-age=31536000' && ok "admin: HSTS is sent" || bad "admin: no Strict-Transport-Security header"
printf '%s' "$adm" | grep -qi '^x-frame-options: DENY' && ok "admin: X-Frame-Options DENY" || bad "admin: no X-Frame-Options"
printf '%s' "$adm" | grep -qi '^x-content-type-options: nosniff' && ok "admin: nosniff" || bad "admin: no nosniff"
api=$(curl -skI --resolve localhost:443:127.0.0.1 https://localhost/api/health | tr -d '\r')
printf '%s' "$api" | grep -qi '^strict-transport-security' && ok "API on the site domain: HSTS is sent" || bad "API on the site domain: no HSTS"
printf '%s' "$api" | grep -qi '^server:' && bad "the Server header is not removed" || ok "no Server header"
big=$(head -c 70000 /dev/zero | curl -sk -X POST --data-binary @- -H 'Content-Type: application/json' -o /dev/null -w '%{http_code}' --resolve localhost:443:127.0.0.1 https://localhost/api/form-intake/x)
[ "$big" = 413 ] && ok "a 70 KB form body is refused by Caddy (413)" || bad "a 70 KB form body answered $big, wanted 413"

log "the CLI's own checks over https"
poly doctor --offline --deep; expect "doctor on the running https stack" 0 "0 failed"
poly status; expect "status" 0 "cms +running +healthy"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
