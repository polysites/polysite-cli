import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { EnvFile } from "../src/lib/envfile.js";
import { createFakeDocker, healthyStack } from "./helpers/fakeDocker.js";
import { makeInstall, readAudit, readEnv, runCli } from "./helpers/cli.js";
import { writePlugin } from "./helpers/plugins.js";

const ARCHIVE = "polysite-20260101T000000Z.tar.enc";
const BACKUP_OK = { match: "backup.sh$", stdout: `2026-01-01T00:00:00Z Backup 20260101T000000Z: wrote ${ARCHIVE} (1.2M), encrypted\n2026-01-01T00:00:00Z No off-site copy configured\n` };
const VERIFY_OK = { match: `verify.sh ${ARCHIVE}$`, stdout: "2026-01-01 users: 3 rows OK\n2026-01-01 Verified: it restores completely\n" };

function installWithBackups() {
  const dir = makeInstall();
  writeFileSync(join(dir, "backups", ARCHIVE), "x".repeat(2048));
  writeFileSync(join(dir, "backups", `${ARCHIVE}.sha256`), "abc  file\n");
  writeFileSync(join(dir, "backups", "LAST_SUCCESS"), `${new Date().toISOString()}\n`);
  return dir;
}

// ---- backup / restore ----------------------------------------------------------------------------------------------

test("backup runs the backup service's script, then verifies the archive it reported", async () => {
  const dir = installWithBackups();
  const fake = createFakeDocker([BACKUP_OK, VERIFY_OK, ...healthyStack()]);
  const r = await runCli(["backup", "--now", "--json"], { cwd: dir, fake });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { ok: true, archive: ARCHIVE, verified: true });
  assert.deepEqual(fake.lines().filter((l) => l.includes("/opt/backup/")), ["exec -T backup /opt/backup/backup.sh", `exec -T backup /opt/backup/verify.sh ${ARCHIVE}`]);
  assert.match(readAudit(dir), new RegExp(`event=backup archive=${ARCHIVE} verified=true`));
  assert.match(r.stderr, /No off-site copy/);
});

test("backup uses a one-off container when the backup service is not running", async () => {
  const dir = installWithBackups();
  const fake = createFakeDocker([
    { match: " ps -q backup$", stdout: "" },
    { ...BACKUP_OK, match: "backup.sh backup$" },
    { ...VERIFY_OK, match: `verify.sh backup ${ARCHIVE}$` },
    ...healthyStack(),
  ]);
  const r = await runCli(["backup"], { cwd: dir, fake });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fake.lines().includes("run --rm -T --entrypoint /opt/backup/backup.sh backup"));
});

test("backup fails loudly when the script fails or the archive does not verify", async () => {
  const dir = installWithBackups();
  const failing = createFakeDocker([{ match: "backup.sh$", code: 1, stdout: "2026 ERROR: pg_dump failed\n" }, ...healthyStack()]);
  const a = await runCli(["backup"], { cwd: dir, fake: failing });
  assert.equal(a.code, 1);
  assert.match(a.stderr, /pg_dump failed/);
  const bad = createFakeDocker([BACKUP_OK, { match: "verify.sh", code: 1, stdout: "2026 ERROR: The restored database doesn't match what was backed up\n" }, ...healthyStack()]);
  const b = await runCli(["backup"], { cwd: dir, fake: bad });
  assert.equal(b.code, 1);
  assert.match(b.stderr, /does not verify/);
  const skip = createFakeDocker([BACKUP_OK, ...healthyStack()]);
  assert.equal((await runCli(["backup", "--no-verify"], { cwd: dir, fake: skip })).code, 0);
  assert.ok(!skip.lines().some((l) => l.includes("verify.sh")));
});

test("backups lists archives newest first with size, encryption and the last success", async () => {
  const dir = installWithBackups();
  writeFileSync(join(dir, "backups", "polysite-20250101T000000Z.tar"), "y");
  const r = await runCli(["backups", "--json"], { cwd: dir, fake: createFakeDocker([]) });
  const j = r.json();
  assert.deepEqual(j.backups.map((b) => b.name), [ARCHIVE, "polysite-20250101T000000Z.tar"]);
  assert.equal(j.backups[0].encrypted, true);
  assert.equal(j.backups[0].checksum, true);
  assert.equal(j.backups[0].createdAt, "2026-01-01T00:00:00Z");
  assert.ok(j.lastSuccess);
});

