import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EnvFile } from "../src/lib/envfile.js";
import { createFakeDocker, healthyStack } from "./helpers/fakeDocker.js";
import { makeInstall, readAudit, readEnv, runCli } from "./helpers/cli.js";
import { writeCore, writePlugin } from "./helpers/plugins.js";

const PSQL = "exec -T backup sh -c psql";

/** Rules for a database that has the plugin's tables (and then, after the drop, does not). */
function dbRules({ before = "users\npages\npayload_migrations\nthings\nthings_locales\n", after = "users\npages\npayload_migrations\n", applied = "things__20260102_000000_tables\n", cols = "payload_locked_documents_rels|things_id\nsite_urls_rels|things_id\n", backupOk = true, verifyOk = true } = {}) {
  return [
    { match: "backup.sh$", ...(backupOk ? { stdout: "2026-01-01T00:00:00Z Backup: wrote polysite-20260101T000000Z.tar.enc (1.2M), encrypted\n" } : { code: 1, stdout: "2026-01-01T00:00:00Z ERROR: pg_dump failed\n" }) },
    { match: "verify.sh polysite-20260101T000000Z.tar.enc$", ...(verifyOk ? { stdout: "Verified\n" } : { code: 1, stdout: "ERROR: The restored database doesn't match\n" }) },
    { match: `${PSQL}.*single-transaction`, stdout: "" },
    { match: PSQL, inputMatch: "pg_tables", responses: [{ stdout: before }, { stdout: after }] },
    { match: PSQL, inputMatch: "FROM payload_migrations|SELECT name", stdout: applied },
    { match: PSQL, inputMatch: "information_schema", stdout: cols },
    { match: PSQL, inputMatch: "count\\(\\*\\)", stdout: "things|42\nthings_locales|40\n" },
    ...healthyStack(),
  ];
}

function setup() {
  const dir = makeInstall({ env: { POLYSITE_PLUGINS_OFF: "things" } });
  writeCore(dir);
  writePlugin(dir, "things");
  return dir;
}

test("plugin list shows version, scope, state, and whether its tables exist", async () => {
  const dir = setup();
  const fake = createFakeDocker(dbRules());
  const r = await runCli(["plugin", "list", "--json"], { cwd: dir, fake });
  assert.equal(r.code, 0, r.stderr);
  const [p] = r.json().plugins;
  assert.equal(p.slug, "things");
  assert.equal(p.version, "1.0.0");
  assert.equal(p.scope, "per-site");
  assert.equal(p.state, "disabled");
  assert.equal(p.tables, "2/2");
  assert.equal(p.migrations, "1/1");
});

test("plugin list copes with a database that cannot be asked", async () => {
  const dir = setup();
  const fake = createFakeDocker([{ match: PSQL, code: 1, stderr: "connection refused" }, ...healthyStack()]);
  const r = await runCli(["plugin", "list", "--json"], { cwd: dir, fake });
  assert.equal(r.code, 0);
  assert.equal(r.json().databaseReachable, false);
  assert.equal(r.json().plugins[0].tables, "?/2");
});

test("plugin list names problems in a broken plugin", async () => {
  const dir = makeInstall();
  writeCore(dir);
  writePlugin(dir, "broken", { problems: ["no-module"] });
  const fake = createFakeDocker(dbRules());
  const r = await runCli(["plugin", "list", "--json"], { cwd: dir, fake });
  assert.equal(r.json().plugins[0].state, "problem");
  assert.match(r.json().plugins[0].problems[0], /type.*module/);
});

