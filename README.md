# Polysite CLI

`polysite` installs, runs, backs up and upgrades a [Polysite](https://github.com/polysites/polysite) CMS on one
server. It is the operator's tool in the way Drush is for Drupal and WP-CLI is for WordPress: a thin layer over Docker
Compose and the scripts that already ship with Polysite, with the safety rules written into the commands.

The same program answers to three names: `polysite`, `polysites` and `poly`.

- Plain ESM JavaScript, Node.js 20 or newer, **no dependencies**.
- Needs Docker with Compose v2 on the machine it manages. It never touches the database or the images except through them.
- Status: **v0.1**, pre-release and private, **not yet verified against a real stack**. Every command is covered by unit tests
  that run the CLI against a fake `docker` (93 tests, all passing on 2026-10-11), but none of `init`, `up`, `backup`, `restore`,
  `upgrade`, `plugin purge` or the others has been run end to end against real Polysite images, a real database and a real
  server. Do not rely on it for a production install yet. See "Verification status" and "Not done yet" at the end, and
  [CHANGELOG.md](CHANGELOG.md).

## Install

```sh
curl -fsSL https://<release host>/install.sh | sh        # installs to ~/.local, no sudo
sh install.sh --dry-run                                   # show what it would do, change nothing
npm install --global @polysite/cli                        # once published; also how to install on Windows
```

`install.sh` checks for Node 20+, downloads the release tarball **and its checksum**, refuses to continue if they do
not match, unpacks under `<prefix>/lib/polysite-cli/<version>` and links the three command names into `<prefix>/bin`.
Options: `--version`, `--prefix`, `--bin-dir`, `--base-url` (also `file://`), `--sha256`, `--dry-run`, `--force`.
`install.ps1` is a documented stub (TODO); use npm on Windows. `scripts/pack.sh` builds the release files.

## Five minutes to a production install

```sh
polysite init /opt/polysite --domain example.org         # files + generated secrets; nothing is started
cd /opt/polysite
polysite doctor                                           # Docker, ports, DNS, secrets, disk, backups ...
polysite up                                               # pull, start, wait until healthy
# open https://admin.example.org/admin: the setup page asks for POLYSITE_SETUP_TOKEN from .env
polysite backup                                           # prove backups work before you need them
```

## Commands

Every command has `--help`. These options work everywhere:

| Option | Meaning |
| --- | --- |
| `-C, --dir <folder>` | The install folder. Default: the current folder or the nearest one above it that has `.polysite/config.json` or a compose file |
| `--env dev\|prod` | Which compose files to use (prod: `docker-compose.prod.yml`; dev: `docker-compose.yml` + `docker-compose.dev.yml`) |
| `-p, --project <name>` | Docker Compose project name |
| `--compose-file <file>` | Compose file to use instead of the default (repeatable) |
| `--env-file <file>` | The env file (default `.env`) |
| `--json` | One JSON document on stdout; all human text goes to stderr |
| `--dry-run` | Show what would change and change nothing (read-only checks still run) |
| `--yes` | Answer plain yes/no confirmations. **Never** satisfies a typed confirmation |
| `--confirm <text>` | The text a typed confirmation asks for, given up front, for scripts |
| `-q, --quiet`, `--no-color` | Less output; no colours |

### Set up and check

- **`init <dir> [--domain example.org] [--cms-domain admin.example.org] [--scheme https|http] [--core-version X.Y.Z] [--registry ref] [--database local|external --database-url url] [--no-backup-encryption] [--force]`**
  Writes `docker-compose.prod.yml`, `Caddyfile`, `.env` (mode 600, freshly generated `PAYLOAD_SECRET`, revalidate secret,
  database password, setup token and backup passphrase), `.gitignore`, `.polysite/config.json` and a `backups/` folder.
  No secret is printed. It never overwrites an existing `.env`. The compose file uses published, versioned images and a
  bundled PostgreSQL (or your own with `--database external`).
- **`doctor [--online] [--deep] [--offline] [--strict] [--skip id]`** Read-only. Docker and Compose versions; the compose files
  are valid; `.env` is complete and private; secrets are long and not placeholders; `NUXT_REVALIDATE_SECRET` equals
  `REVALIDATE_SECRET`; `PAYLOAD_SECRET` has not changed since the last run (it encrypts stored credentials: a fingerprint is
  kept in `.polysite/state.json`, never the value); ports 80 and 443 are free; DNS for both domains; free disk; backups are
  configured, recent, encrypted and copied off-site; every plugin passes the isolation check; services and `/api/health`
  are healthy and report the configured release. `--online` also requests the public URLs; `--deep` runs the migration
  guards inside the CMS image. Each problem prints a `fix:` line. Exit 3 on any failure (`--strict`: on warnings too).
- **`version`** The CLI version, the release in `.env` and what is running.

### Run

- **`up [service...] [--build] [--no-wait]`**, **`down [--volumes]`**, **`restart [service...]`**, **`status`**, **`logs [service] [--tail N] [-f] [--since 10m]`**
  Wrappers over `docker compose` for the chosen environment. `up` waits for `cms` and `web` to be healthy. `status`
  exits 3 when something is down or unhealthy. `down` keeps your data; `down --volumes` deletes the database and uploads
  and needs the project name typed back (`--confirm <project>`).

### Plugins

- **`plugin list`** Slug, version, scope, kind, state (enabled / disabled / problem), how many of the plugin's tables exist
  (`2/2`) and how many of its migrations have run. Read from `plugins/` when the install has that folder, otherwise from
  inside the CMS image.
- **`plugin add <git-url|path> [--only slug]... [--all] [--ref tag]`** Copies the code into `plugins/<slug>`. Nothing from the
  plugin is run (no `npm install`, no scripts). The manifest, package type, entry file and migrations are checked; a
  migration that touches tables the plugin does not own is refused. It never overwrites an installed plugin.
- **`plugin remove <slug>`** Moves `plugins/<slug>` to `.polysite/removed-plugins/`. Its tables and content stay in the database.
- **`plugin disable|enable <slug> [--restart]`** Edits `POLYSITE_PLUGINS_OFF` in `.env`, keeping the file's comments. Data stays.
- **`plugin purge <slug> [--dry-run] [--confirm <slug>]`** The **only** command that deletes plugin data. See the safety model.

### Database and backups

- **`migrate [--check | --status] [--backup]`** Applies core and plugin migrations in the CMS (production). `--check` runs the
  core's own read-only guards in the CMS container: `node scripts/checkMigrations.mjs` (no migration deletes data) and
  `scripts/pluginMigrations.sh check` (the core and every plugin own only their own tables); exit 3 on failure. A dev checkout
  syncs its schema on boot, so applying is refused there unless `--force`.
- **`backup [--no-verify]`** (alias `--now`) Runs the backup service's `backup.sh`, then `verify.sh`, which test-restores the archive
  into a scratch database and compares row counts. **`backups`** lists archives (age, size, encrypted, checksum).
- **`restore <backup|latest> [--verify-only] [--db-only|--media-only] [--confirm <backup>] [--skip-erasures]`** Verifies first and
  stops there if the archive does not restore. Otherwise: stops `web` and `cms`, runs the restore service (which saves a
  `pre-restore-*.dump` of the current database first), starts them, waits for health and re-applies privacy erasures made
  since the backup (`scripts/reapplyErasures.ts`). Needs the backup's name typed back.
- **`upgrade [--to vX.Y.Z] [--pre] [--skip-backup] [--force] [--allow-downgrade] [--dry-run]`** See below.

### Accounts, sites, themes

All three go through Payload's local API inside the CMS container (so roles and validation apply), with the request on
stdin only.

- **`user create <email> [--super-admin | --role name] [--site domain]... [--generate-password | --password-stdin]`**,
  **`user reset-password <email> [...]`**, **`user list`**. Passwords come from a hidden prompt, stdin, or `--generate-password`.
  A password is **never** a command-line value and is printed **only** when you ask for `--generate-password`.
- **`site list`**, **`site create <name> --domain host [--theme theme]`**, **`theme list`**.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | The work failed |
| 2 | Wrong command line (unknown command or option, missing argument, invalid value) |
| 3 | A check ran and found a problem (`doctor`, `migrate --check`, `status`, a backup that does not verify) |
| 4 | Refused: a safety rule, or a confirmation that was not given. Nothing was changed |
| 5 | `upgrade` failed after switching and the previous release was put back |
| 6 | `upgrade` failed and putting the previous release back failed too |

With `--json` a failure is also printed as `{"ok": false, "error": ..., "exitCode": ...}`.

## Upgrade

`polysite upgrade [--to vX.Y.Z]` (without `--to`: the newest stable tag in the registry) does, in order, and stops at the
first failure with the old release still serving:

1. Checks the CMS is healthy, the target is newer, and no image is pinned by hand in `.env`.
2. `docker compose pull` of the target images, and checks each image's `org.opencontainers.image.version` label equals the target.
3. Runs `scripts/checkMigrations.mjs` from the **new** image: refuses a migration that deletes data.
4. Takes a backup with the running backup service and test-restores it (`verify.sh`). No good backup, no upgrade (`--skip-backup` is audited).
5. Applies the migrations from the new image while the old services keep serving.
6. Sets `POLYSITE_VERSION`, then switches `cms`, `web`, `backup` one at a time, waiting for each to be healthy and for
   `/api/health` to report the new version.

If step 6 fails, `POLYSITE_VERSION` is put back and the previous images are started again (exit 5; exit 6 if even that
fails, with the way back named). Migrations only add, so the old release runs on the migrated database; the backup from step
4 is the way back for anything else. `--dry-run` prints the plan and checks health, pulling nothing.

## Safety model

- **Nothing destructive without an explicit act.** Destructive steps need a flag *and* a typed confirmation. `--yes` is for
  plain confirmations only and never satisfies a typed one; with no terminal the answer is "refused", never "assumed yes".
  Scripts pass the text with `--confirm`.
- **`plugin purge`** is the only way plugin tables are dropped (`add`, `remove` and `disable` never delete data). It
  (1) refuses while the plugin is still loaded; (2) works out the objects to drop from the plugin's own migration
  **snapshot**, and only keeps what the plugin's own migration SQL also creates and the core's snapshot does not contain,
  so a core table can never be named (and a name list of core tables is refused outright); (3) prints the exact SQL and
  row counts; `--dry-run` stops there; (4) needs the **slug typed back**; (5) **takes and test-restores a fresh backup,
  refusing if either fails**; (6) runs the drops in **one transaction**, then writes `plugin-purge-start` and
  `plugin-purge-done` (or `-failed`) lines to the audit log.
- **Audit log** `.polysite/audit.log`: one line per sensitive action (time, user@host, event, key=value). It never holds
  secrets. Dry runs write nothing.
- **Secrets** are generated with the system CSPRNG, written only to `.env` (mode 600), never printed or put in
  arguments; the audit log and `doctor` output contain names, not values. `.env` edits keep comments and ordering.
- **Everything runs without a shell** (`docker` is started directly), so a value cannot be interpreted as shell syntax;
  SQL identifiers are validated before they are used.
- **Plugins are code**: `plugin add` copies files and checks them, but does not run them.
- **`--dry-run`** prints each mutating Docker command instead of running it.

## How it relates to the repository's own scripts

The CLI orchestrates; it does not reimplement. It calls what ships with the core:

| Command | Calls |
| --- | --- |
| `backup`, `restore`, `upgrade` | `backup/backup.sh`, `verify.sh`, `restore.sh` in the backup image (the `restore` compose profile) |
| `migrate --check`, `upgrade` | `apps/cms/scripts/checkMigrations.mjs`, `pluginMigrations.sh check`, `npx payload migrate` in the CMS image |
| `restore` | `apps/cms/scripts/reapplyErasures.ts` |
| `plugin list`, `plugin purge` | the plugins' and the core's migration snapshots (`*.json` beside the migrations), read from `plugins/` or the image |
| `user`, `site` | a small script embedded in the CLI (`templates/cms-ops.ts`) run with `payload run` in the CMS container |

`deploy/deploy.sh` is the repository's own deploy script for the same job as `polysite upgrade`; they are independent
implementations of the same steps and the same safety checks, so use one or the other for a given install.

An install is a folder with `docker-compose.prod.yml`, `Caddyfile`, `.env` and `.polysite/` (`config.json` with the mode,
compose files and project name; `audit.log`; `state.json`; `removed-plugins/`). A source checkout works too (`--env dev`).

## Development

```sh
docker run --rm -v "$PWD:/app" -w /app node:22 node --test          # unit tests (no Docker needed by the tests themselves)
sh scripts/pack.sh                                                    # dist/polysite-cli-<version>.tgz + .sha256
```

The tests run the CLI in process against a **fake `docker`** program put first on `PATH`; it records every call and
answers from rules, so tests assert the exact commands (and stdin) the CLI sends. No daemon, network or Node on the host is
needed (run them in a container, as above).

## Verification status

What has been checked, and what has not.

- **Checked:** 93 unit tests across argument handling, the `.env` editing, secret generation, `init`, the stack commands,
  `plugin` (including the `purge` safety rules), `backup`, `restore`, `migrate`, `upgrade` (including the rollback path),
  `user`, `site`, `theme` and `doctor`. They prove the CLI sends the commands, input and refusals it is designed to send.
- **Not checked:** the other half, that those commands do the right thing against real Polysite images, a real PostgreSQL, a
  real backup service and a real server. A script to run the CLI against a real stack is **planned but has not been written**
  (an earlier draft of this file named it `scripts/e2e-real.sh`; there is no such file). Until it exists and passes, treat
  every command as unproven, in particular `restore`, `upgrade` (and its automatic rollback), `plugin purge` and `migrate`,
  and try them first on a throwaway server.
- **Not checked:** `install.sh` against a real published release (there is no release host yet), and the installer on a
  machine without Node.

## Not done yet (v0.1)

- A real-stack end-to-end script (see "Verification status"); nothing has been run against real images.
- No release host or published package yet: the `curl ... | sh` URL and `@polysite/cli` on npm are placeholders until the
  repositories move and the npm name is claimed. It is covered by the product's licence, the Polysite Source-Available License (`LICENSE.md`).
- The runtime floor is Node.js 20, which reached end of life in April 2026; raise it to the current LTS line before release
  (to confirm).

- `install.ps1` (Windows installer) is a stub; the CLI itself works on Windows through npm.
- No `install` command that also starts the stack and prints the setup link (`init`, `doctor`, `up` do it in three steps).
- `build` / `push` for derived images with your own themes and plugins; `rollback` as its own command (use `upgrade --to <previous> --allow-downgrade`);
  `config get|set`; `support bundle`; `user login` links; `theme install`.
- Plugin add/remove changes the source folder only; in a production install plugins are baked into the image, so this needs a derived image.
- Single-file binaries and the container-image wrapper for hosts without Node.