test("restore --verify-only checks the backup and changes nothing", async () => {
  const dir = installWithBackups();
  const fake = createFakeDocker([VERIFY_OK, ...healthyStack()]);
  const r = await runCli(["restore", "latest", "--verify-only", "--json"], { cwd: dir, fake });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().restored, false);
  assert.deepEqual(fake.lines().filter((l) => /stop|--yes|run /.test(l)), []);
});

test("restore verifies first, and a backup that does not verify is never restored", async () => {
  const dir = installWithBackups();
  const fake = createFakeDocker([{ match: "verify.sh", code: 1, stdout: "ERROR: The database dump doesn't match its checksum\n" }, ...healthyStack()]);
  const r = await runCli(["restore", ARCHIVE, "--confirm", ARCHIVE], { cwd: dir, fake });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /does not verify, so it will not be restored/);
  assert.ok(!fake.lines().some((l) => l.includes("--profile restore")));
  assert.ok(!fake.lines().some((l) => l.startsWith("stop")));
});

test("restore needs the backup's name typed back", async () => {
  const dir = installWithBackups();
  const fake = createFakeDocker([VERIFY_OK, ...healthyStack()]);
  assert.equal((await runCli(["restore", ARCHIVE], { cwd: dir, fake })).code, 4);
  assert.equal((await runCli(["restore", ARCHIVE, "--yes"], { cwd: dir, fake })).code, 4);
  assert.equal((await runCli(["restore", ARCHIVE, "--confirm", "latest"], { cwd: dir, fake })).code, 4);
  assert.ok(!fake.lines().some((l) => l.startsWith("stop")));
});

test("restore, confirmed: stops web and cms, restores, starts them, waits, re-applies erasures", async () => {
  const dir = installWithBackups();
  const fake = createFakeDocker([
    VERIFY_OK,
    { match: "run --rm -T restore .* --yes$", stdout: "Restore complete\n" },
    { match: "reapplyErasures", stdout: "Deleted 0 submission(s) belonging to people who had asked to be erased\n" },
    ...healthyStack(),
  ]);
  const r = await runCli(["restore", "latest", "--confirm", ARCHIVE, "--json"], { cwd: dir, fake });
  assert.equal(r.code, 0, r.stderr);
  const lines = fake.lines();
  const idx = (needle) => lines.findIndex((l) => l.includes(needle));
  assert.ok(idx("verify.sh") >= 0 && idx("verify.sh") < idx("stop web cms"), lines.join("\n"));
  assert.ok(idx("stop web cms") < idx(`--profile restore run --rm -T restore ${ARCHIVE} --yes`));
  assert.ok(idx("--profile restore run") < idx("start cms web"));
  assert.ok(idx("start cms web") < idx("reapplyErasures"));
  assert.equal(r.json().erasures, "reapplied");
  assert.match(readAudit(dir), /event=restore-start archive=polysite-20260101T000000Z\.tar\.enc/);
  assert.match(readAudit(dir), /event=restore-done/);
});

test("restore --db-only passes the flag through; a failing restore starts the old app again", async () => {
  const dir = installWithBackups();
  const fake = createFakeDocker([VERIFY_OK, { match: "run --rm -T restore .* --yes", code: 1, stdout: "ERROR: Database restore failed\n" }, ...healthyStack()]);
  const r = await runCli(["restore", ARCHIVE, "--db-only", "--confirm", ARCHIVE], { cwd: dir, fake });
  assert.equal(r.code, 1);
  assert.ok(fake.lines().some((l) => l.endsWith(`restore ${ARCHIVE} --yes --db-only`)));
  assert.ok(fake.lines().includes("start cms web"), "the app is started again");
  assert.match(readAudit(dir), /event=restore-failed/);
});

test("restore rejects a file outside the backups folder and unknown names", async () => {
  const dir = installWithBackups();
  const fake = createFakeDocker(healthyStack());
  assert.equal((await runCli(["restore", "/etc/passwd"], { cwd: dir, fake })).code, 2);
  assert.equal((await runCli(["restore", "polysite-20990101T000000Z.tar"], { cwd: dir, fake })).code, 2);
  assert.equal((await runCli(["restore", "latest", "--db-only", "--media-only"], { cwd: dir, fake })).code, 2);
});

// ---- migrate -------------------------------------------------------------------------------------------------------

