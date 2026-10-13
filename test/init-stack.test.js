import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EnvFile } from "../src/lib/envfile.js";
import { createFakeDocker, healthyStack } from "./helpers/fakeDocker.js";
import { makeInstall, readAudit, runCli } from "./helpers/cli.js";

const tmp = () => mkdtempSync(join(tmpdir(), "polysite-test-"));

// ---- init ---------------------------------------------------------------------------------------------------------

test("init writes a production install with generated secrets and prints none of them", async () => {
  const dir = join(tmp(), "site");
  const r = await runCli(["init", dir, "--domain", "Example.ORG"]);
  assert.equal(r.code, 0, r.stderr);
  for (const f of ["docker-compose.prod.yml", "Caddyfile", ".env", ".gitignore", ".polysite/config.json"]) assert.ok(existsSync(join(dir, f)), f);
  const env = EnvFile.read(join(dir, ".env"));
  assert.equal(env.get("SITE_DOMAIN"), "example.org");
  assert.equal(env.get("CMS_DOMAIN"), "admin.example.org");
  assert.equal(env.get("SITE_SCHEME"), "https");
  assert.match(env.get("POLYSITE_VERSION"), /^\d+\.\d+\.\d+$/);
  for (const k of ["PAYLOAD_SECRET", "NUXT_REVALIDATE_SECRET", "POSTGRES_PASSWORD", "POLYSITE_SETUP_TOKEN", "BACKUP_ENCRYPTION_PASSPHRASE"]) {
    assert.ok(env.get(k).length >= 24, `${k} should be long`);
    assert.ok(!r.stdout.includes(env.get(k)) && !r.stderr.includes(env.get(k)), `${k} leaked to the terminal`);
  }
  assert.equal(env.get("NUXT_REVALIDATE_SECRET"), env.get("REVALIDATE_SECRET"));
  assert.ok(env.get("DATABASE_URL").includes(env.get("POSTGRES_PASSWORD")));
  if (process.platform !== "win32") assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
  const compose = readFileSync(join(dir, "docker-compose.prod.yml"), "utf8");
  assert.ok(!compose.includes("#@db") && !compose.includes("{{"), "markers and placeholders are resolved");
  assert.match(compose, /^  db:$/m);
  assert.match(compose, /name: polysite-site\n/);
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /^\.env$/m);
  assert.match(readAudit(dir), /event=init /);
  assert.match(r.stdout, /polysite doctor/);
});

test("init generates different secrets each time", async () => {
  const a = join(tmp(), "a");
  const b = join(tmp(), "b");
  await runCli(["init", a, "--domain", "example.org"]);
  await runCli(["init", b, "--domain", "example.org"]);
  assert.notEqual(EnvFile.read(join(a, ".env")).get("PAYLOAD_SECRET"), EnvFile.read(join(b, ".env")).get("PAYLOAD_SECRET"));
});

test("init with an external database leaves out the db service and its settings", async () => {
  const dir = join(tmp(), "x");
  const r = await runCli(["init", dir, "--domain", "example.org", "--database", "external", "--database-url", "postgres://u:p@db.internal:5432/polysite"]);
  assert.equal(r.code, 0, r.stderr);
  const compose = readFileSync(join(dir, "docker-compose.prod.yml"), "utf8");
  assert.ok(!/^  db:$/m.test(compose) && !compose.includes("db-data") && !compose.includes("service_healthy"));
  const env = EnvFile.read(join(dir, ".env"));
  assert.equal(env.get("DATABASE_URL"), "postgres://u:p@db.internal:5432/polysite");
  assert.equal(env.has("POSTGRES_PASSWORD"), false);
});

test("init never overwrites an existing .env, and refuses bad input with exit code 2", async () => {
  const dir = join(tmp(), "again");
  assert.equal((await runCli(["init", dir, "--domain", "example.org"])).code, 0);
  const before = readFileSync(join(dir, ".env"), "utf8");
  const second = await runCli(["init", dir, "--domain", "example.org", "--force"]);
  assert.equal(second.code, 4);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), before);
  assert.equal((await runCli(["init", join(tmp(), "n"), "--domain", "not a host"])).code, 2);
  assert.equal((await runCli(["init", join(tmp(), "n"), "--domain", "example.org", "--cms-domain", "example.org"])).code, 2);
  assert.equal((await runCli(["init", join(tmp(), "n"), "--domain", "example.org", "--core-version", "banana"])).code, 2);
  assert.equal((await runCli(["init", join(tmp(), "n")])).code, 2, "no domain and no terminal");
});

test("init --dry-run writes nothing", async () => {
  const dir = join(tmp(), "dry");
  const r = await runCli(["init", dir, "--domain", "example.org", "--dry-run", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(dir), false);
  assert.equal(r.json().dryRun, true);
});

// ---- stack --------------------------------------------------------------------------------------------------------

const BASE = ["-p", "polysite-test"];

test("up runs compose up -d and waits for cms and web to be healthy", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker(healthyStack());
  const r = await runCli(["up"], { cwd: dir, fake });
  assert.equal(r.code, 0, r.stderr);
  const lines = fake.lines();
  assert.ok(lines.includes("up -d"), lines.join("\n"));
  const full = fake.calls().find((c) => c.line === "up -d").args;
  assert.deepEqual(full.slice(0, 3), ["compose", ...BASE]);
  assert.ok(full.includes("--env-file") && full.includes(join(dir, ".env")));
  assert.ok(full.includes("-f") && full.includes(join(dir, "docker-compose.prod.yml")));
});

