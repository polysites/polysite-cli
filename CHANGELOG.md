# Changelog

All notable changes to the Polysite CLI. The format follows [Keep a Changelog](https://keepachangelog.com/) and the
project uses [semantic versioning](https://semver.org/).

## [0.1.2] - 2026-10-15

First release tested against a real stack (see the README's "Verification status"): the cms, web and backup images were
built from the core's `v0.1.0-beta.4` tag, served from a local registry, and driven through `init`, `up`, `backup`,
`restore`, `upgrade` (including a rollback), `user`, `site`, `plugin` (including `purge`), off-site backups and HTTPS. It found five bugs, all fixed here.

### Added

- `scripts/e2e-real.sh`, `e2e-plugins.sh`, `e2e-offsite.sh` and `e2e-https.sh`: real-stack scripts (see the README). 100 checks, all
  passing on Debian 12 with the published `v0.1.0-beta.3` and `v0.1.0-beta.4` images.

### Fixed

- `restore` always failed with "no `restore` service": `docker compose config --services` leaves profile-gated services out.
  It now lists every profile.
- Every database query from `plugin list` and `plugin purge` failed: the `psql` field separator `|` was unquoted, so the
  shell read it as a pipe. Table and migration counts now show real numbers instead of `?`.
- `user` and `site` commands failed: Next marks `.next/` as CommonJS, which broke the operations script. It is now an
  `.mts` file. A failure also reports its cause instead of only "Error running script".
- `plugin enable|disable --restart` and `restart` returned before cms and web were healthy; they now wait, as `up` does.
- The generated Caddyfile lacked the core's security headers (HSTS, `X-Frame-Options`, `nosniff`, no `Server`) and its request-size limits
  (64 KB for form intake, 100 MB for the API and admin). It now matches the core's Caddyfile.

### Changed

- README: the status note now says what was and was not run for real.
- Tests: 99 (regression tests for the fixes above).

## [0.1.1] - 2026-10-15

Documentation and packaging only; no behaviour change besides the Node floor.

### Changed

- The Node.js floor is 22 (Node 20 is end-of-life): `package.json` engines, `bin/polysite.js` and `install.sh`.
- README: marked as an early preview that has not been run against a real stack; npm is the only install route; removed the
  placeholder `curl` install line, the "private" wording and the unfinished-notes tone; added a Licence section.
- `package.json`: repository, homepage and bugs links; public access.
- Added `.github/workflows/publish.yml`: a version tag stages the release on npm through trusted publishing, and a maintainer
  approves it before it goes live.

## [0.1.0] - 2026-10-15

First version, published to npm. **Not yet verified against a real stack:** the 93 unit tests run the CLI against a fake
`docker`; no command has been run end to end against real Polysite images, a real database or a real server.

### Added

- `polysite` (aliases `polysites`, `poly`): plain ESM Node.js, no dependencies.
- `init`: a production install folder with a compose file, Caddyfile and `.env` with generated secrets; nothing echoed.
- `doctor`: Docker, Compose, compose files, `.env` completeness and permissions, secret strength, `PAYLOAD_SECRET` stability, ports,
  DNS, disk, backups, plugin isolation, service and `/api/health` checks; a fix for every problem; exit 3 on failure.
- `up`, `down`, `status`, `logs`, `restart` for dev and prod; `down --volumes` needs the project name typed back.
- `plugin list|add|remove|enable|disable|purge`. `purge` is the only command that drops plugin tables: plan from the plugin's own
  migration snapshot, typed slug, fresh verified backup, one transaction, audit lines.
- `migrate` (apply, `--check`, `--status`, `--backup`).
- `backup`, `backups`, `restore` (verify first, typed confirmation, re-applies privacy erasures).
- `upgrade`: pull, label check, migration guard, verified backup, migrate, one-at-a-time switch behind health checks,
  automatic rollback (exit codes 5 and 6).
- `user create|reset-password|list`, `site list|create`, `theme list` through Payload's local API; passwords on stdin only.
- `--json`, `--dry-run`, `--yes`, `--confirm`, documented exit codes, audit log in `.polysite/audit.log`.
- `install.sh` (checksum-verified, no sudo, `--dry-run`), `scripts/pack.sh`, an `install.ps1` stub.
- Tests with a fake `docker` on `PATH` (93 tests). A script that runs the CLI against a real stack is still to be written.
