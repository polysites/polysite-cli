import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EnvFile } from "../src/lib/envfile.js";
import { checkMigrationText } from "../src/lib/isolation.js";
import { buildPurgePlan } from "../src/lib/pluginPlan.js";
import { latestVersion } from "../src/lib/registry.js";
import { generatePassword, randomSecret, weakSecretReason } from "../src/lib/secrets.js";
import { compareVersions, normalizeVersion } from "../src/lib/semver.js";
import { applyDbMarkers, fill } from "../src/lib/templates.js";

test("env file: keeps comments, order and CRLF; edits only the key asked for", () => {
  const e = new EnvFile("# top\r\nA=1\r\n\r\n# B=old example\r\nC=\"x y\"\r\n");
  e.set("A", "2").set("B", "new").set("D", "has space");
  assert.equal(e.get("A"), "2");
  assert.equal(e.get("C"), "x y");
  assert.equal(e.toString(), '# top\r\nA=2\r\n\r\nB=new\r\nC="x y"\r\nD="has space"\r\n');
  e.unset("A");
  assert.equal(e.has("A"), false);
});

test("env file: values with # or $ are quoted so compose reads them back unchanged", () => {
  const e = new EnvFile("");
  e.set("P", "a#b$c");
  assert.equal(e.toString(), 'P="a#b\\$c"\n');
  assert.throws(() => e.set("X", "line\nbreak"));
});

test("env file: write is atomic and private", () => {
  const dir = mkdtempSync(join(tmpdir(), "pe-"));
  const f = join(dir, ".env");
  writeFileSync(f, "A=1\n", { mode: 0o644 });
  const e = EnvFile.read(f);
  e.set("A", "2").write();
  assert.equal(readFileSync(f, "utf8"), "A=2\n");
  if (process.platform !== "win32") assert.equal(statSync(f).mode & 0o777, 0o600);
});

test("secrets: random secrets are long and distinct; weak ones are named without echoing them", () => {
  assert.equal(randomSecret(32).length, 43);
  assert.notEqual(randomSecret(), randomSecret());
  assert.match(generatePassword(20), /^[A-Za-z0-9._-]{20}$/);
  assert.equal(weakSecretReason(randomSecret()), null);
  assert.match(weakSecretReason("changeme-generate-a-long-random-string"), /placeholder/);
  assert.match(weakSecretReason("short"), /shorter than 32/);
  assert.match(weakSecretReason("a".repeat(40)), /variety/);
  assert.ok(!weakSecretReason("changeme").includes("changeme"));
});

test("versions: parse, normalise and order, including pre-releases", () => {
  assert.equal(normalizeVersion("v1.2.3"), "1.2.3");
  assert.equal(normalizeVersion("1.2"), null);
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.ok(compareVersions("1.0.0-beta.2", "1.0.0-beta.10") < 0);
  assert.ok(compareVersions("1.0.0-rc.1", "1.0.0") < 0);
  assert.equal(compareVersions("0.1.0", "v0.1.0"), 0);
});

test("templates: placeholders are filled, a missing one throws, db markers switch lines on and off", () => {
  assert.equal(fill("a {{X}} b", { X: 1 }), "a 1 b");
  assert.throws(() => fill("{{NOPE}}", {}), /NOPE/);
  const t = "keep\n#@db   only-local\nend";
  assert.equal(applyDbMarkers(t, true), "keep\n  only-local\nend");
  assert.equal(applyDbMarkers(t, false), "keep\nend");
});

test("isolation: a migration may alter only what it creates (plus Payload's bookkeeping tables) and never drop in up()", () => {
  const good = `export async function up({ db, sql }) { await db.execute(sql\`
    CREATE TABLE "things" ("id" serial);
    ALTER TABLE "things" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "things_id" integer;\`) }
    export async function down({ db, sql }) { await db.execute(sql\`DROP TABLE "things" CASCADE;\`) }`;
  assert.deepEqual(checkMigrationText(good), []);
  const alters = good.replace('CREATE TABLE "things"', 'CREATE TABLE "other"') + "";
  assert.match(checkMigrationText(alters, "m.js")[0], /alters tables it did not create: things/);
  assert.match(checkMigrationText('export async function up(){ sql`ALTER TABLE "users" ADD COLUMN "x" int;` }')[0], /users/);
  assert.match(checkMigrationText('export async function up(){ sql`CREATE TABLE "a" (id int); DROP TABLE "a";` }').join(" "), /deletes data/);
  assert.match(checkMigrationText('export async function up(){ sql`ALTER TYPE "public"."enum_pages_status" ADD VALUE \'x\';` }')[0], /types it did not create/);
});