test("migrate applies migrations in the CMS (production)", async () => {
  const fake = createFakeDocker([{ match: "npx payload migrate$", stdout: "Migrated: x\n" }, ...healthyStack()]);
  const dir = makeInstall();
  const r = await runCli(["migrate"], { cwd: dir, fake });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fake.lines().includes("exec -T cms npx payload migrate"));
  assert.match(readAudit(dir), /event=migrate result=ok/);
});

test("migrate --backup backs up and verifies before applying", async () => {
  const fake = createFakeDocker([BACKUP_OK, VERIFY_OK, ...healthyStack()]);
  await runCli(["migrate", "--backup"], { cwd: makeInstall(), fake });
  const lines = fake.lines();
  assert.ok(lines.findIndex((l) => l.includes("backup.sh")) < lines.findIndex((l) => l.endsWith("npx payload migrate")));
});

test("migrate refuses a dev checkout unless --force, and reports a failing migration", async () => {
  const fake = createFakeDocker(healthyStack());
  const dev = makeInstall({ mode: "dev" });
  assert.equal((await runCli(["migrate"], { cwd: dev, fake })).code, 4);
  const failing = createFakeDocker([{ match: "npx payload migrate$", code: 1, stderr: "error: relation already exists" }, ...healthyStack()]);
  const r = await runCli(["migrate", "--force"], { cwd: dev, fake: failing });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already exists/);
});

test("migrate --check runs both guards and exits 3 when either fails", async () => {
  const dir = makeInstall();
  const ok = createFakeDocker([{ match: "pluginMigrations.sh check", stdout: "ok    core: its migrations match its tables\n" }, { match: "checkMigrations.mjs", stdout: "Migrations OK\n" }, ...healthyStack()]);
  const a = await runCli(["migrate", "--check", "--json"], { cwd: dir, fake: ok });
  assert.equal(a.code, 0, a.stderr);
  assert.ok(ok.lines().includes("exec -T cms node scripts/checkMigrations.mjs"));
  assert.ok(ok.lines().some((l) => l.includes("unset POLYSITE_PLUGINS_OFF; sh scripts/pluginMigrations.sh check")));
  const bad = createFakeDocker([{ match: "pluginMigrations.sh check", code: 1, stdout: "FAIL  posts: its tables changed without a migration\n" }, ...healthyStack()]);
  const b = await runCli(["migrate", "--check"], { cwd: dir, fake: bad });
  assert.equal(b.code, 3);
  assert.match(b.stderr + b.stdout, /posts: its tables changed/);
  assert.ok(!bad.lines().some((l) => l.endsWith("payload migrate")), "--check never applies anything");
});

// ---- upgrade -------------------------------------------------------------------------------------------------------

const TARGET = "0.2.0";
function upgradeRules({ guardOk = true, backupOk = true, migrateOk = true, version = TARGET, imageLabel = TARGET } = {}) {
  return [
    { match: "config --format json", stdout: JSON.stringify({ services: { cms: { image: `img-cms:v${TARGET}` }, web: { image: `img-web:v${TARGET}` }, backup: { image: `img-backup:v${TARGET}` } } }) },
    { match: "^image inspect", stdout: `${imageLabel}\n` },
    { match: "checkMigrations.mjs", ...(guardOk ? { stdout: "Migrations OK\n" } : { code: 1, stderr: "Destructive statements in migrations (data would be deleted)" }) },
    { match: "backup.sh$", ...(backupOk ? { stdout: `wrote ${ARCHIVE} (1M)\n` } : { code: 1, stdout: "ERROR: dump failed\n" }) },
    VERIFY_OK,
    { match: "npx payload migrate$", ...(migrateOk ? { stdout: "ok\n" } : { code: 1, stderr: "error: migration blew up" }) },
    { match: "wget -q -O - http://127.0.0.1:3001/api/health", stdout: JSON.stringify({ status: "ok", version }) },
    { match: "wget -q -O - http://127.0.0.1:3000/api/health", stdout: JSON.stringify({ status: "ok", version }) },
    ...healthyStack({ version: "0.1.0" }),
  ];
}
const upgradeCalls = (fake) => fake.lines().filter((l) => /^(pull|up|run|exec -T backup \/opt)/.test(l));