test("plugin disable and enable edit POLYSITE_PLUGINS_OFF and keep the rest of .env", async () => {
  const dir = makeInstall();
  writePlugin(dir, "things");
  writePlugin(dir, "other");
  const fake = createFakeDocker(dbRules());
  assert.equal((await runCli(["plugin", "disable", "things"], { cwd: dir, fake })).code, 0);
  assert.equal(EnvFile.read(join(dir, ".env")).get("POLYSITE_PLUGINS_OFF"), "things");
  assert.equal((await runCli(["plugin", "disable", "other"], { cwd: dir, fake })).code, 0);
  assert.equal(EnvFile.read(join(dir, ".env")).get("POLYSITE_PLUGINS_OFF"), "things,other");
  assert.match(readEnv(dir), /^# test env/);
  assert.equal((await runCli(["plugin", "enable", "things"], { cwd: dir, fake })).code, 0);
  assert.equal(EnvFile.read(join(dir, ".env")).get("POLYSITE_PLUGINS_OFF"), "other");
  assert.equal((await runCli(["plugin", "enable", "other"], { cwd: dir, fake })).code, 0);
  assert.equal(EnvFile.read(join(dir, ".env")).has("POLYSITE_PLUGINS_OFF"), false);
  assert.equal((await runCli(["plugin", "disable", "ghost"], { cwd: dir, fake })).code, 2);
  assert.match(readAudit(dir), /event=plugin-disable slug=things/);
  const dry = await runCli(["plugin", "disable", "things", "--dry-run"], { cwd: dir, fake });
  assert.match(dry.stdout, /would set POLYSITE_PLUGINS_OFF=things/);
  assert.equal(EnvFile.read(join(dir, ".env")).has("POLYSITE_PLUGINS_OFF"), false);
});

test("plugin disable --restart recreates cms and web", async () => {
  const dir = makeInstall();
  writePlugin(dir, "things");
  const fake = createFakeDocker(healthyStack());
  await runCli(["plugin", "disable", "things", "--restart"], { cwd: dir, fake });
  assert.ok(fake.lines().includes("up -d --force-recreate --no-deps cms web"));
});

test("plugin add copies a valid plugin, runs nothing from it, and never overwrites", async () => {
  const dir = makeInstall();
  const src = mkdtempSync(join(tmpdir(), "src-"));
  const pluginDir = writePlugin(src, "widgets");
  const r = await runCli(["plugin", "add", pluginDir], { cwd: dir, fake: createFakeDocker([]) });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(dir, "plugins", "widgets", "polysite.plugin.json")));
  assert.match(readAudit(dir), /event=plugin-add slug=widgets/);
  assert.match(r.stdout, /polysite migrate/);
  const again = await runCli(["plugin", "add", pluginDir], { cwd: dir, fake: createFakeDocker([]) });
  assert.equal(again.code, 4);
});

test("plugin add refuses a plugin whose migrations touch tables it does not own", async () => {
  const dir = makeInstall();
  const src = mkdtempSync(join(tmpdir(), "src-"));
  const pluginDir = writePlugin(src, "greedy", { migrationSql: 'CREATE TABLE "greedy" ("id" serial);\n  ALTER TABLE "users" ADD COLUMN "x" integer;' });
  const r = await runCli(["plugin", "add", pluginDir], { cwd: dir, fake: createFakeDocker([]) });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /alters tables it did not create: users/);
  assert.equal(existsSync(join(dir, "plugins", "greedy")), false);
});

test("plugin add from a folder holding several plugins needs --only or --all", async () => {
  const dir = makeInstall();
  const src = mkdtempSync(join(tmpdir(), "src-"));
  writePlugin(src, "one");
  writePlugin(src, "two");
  const pluginsRoot = join(src, "plugins");
  const fake = createFakeDocker([]);
  assert.equal((await runCli(["plugin", "add", pluginsRoot], { cwd: dir, fake })).code, 2);
  assert.equal((await runCli(["plugin", "add", pluginsRoot, "--only", "two"], { cwd: dir, fake })).code, 0);
  assert.ok(existsSync(join(dir, "plugins", "two")) && !existsSync(join(dir, "plugins", "one")));
  assert.equal((await runCli(["plugin", "add", pluginsRoot, "--all"], { cwd: dir, fake })).code, 4, "two is already there");
});

test("plugin add --dry-run copies nothing", async () => {
  const dir = makeInstall();
  const src = mkdtempSync(join(tmpdir(), "src-"));
  const pluginDir = writePlugin(src, "widgets");
  const r = await runCli(["plugin", "add", pluginDir, "--dry-run"], { cwd: dir, fake: createFakeDocker([]) });
  assert.equal(r.code, 0);
  assert.equal(existsSync(join(dir, "plugins")), false);
});