test("up refuses a production install with no release set", async () => {
  const dir = makeInstall({ env: { POLYSITE_VERSION: null } });
  const fake = createFakeDocker(healthyStack());
  const r = await runCli(["up"], { cwd: dir, fake });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /POLYSITE_VERSION/);
  assert.ok(!fake.lines().some((l) => l.startsWith("up")));
});

test("up reports a service that never becomes healthy", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker([{ match: "^inspect --format .* id-cms$", stdout: "running|unhealthy|img|0.1.0|sha\n" }, ...healthyStack()]);
  const r = await runCli(["up"], { cwd: dir, fake });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cms is unhealthy/);
});

test("up rejects a service name the compose files do not define", async () => {
  const fake = createFakeDocker(healthyStack());
  const r = await runCli(["up", "nginx"], { cwd: makeInstall(), fake });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown service: nginx/);
});

test("--dry-run announces a mutating compose command instead of running it", async () => {
  const fake = createFakeDocker(healthyStack());
  const r = await runCli(["restart", "cms", "--dry-run"], { cwd: makeInstall(), fake });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /dry-run .*restart cms/);
  assert.ok(!fake.lines().includes("restart cms"));
});

test("restart and logs build the expected commands", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker(healthyStack());
  assert.equal((await runCli(["restart", "web"], { cwd: dir, fake })).code, 0);
  assert.equal((await runCli(["logs", "cms", "--tail", "20", "-f", "--since", "5m"], { cwd: dir, fake })).code, 0);
  const lines = fake.lines();
  assert.ok(lines.includes("restart web"));
  assert.ok(lines.includes("logs --tail 20 --follow --since 5m cms"));
  assert.equal((await runCli(["logs", "--tail", "lots"], { cwd: dir, fake })).code, 2);
});

test("down keeps the data; --volumes needs the project name typed back, and --yes is not enough", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker(healthyStack());
  assert.equal((await runCli(["down"], { cwd: dir, fake })).code, 0);
  assert.ok(fake.lines().includes("down"));

  fake.clear();
  const refusedNoConfirm = await runCli(["down", "--volumes", "--yes"], { cwd: dir, fake });
  assert.equal(refusedNoConfirm.code, 4);
  assert.ok(!fake.lines().some((l) => l.startsWith("down")));

  const wrong = await runCli(["down", "--volumes", "--confirm", "nope"], { cwd: dir, fake });
  assert.equal(wrong.code, 4);

  const ok = await runCli(["down", "--volumes", "--confirm", "polysite-test"], { cwd: dir, fake });
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(fake.lines().includes("down --volumes"));
  assert.match(readAudit(dir), /event=down-volumes project=polysite-test/);
});

test("down --volumes accepts the name typed at a prompt", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker(healthyStack());
  const r = await runCli(["down", "--volumes"], { cwd: dir, fake, stdin: "polysite-test\n" });
  // Without a terminal the prompt is refused rather than guessed at.
  assert.equal(r.code, 4);
});

test("status lists each service and exits 3 when one is not healthy", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker(healthyStack());
  const ok = await runCli(["status", "--json"], { cwd: dir, fake });
  assert.equal(ok.code, 0, ok.stderr);
  const j = ok.json();
  assert.equal(j.release, "0.1.0");
  assert.equal(j.services.find((s) => s.service === "cms").health, "healthy");
  assert.equal(j.app.cms.version, "0.1.0");

  fake.setRules([{ match: "^inspect --format .* id-web$", stdout: "exited||img|0.1.0|sha\n" }, ...healthyStack()]);
  const bad = await runCli(["status"], { cwd: dir, fake });
  assert.equal(bad.code, 3);
});

test("commands find the install from a subfolder, with --dir, and say so when there is none", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker(healthyStack());
  assert.equal((await runCli(["status"], { cwd: join(dir, "backups"), fake })).code, 0);
  assert.equal((await runCli(["--dir", dir, "status"], { cwd: tmp(), fake })).code, 0);
  assert.equal((await runCli(["status", "-C", dir], { cwd: tmp(), fake })).code, 0);
  const none = await runCli(["status"], { cwd: tmp(), fake });
  assert.equal(none.code, 2);
  assert.match(none.stderr, /No Polysite install found/);
});

test("help: every command documents itself and exits 0; unknown commands exit 2", async () => {
  const top = await runCli(["--help"]);
  assert.equal(top.code, 0);
  for (const name of ["init", "doctor", "up", "down", "status", "logs", "restart", "plugin", "migrate", "backup", "restore", "upgrade", "user", "site", "theme", "version"]) {
    assert.match(top.stdout, new RegExp(`^  ${name}\\s`, "m"), name);
    const h = await runCli([name, "--help"]);
    assert.equal(h.code, 0, name);
    assert.match(h.stdout, /Usage: polysite /, name);
  }
  for (const sub of ["plugin list", "plugin add", "plugin remove", "plugin enable", "plugin disable", "plugin purge", "user create", "user reset-password", "user list", "site create", "site list", "theme list"]) {
    const h = await runCli([...sub.split(" "), "--help"]);
    assert.equal(h.code, 0, sub);
    assert.match(h.stdout, new RegExp(`Usage: polysite ${sub}`), sub);
  }
  assert.equal((await runCli(["frobnicate"])).code, 2);
  assert.equal((await runCli(["up", "--no-such-flag"])).code, 2);
  assert.equal((await runCli(["--version"])).stdout.trim(), JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});

test("--json keeps stdout to one JSON document even when progress is printed", async () => {
  const dir = makeInstall();
  const fake = createFakeDocker(healthyStack());
  const r = await runCli(["up", "--json"], { cwd: dir, fake });
  assert.equal(r.code, 0);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
  const bad = await runCli(["status", "--json"], { cwd: tmp(), fake });
  assert.equal(JSON.parse(bad.stdout).ok, false);
});