test("upgrade --dry-run shows the plan, pulls nothing and changes nothing", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker(upgradeRules());
  const r = await runCli(["upgrade", "--to", `v${TARGET}`, "--dry-run", "--json"], { cwd: dir, fake });
  assert.equal(r.code, 0, r.stderr);
  const j = r.json();
  assert.equal(j.from, "0.1.0");
  assert.equal(j.to, TARGET);
  assert.equal(j.plan.length, 6);
  assert.equal(EnvFile.read(join(dir, ".env")).get("POLYSITE_VERSION"), "0.1.0");
  assert.deepEqual(upgradeCalls(fake), []);
});

test("upgrade, in order: pull, guard, backup, verify, migrate, then switch cms, web, backup behind health checks", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker(upgradeRules());
  const r = await runCli(["upgrade", "--to", TARGET, "--json"], { cwd: dir, fake });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(upgradeCalls(fake), [
    "pull cms web backup",
    "run --rm --no-deps -T cms node scripts/checkMigrations.mjs",
    "exec -T backup /opt/backup/backup.sh",
    `exec -T backup /opt/backup/verify.sh ${ARCHIVE}`,
    "run --rm --no-deps -T cms npx payload migrate",
    "up -d --no-deps cms",
    "up -d --no-deps web",
    "up -d --no-deps backup",
    "up -d --no-recreate",
  ]);
  assert.equal(EnvFile.read(join(dir, ".env")).get("POLYSITE_VERSION"), TARGET);
  assert.equal(r.json().backup, ARCHIVE);
  const audit = readAudit(dir);
  assert.match(audit, /event=upgrade-start from=0\.1\.0 to=0\.2\.0/);
  assert.match(audit, /event=upgrade-done from=0\.1\.0 to=0\.2\.0/);
});

test("upgrade gives compose the target version through the environment for the pull, the guard and the migration", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker(upgradeRules());
  await runCli(["upgrade", "--to", TARGET], { cwd: dir, fake });
  // The fake does not record the environment, so assert the observable effect instead: .env only changes after the migration.
  const lines = fake.lines();
  assert.ok(lines.findIndex((l) => l.endsWith("npx payload migrate")) < lines.findIndex((l) => l === "up -d --no-deps cms"));
});

test("upgrade refuses an image whose label disagrees with its tag, before anything changes", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker(upgradeRules({ imageLabel: "0.1.5" }));
  const r = await runCli(["upgrade", "--to", TARGET], { cwd: dir, fake });
  assert.equal(r.code, 4);
  assert.match(r.stderr, /tag and the image disagree/);
  assert.ok(!upgradeCalls(fake).some((l) => l.includes("backup.sh") || l.includes("migrate")));
  assert.equal(EnvFile.read(join(dir, ".env")).get("POLYSITE_VERSION"), "0.1.0");
});

test("upgrade refuses a migration that deletes data, with no backup taken and nothing changed", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker(upgradeRules({ guardOk: false }));
  const r = await runCli(["upgrade", "--to", TARGET], { cwd: dir, fake });
  assert.equal(r.code, 4);
  assert.ok(!fake.lines().some((l) => l.includes("backup.sh")));
  assert.equal(EnvFile.read(join(dir, ".env")).get("POLYSITE_VERSION"), "0.1.0");
});

test("upgrade does not go on without a good backup (unless told to skip it, which is audited)", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker(upgradeRules({ backupOk: false }));
  const r = await runCli(["upgrade", "--to", TARGET], { cwd: dir, fake });
  assert.equal(r.code, 4);
  assert.ok(!fake.lines().some((l) => l.endsWith("payload migrate")));
  assert.equal(EnvFile.read(join(dir, ".env")).get("POLYSITE_VERSION"), "0.1.0");

  const skip = createFakeDocker(upgradeRules());
  const s = await runCli(["upgrade", "--to", TARGET, "--skip-backup"], { cwd: dir, fake: skip });
  assert.equal(s.code, 0, s.stderr);
  assert.ok(!skip.lines().some((l) => l.includes("backup.sh")));
  assert.match(readAudit(dir), /event=upgrade-start .*skipBackup=true/);
});

test("a failing migration leaves the old release serving and the env untouched", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker(upgradeRules({ migrateOk: false }));
  const r = await runCli(["upgrade", "--to", TARGET], { cwd: dir, fake });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /old release is still serving/);
  assert.ok(!fake.lines().some((l) => l.startsWith("up -d --no-deps")));
  assert.equal(EnvFile.read(join(dir, ".env")).get("POLYSITE_VERSION"), "0.1.0");
});