test("plugin remove moves the folder aside (code only) and says the data stays", async () => {
  const dir = makeInstall();
  writePlugin(dir, "things");
  const fake = createFakeDocker(healthyStack());
  const r = await runCli(["plugin", "remove", "things", "--yes"], { cwd: dir, fake });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(join(dir, "plugins", "things")), false);
  const kept = join(dir, ".polysite", "removed-plugins");
  assert.ok(existsSync(kept));
  assert.match(r.stdout, /stay in the database/);
  assert.ok(!fake.lines().some((l) => /DROP/.test(l)));
  assert.equal((await runCli(["plugin", "remove", "things", "--yes"], { cwd: dir, fake })).code, 2);
});

test("plugin remove asks first when there is no --yes (refused without a terminal)", async () => {
  const dir = makeInstall();
  writePlugin(dir, "things");
  const r = await runCli(["plugin", "remove", "things"], { cwd: dir, fake: createFakeDocker(healthyStack()) });
  assert.equal(r.code, 4);
  assert.ok(existsSync(join(dir, "plugins", "things")));
});

// ---- purge ---------------------------------------------------------------------------------------------------------

const purgeCalls = (fake) => fake.calls().filter((c) => c.line.startsWith(PSQL) && /DROP/.test(c.input));

test("purge --dry-run prints exactly what would be dropped and drops nothing", async () => {
  const dir = setup();
  const fake = createFakeDocker(dbRules());
  const r = await runCli(["plugin", "purge", "things", "--dry-run", "--json"], { cwd: dir, fake });
  assert.equal(r.code, 0, r.stderr);
  const j = r.json();
  assert.deepEqual(j.plan.tables, ["things", "things_locales"]);
  assert.deepEqual(j.plan.enums, ["enum_things_kind"]);
  assert.ok(j.plan.statements.includes('DROP TABLE IF EXISTS "things" CASCADE;'));
  assert.ok(j.plan.statements.includes('ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "things_id";'));
  assert.deepEqual(j.rows, { things: 42, things_locales: 40 });
  assert.equal(purgeCalls(fake).length, 0);
  assert.ok(!fake.lines().some((l) => l.includes("backup.sh")), "a dry run does not even back up");
});

test("purge refuses while the plugin is still switched on", async () => {
  const dir = makeInstall();
  writeCore(dir);
  writePlugin(dir, "things");
  const fake = createFakeDocker(dbRules());
  const r = await runCli(["plugin", "purge", "things", "--confirm", "things"], { cwd: dir, fake });
  assert.equal(r.code, 4);
  assert.match(r.stderr, /still switched on/);
  assert.equal(purgeCalls(fake).length, 0);
});

test("purge needs the slug typed back; --yes and a wrong --confirm do nothing", async () => {
  const dir = setup();
  const fake = createFakeDocker(dbRules());
  assert.equal((await runCli(["plugin", "purge", "things"], { cwd: dir, fake })).code, 4);
  assert.equal((await runCli(["plugin", "purge", "things", "--yes"], { cwd: dir, fake })).code, 4);
  const wrong = await runCli(["plugin", "purge", "things", "--confirm", "thing"], { cwd: dir, fake });
  assert.equal(wrong.code, 4);
  assert.equal(purgeCalls(fake).length, 0);
  assert.ok(!fake.lines().some((l) => l.includes("backup.sh")), "no backup either: nothing was confirmed");
});

test("purge refuses without a good backup and drops nothing", async () => {
  for (const [backupOk, verifyOk] of [[false, true], [true, false]]) {
    const dir = setup();
    const fake = createFakeDocker(dbRules({ backupOk, verifyOk }));
    const r = await runCli(["plugin", "purge", "things", "--confirm", "things"], { cwd: dir, fake });
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /without a good backup/);
    assert.equal(purgeCalls(fake).length, 0);
    assert.ok(!/event=plugin-purge/.test(readAudit(dir)));
  }
});

