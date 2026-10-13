# Changelog

All notable changes to the Polysite CLI. The format follows [Keep a Changelog](https://keepachangelog.com/) and the
project uses [semantic versioning](https://semver.org/).

## [0.1.0] - unreleased

First version. Private and unreleased. **Not yet verified against a real stack:** the 93 unit tests run the CLI against a fake
`docker`; no command has been run end to end against real Polysite images, a real database or a real server.

### Added

- `polysite` (aliases `polysites`, `poly`): plain ESM Node.js 20+, no dependencies.
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