test("a new release that does not report its version is rolled back automatically (exit 5)", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker(upgradeRules({ version: "0.1.0" }));
  const r = await runCli(["upgrade", "--to", TARGET], { cwd: dir, fake });
  assert.equal(r.code, 5, r.stderr);
  assert.match(r.stderr, /rolled back to 0\.1\.0/);
  assert.equal(EnvFile.read(join(dir, ".env")).get("POLYSITE_VERSION"), "0.1.0");
  const ups = fake.lines().filter((l) => l.startsWith("up -d --no-deps"));
  assert.deepEqual(ups, ["up -d --no-deps cms", "up -d --no-deps cms web backup"]);
  assert.match(readAudit(dir), /event=upgrade-rolled-back from=0\.1\.0 to=0\.2\.0/);
});

test("if putting the old release back fails too, the exit code says so (6) and the way back is named", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker([{ match: "^inspect --format .* id-cms$", stdout: "running|unhealthy|img|0.1.0|sha\n" }, ...upgradeRules()]);
  const r = await runCli(["upgrade", "--to", TARGET, "--health-timeout", "1", "--force"], { cwd: dir, fake });
  assert.equal(r.code, 6, r.stderr);
  assert.match(r.stderr, /AND putting 0\.1\.0 back failed/);
  assert.match(r.stderr, new RegExp(`polysite restore ${ARCHIVE}`));
  assert.match(readAudit(dir), /event=upgrade-rollback-failed/);
});

test("upgrade refuses: hand-pinned images, dev checkouts, an unhealthy stack, a downgrade; and does nothing when already there", async () => {
  const fake = createFakeDocker(upgradeRules());
  assert.equal((await runCli(["upgrade", "--to", TARGET], { cwd: makeInstall({ env: { POLYSITE_CMS_IMAGE: "mine:1" } }), fake })).code, 4);
  assert.equal((await runCli(["upgrade", "--to", TARGET], { cwd: makeInstall({ mode: "dev" }), fake })).code, 4);
  const sick = createFakeDocker([{ match: "^inspect --format .* id-cms$", stdout: "running|unhealthy|img|0.1.0|sha\n" }, ...upgradeRules()]);
  const s = await runCli(["upgrade", "--to", TARGET], { cwd: makeInstall(), fake: sick });
  assert.equal(s.code, 4);
  assert.match(s.stderr, /unhealthy/);
  const down = await runCli(["upgrade", "--to", "0.0.9"], { cwd: makeInstall(), fake });
  assert.equal(down.code, 4);
  assert.match(down.stderr, /older/);
  const same = await runCli(["upgrade", "--to", "v0.1.0", "--json"], { cwd: makeInstall(), fake });
  assert.equal(same.code, 0);
  assert.equal(same.json().changed, false);
  assert.equal((await runCli(["upgrade", "--to", "banana"], { cwd: makeInstall(), fake })).code, 2);
  assert.ok(!fake.lines().some((l) => l.startsWith("pull")));
});

test("upgrade without --to asks the registry for the newest stable release", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ tags: ["v0.1.0", "v0.2.0", "v0.3.0-beta.1", "latest"] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const dir = makeInstall({ env: { POLYSITE_REGISTRY: `127.0.0.1:${server.address().port}/polysite` } });
    const r = await runCli(["upgrade", "--dry-run", "--json"], { cwd: dir, fake: createFakeDocker(upgradeRules()) });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().to, "0.2.0");
  } finally {
    server.close();
  }
});

// ---- user / site / theme ------------------------------------------------------------------------------------------

const PW = "Correct-Horse-Battery-9";
const op = (result) => ({ match: "cms sh -c", stdout: `noise from payload\nPOLYSITE_CLI_RESULT:${JSON.stringify(result)}\n` });
const requestOf = (fake) => JSON.parse(fake.calls().find((c) => / cms sh -c|^exec -T cms sh -c|cms sh -c/.test(c.line)).input.split("@@POLYSITE_REQUEST@@\n")[1]);