test("purge, confirmed: backs up and verifies first, then drops in one transaction, and writes the audit line", async () => {
  const dir = setup();
  const fake = createFakeDocker(dbRules());
  const r = await runCli(["plugin", "purge", "things", "--confirm", "things", "--json"], { cwd: dir, fake });
  assert.equal(r.code, 0, r.stderr);
  const lines = fake.lines();
  const iBackup = lines.findIndex((l) => l.endsWith("/opt/backup/backup.sh"));
  const iVerify = lines.findIndex((l) => l.includes("verify.sh polysite-20260101T000000Z.tar.enc"));
  const iDrop = lines.findIndex((l, i) => l.startsWith(PSQL) && fake.calls()[i].input.includes("DROP TABLE"));
  assert.ok(iBackup >= 0 && iVerify > iBackup && iDrop > iVerify, lines.join("\n"));
  const drop = fake.calls()[iDrop];
  assert.match(drop.line, /--single-transaction/);
  assert.match(drop.input, /DROP TABLE IF EXISTS "things" CASCADE;/);
  assert.match(drop.input, /DELETE FROM "payload_migrations" WHERE "name" LIKE 'things\\_\\_%'/);
  assert.ok(!/DROP TABLE IF EXISTS "(users|pages|sites)"/.test(drop.input));
  const audit = readAudit(dir);
  assert.match(audit, /event=plugin-purge-start slug=things tables=2 rows=82 backup=polysite-20260101T000000Z\.tar\.enc/);
  assert.match(audit, /event=plugin-purge-done slug=things .*remaining=0/);
  assert.equal(r.json().purged, true);
});

test("purge works from the copy `plugin remove` kept, and a failed drop is reported and audited", async () => {
  const dir = setup();
  const fake = createFakeDocker(dbRules());
  fake.setRules([{ match: `${PSQL}.*single-transaction`, code: 1, stderr: 'ERROR: cannot drop table "things" because other objects depend on it' }, ...dbRules()]);
  await runCli(["plugin", "enable", "things"], { cwd: dir, fake });
  await runCli(["plugin", "remove", "things", "--yes"], { cwd: dir, fake });
  await runCli(["plugin", "disable", "things"], { cwd: dir, fake: createFakeDocker(dbRules()) });
  const r = await runCli(["plugin", "purge", "things", "--confirm", "things"], { cwd: dir, fake });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /rolled back/);
  assert.match(readAudit(dir), /event=plugin-purge-failed/);
});

test("purge with nothing left to drop says so and changes nothing", async () => {
  const dir = setup();
  const fake = createFakeDocker(dbRules({ before: "users\npages\npayload_migrations\n", cols: "", applied: "" }));
  const r = await runCli(["plugin", "purge", "things", "--confirm", "things", "--json"], { cwd: dir, fake });
  assert.equal(r.code, 0);
  assert.equal(r.json().purged, false);
  assert.equal(purgeCalls(fake).length, 0);
});

test("purge refuses an unknown plugin and a plugin whose snapshot is missing", async () => {
  const dir = setup();
  const fake = createFakeDocker(dbRules());
  assert.equal((await runCli(["plugin", "purge", "nope", "--confirm", "nope"], { cwd: dir, fake })).code, 1);
  writeFileSync(join(dir, "plugins", "things", "migrations", "20260102_000000_tables.json"), "{}");
  const r = await runCli(["plugin", "purge", "things", "--confirm", "things", "--dry-run"], { cwd: dir, fake });
  assert.notEqual(r.code, 0);
});

test("plugins baked into the image are read through the CMS container", async () => {
  const dir = makeInstall();
  mkdirSync(dir, { recursive: true });
  const facts = {
    core: { file: "c.json", tables: ["users", "payload_migrations"], enums: [], relColumns: { payload_locked_documents_rels: [], payload_preferences_rels: [], site_urls_rels: [] } },
    plugins: [{ folder: "baked", manifest: { slug: "baked", version: "2.0.0", scope: "global" }, problems: [], created: { files: ["m.js"], tables: ["baked"], types: [], relColumns: {} }, snapshot: { file: "s.json", tables: ["users", "baked"], enums: [], relColumns: { payload_locked_documents_rels: [], payload_preferences_rels: [], site_urls_rels: [] } } }],
  };
  const fake = createFakeDocker([
    { match: "exec -T cms node --input-type=module -e", stdout: `${JSON.stringify(facts)}\n` },
    { match: PSQL, inputMatch: "pg_tables", stdout: "users\nbaked\n" },
    ...healthyStack(),
  ]);
  const r = await runCli(["plugin", "list", "--json"], { cwd: dir, fake });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().source, "image");
  assert.equal(r.json().plugins[0].tables, "1/1");
  const program = fake.calls().find((c) => c.line.includes("--input-type=module")).args.at(-1);
  assert.match(program, /collectFacts\(\{"pluginsDir":"\/repo\/plugins"/);
  assert.ok(!/^export /m.test(program), "the program is a script, not a module with exports");
});