const plugin = (over = {}) => ({
  folder: "things",
  manifest: { slug: "things" },
  problems: [],
  created: { files: ["20260101_things.js"], tables: ["things", "things_locales"], types: ["enum_things_kind"], relColumns: { payload_locked_documents_rels: ["things_id"], site_urls_rels: ["things_id"] } },
  snapshot: {
    tables: ["users", "pages", "things", "things_locales"],
    enums: ["enum_pages_status", "enum_things_kind"],
    relColumns: { payload_locked_documents_rels: ["pages_id", "things_id"], payload_preferences_rels: ["users_id"], site_urls_rels: ["pages_id", "things_id"] },
  },
  ...over,
});
const core = { tables: ["users", "pages", "payload_migrations"], enums: ["enum_pages_status"], relColumns: { payload_locked_documents_rels: ["pages_id"], payload_preferences_rels: ["users_id"], site_urls_rels: ["pages_id"] } };

test("purge plan: drops exactly the plugin's tables, types and bookkeeping columns, plus its migration records", () => {
  const plan = buildPurgePlan({ slug: "things", plugin: plugin(), core });
  assert.deepEqual(plan.tables, ["things", "things_locales"]);
  assert.deepEqual(plan.enums, ["enum_things_kind"]);
  assert.deepEqual(plan.statements, [
    'ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "things_id";',
    'ALTER TABLE "site_urls_rels" DROP COLUMN IF EXISTS "things_id";',
    'DROP TABLE IF EXISTS "things" CASCADE;',
    'DROP TABLE IF EXISTS "things_locales" CASCADE;',
    'DROP TYPE IF EXISTS "public"."enum_things_kind";',
    `DELETE FROM "payload_migrations" WHERE "name" LIKE 'things\\_\\_%' ESCAPE '\\';`,
  ]);
});

test("purge plan: a table the plugin's SQL never created is not dropped even if the snapshot lists it", () => {
  const p = plugin();
  p.snapshot.tables.push("legacy_core_table");
  assert.ok(!buildPurgePlan({ slug: "things", plugin: p, core }).tables.includes("legacy_core_table"));
});

test("purge plan: refuses to name a core table, a missing snapshot, an odd slug, or nothing to do", () => {
  const evil = plugin({ created: { ...plugin().created, tables: ["things", "users_x"] }, snapshot: { ...plugin().snapshot, tables: ["things", "users_x"] } });
  assert.throws(() => buildPurgePlan({ slug: "things", plugin: evil, core }), /core tables/);
  assert.throws(() => buildPurgePlan({ slug: "things", plugin: plugin({ snapshot: null }), core }), /no migration snapshot/);
  assert.throws(() => buildPurgePlan({ slug: "things", plugin: plugin(), core: null }), /core's migration snapshot/);
  assert.throws(() => buildPurgePlan({ slug: "x; DROP TABLE users", plugin: plugin(), core }), /not a valid plugin slug/);
  assert.throws(() => buildPurgePlan({ slug: "things", plugin: plugin({ created: { files: [], tables: [], types: [], relColumns: {} } }), core }), /owns no tables/);
  const odd = plugin({ created: { ...plugin().created, tables: ['things"; DROP TABLE users; --'] }, snapshot: { ...plugin().snapshot, tables: ['things"; DROP TABLE users; --'] } });
  assert.throws(() => buildPurgePlan({ slug: "things", plugin: odd, core }), /odd identifier/);
});

test("registry: finds the newest stable tag over HTTP, and the newest pre-release when asked", async () => {
  const server = createServer((req, res) => {
    assert.match(req.url, /^\/v2\/polysite\/polysite-cms\/tags\/list/);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ tags: ["latest", "v0.1.0", "v0.2.0-beta.1", "v0.1.10", "v0.1.9", "sha-abc"] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const registry = `127.0.0.1:${server.address().port}/polysite`;
  try {
    assert.equal(await latestVersion(registry, "polysite-cms"), "0.1.10");
    assert.equal(await latestVersion(registry, "polysite-cms", { pre: true }), "0.2.0-beta.1");
  } finally {
    server.close();
  }
});