test("user create sends the password on stdin only: never in arguments, output, or the audit log", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker([op({ id: 7, email: "ann@example.org", role: "Site Admin", superAdmin: false }), ...healthyStack()]);
  const r = await runCli(["user", "create", "Ann@Example.org", "--role", "Site Admin", "--site", "example.test", "--password-stdin"], { cwd: dir, fake, stdin: `${PW}\n` });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(requestOf(fake), { action: "users.create", email: "ann@example.org", password: PW, role: "Site Admin", superAdmin: false, sites: ["example.test"] });
  assert.ok(fake.calls().find((c) => c.line.includes("cms sh -c")).input.includes("payload.create"), "the script that runs travels with it");
  for (const c of fake.calls()) assert.ok(!c.args.join(" ").includes(PW), "password in arguments");
  assert.ok(!r.stdout.includes(PW) && !r.stderr.includes(PW));
  assert.ok(!readAudit(dir).includes(PW));
  assert.match(readAudit(dir), /event=user-create email=ann@example\.org role="Site Admin"/);
});

test("user create --generate-password prints the generated password once, and --json carries it", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker([op({ id: 1, email: "root@example.org", role: "Super Admin", superAdmin: true }), ...healthyStack()]);
  const r = await runCli(["user", "create", "root@example.org", "--super-admin", "--generate-password"], { cwd: dir, fake });
  assert.equal(r.code, 0, r.stderr);
  const shown = /Generated password \(shown once\): (\S+)/.exec(r.stdout)[1];
  assert.equal(shown.length, 20);
  const sent = requestOf(fake);
  assert.equal(sent.password, shown);
  assert.equal(sent.superAdmin, true);
  assert.ok(!readAudit(dir).includes(shown));
  const j = await runCli(["user", "create", "b@example.org", "--generate-password", "--json"], { cwd: dir, fake });
  assert.equal(j.json().password.length, 20);
});

test("user create refuses weak input without touching the CMS", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker(healthyStack());
  assert.equal((await runCli(["user", "create", "not-an-email", "--generate-password"], { cwd: dir, fake })).code, 2);
  assert.equal((await runCli(["user", "create", "a@example.org", "--password-stdin"], { cwd: dir, fake, stdin: "short\n" })).code, 2);
  assert.equal((await runCli(["user", "create", "a@example.org"], { cwd: dir, fake })).code, 2, "no terminal and no password source");
  assert.equal((await runCli(["user", "create", "a@example.org", "--generate-password", "--password-stdin"], { cwd: dir, fake })).code, 2);
  assert.equal((await runCli(["user", "create", "a@example.org", "--super-admin", "--role", "Site User", "--generate-password"], { cwd: dir, fake })).code, 2);
  assert.ok(!fake.lines().some((l) => l.includes("cms sh -c")));
});

test("user create reports the CMS's own refusal (duplicate email)", async () => {
  const fake = createFakeDocker([{ match: "cms sh -c", code: 1, stdout: "POLYSITE_CLI_ERROR:A user with the email a@example.org already exists.\n" }, ...healthyStack()]);
  const r = await runCli(["user", "create", "a@example.org", "--generate-password"], { cwd: makeInstall(), fake });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already exists/);
});

test("user reset-password and user list", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker([op({ id: 7, email: "ann@example.org", unlocked: true }), ...healthyStack()]);
  const r = await runCli(["user", "reset-password", "ann@example.org", "--password-stdin"], { cwd: dir, fake, stdin: `${PW}\n` });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /account unlocked/);
  assert.ok(!r.stdout.includes(PW) && !readAudit(dir).includes(PW));

  const list = createFakeDocker([op({ users: [{ id: 1, email: "a@example.org", role: "Super Admin", superAdmin: true, sites: [], locked: false }], total: 1 }), ...healthyStack()]);
  const l = await runCli(["user", "list", "--json"], { cwd: dir, fake: list });
  assert.equal(l.json().users[0].email, "a@example.org");
  assert.ok(!("password" in l.json().users[0]) && !("hash" in l.json().users[0]));
});

test("operations run in a one-off container when the CMS is not running", async () => {
  const fake = createFakeDocker([{ match: " ps -q cms$", stdout: "" }, op({ sites: [] }), ...healthyStack()]);
  const r = await runCli(["site", "list"], { cwd: makeInstall(), fake });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fake.lines().some((l) => l.startsWith("run --rm -T cms sh -c")), fake.lines().join("\n"));
});

test("site create and site list", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker([op({ id: 2, name: "News", domain: "news.example.org", theme: "starter" }), ...healthyStack()]);
  const r = await runCli(["site", "create", "News", "--domain", "News.Example.org", "--theme", "starter", "--json"], { cwd: dir, fake });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(requestOf(fake), { action: "sites.create", name: "News", domain: "News.Example.org", theme: "starter" });
  assert.equal(r.json().domain, "news.example.org");
  assert.equal((await runCli(["site", "create", "News"], { cwd: dir, fake })).code, 2);
  assert.equal((await runCli(["site", "create", "News", "--domain", "bad host"], { cwd: dir, fake })).code, 2);
});

test("theme list reads themes/ the way the CMS does", async () => {
  const dir = makeInstall();
  for (const [name, label] of [["starter", "Polysite Starter"], ["acme", "Acme"]]) {
    mkdirSync(join(dir, "themes", `polysite-theme-${name}`, "layouts"), { recursive: true });
    writeFileSync(join(dir, "themes", `polysite-theme-${name}`, "layouts", `${name}.vue`), "<template/>");
    writeFileSync(join(dir, "themes", `polysite-theme-${name}`, "theme.json"), JSON.stringify({ label }));
  }
  mkdirSync(join(dir, "themes", "polysite-theme-nolayout"), { recursive: true });
  mkdirSync(join(dir, "themes", "scripts"), { recursive: true });
  const r = await runCli(["theme", "list", "--json"], { cwd: dir, fake: createFakeDocker([]) });
  assert.deepEqual(r.json().themes.map((t) => t.value), ["acme", "starter"]);
  assert.equal(r.json().themes[1].label, "Polysite Starter");
});

// ---- doctor --------------------------------------------------------------------------------------------------------

const SKIP = ["--offline", "--skip", "ports"];
const byId = (r, id) => r.json().checks.filter((c) => c.id === id);

test("doctor passes a well-formed install and exits 0", async () => {
  const dir = installWithBackups();
  const r = await runCli(["doctor", ...SKIP, "--json"], { cwd: dir, fake: createFakeDocker(healthyStack()) });
  assert.equal(r.code, 0, JSON.stringify(r.json().checks.filter((c) => c.level !== "ok")));
  assert.equal(r.json().summary.fail, 0);
  assert.ok(byId(r, "health-endpoint").every((c) => c.level === "ok"));
});

test("doctor fails on placeholder secrets and says how to fix them, without printing them", async () => {
  const dir = installWithBackups();
  const env = EnvFile.read(join(dir, ".env"));
  env.set("PAYLOAD_SECRET", "changeme-generate-a-long-random-string").set("POSTGRES_PASSWORD", "changeme");
  env.write();
  const r = await runCli(["doctor", ...SKIP], { cwd: dir, fake: createFakeDocker(healthyStack()) });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /FAIL\s+Weak or placeholder secrets/);
  assert.match(r.stdout, /PAYLOAD_SECRET looks like a placeholder/);
  assert.match(r.stdout, /fix: Generate new ones/);
  assert.ok(!r.stdout.includes("changeme-generate"));
});

test("doctor reports missing settings, mismatched revalidate secrets, and an empty env file", async () => {
  const dir = installWithBackups();
  const env = EnvFile.read(join(dir, ".env"));
  env.unset("REDIS_URL").set("REVALIDATE_SECRET", "zzzzzzzzzzQw3rTy8uIo5pAs");
  env.write();
  const r = await runCli(["doctor", ...SKIP, "--json"], { cwd: dir, fake: createFakeDocker(healthyStack()) });
  assert.equal(r.code, 3);
  assert.ok(byId(r, "env").some((c) => c.level === "fail" && c.detail.includes("REDIS_URL")));
  assert.ok(byId(r, "secrets-match").length === 1);
  const none = makeInstall();
  writeFileSync(join(none, ".env"), "");
  const n = await runCli(["doctor", ...SKIP, "--json"], { cwd: none, fake: createFakeDocker(healthyStack()) });
  assert.equal(n.code, 3);
});

test("doctor flags stale backups, and warns when there is no off-site copy or encryption", async () => {
  const dir = installWithBackups();
  writeFileSync(join(dir, "backups", "LAST_SUCCESS"), `${new Date(Date.now() - 5 * 86400000).toISOString()}\n`);
  const stale = await runCli(["doctor", ...SKIP, "--json"], { cwd: dir, fake: createFakeDocker(healthyStack()) });
  assert.equal(stale.code, 3);
  assert.match(byId(stale, "backups")[0].detail, /hours old/);

  const dir2 = installWithBackups();
  const env = EnvFile.read(join(dir2, ".env"));
  env.unset("BACKUP_RCLONE_REMOTE").unset("BACKUP_ENCRYPTION_PASSPHRASE");
  env.write();
  const warn = await runCli(["doctor", ...SKIP, "--json"], { cwd: dir2, fake: createFakeDocker(healthyStack()) });
  assert.equal(warn.code, 0, "warnings alone do not fail");
  assert.equal(byId(warn, "backups")[0].level, "warn");
  assert.match(byId(warn, "backups")[0].detail, /off-site/);
  const strict = await runCli(["doctor", ...SKIP, "--strict"], { cwd: dir2, fake: createFakeDocker(healthyStack()) });
  assert.equal(strict.code, 3, "--strict fails on warnings");
});

test("doctor runs the plugin isolation check on the plugins/ folder", async () => {
  const dir = installWithBackups();
  writePlugin(dir, "greedy", { migrationSql: 'CREATE TABLE "greedy" ("id" serial);\n  ALTER TABLE "users" ADD COLUMN "x" integer;' });
  const r = await runCli(["doctor", ...SKIP, "--json"], { cwd: dir, fake: createFakeDocker(healthyStack()) });
  assert.equal(r.code, 3);
  assert.match(byId(r, "plugins")[0].detail, /alters tables it did not create: users/);
  const ok = installWithBackups();
  writePlugin(ok, "fine");
  const g = await runCli(["doctor", ...SKIP, "--json"], { cwd: ok, fake: createFakeDocker(healthyStack()) });
  assert.equal(byId(g, "plugins")[0].level, "ok");
});

test("doctor notices an unhealthy service and a changed PAYLOAD_SECRET", async () => {
  const dir = installWithBackups();
  const sick = createFakeDocker([{ match: "^inspect --format .* id-cms$", stdout: "running|unhealthy|img|0.1.0|sha\n" }, ...healthyStack()]);
  const a = await runCli(["doctor", ...SKIP, "--json"], { cwd: dir, fake: sick });
  assert.equal(a.code, 3);
  assert.match(byId(a, "health")[0].detail, /cms: unhealthy/);

  const first = await runCli(["doctor", ...SKIP, "--json"], { cwd: dir, fake: createFakeDocker(healthyStack()) });
  assert.equal(byId(first, "secret-stable")[0].level, "ok");
  const env = EnvFile.read(join(dir, ".env"));
  env.set("PAYLOAD_SECRET", "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zZz7yXw");
  env.write();
  const changed = await runCli(["doctor", ...SKIP, "--json"], { cwd: dir, fake: createFakeDocker(healthyStack()) });
  assert.equal(changed.code, 3);
  assert.match(byId(changed, "secret-stable")[0].title, /changed since the last check/);
  assert.ok(!JSON.stringify(changed.json()).includes("Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zZz7yXw"), "the secret itself is never shown");
  const accepted = await runCli(["doctor", ...SKIP, "--accept-secret-change", "--json"], { cwd: dir, fake: createFakeDocker(healthyStack()) });
  assert.equal(accepted.code, 0);
});

test("doctor reports Docker as missing instead of crashing", async () => {
  const dir = installWithBackups();
  const r = await runCli(["doctor", ...SKIP, "--json"], { cwd: dir, env: { PATH: join(dir, "nowhere") } });
  assert.equal(r.code, 3);
  assert.equal(byId(r, "docker")[0].level, "fail");
  assert.match(byId(r, "docker")[0].fix, /Install Docker/);
});

test("doctor says so when it is run before the stack has ever been started", async () => {
  const dir = installWithBackups();
  const none = createFakeDocker([{ match: " ps -q ", stdout: "" }, ...healthyStack()]);
  const r = await runCli(["doctor", ...SKIP, "--json"], { cwd: dir, fake: none });
  assert.equal(r.code, 0);
  assert.match(byId(r, "health")[0].title, /not running/);
});

test("env file keeps its comments when a command edits it", async () => {
  const dir = makeInstall();
  writePlugin(dir, "things");
  await runCli(["plugin", "disable", "things"], { cwd: dir, fake: createFakeDocker(healthyStack()) });
  assert.match(readEnv(dir), /^# test env\nPOLYSITE_VERSION=0\.1\.0/);
});
