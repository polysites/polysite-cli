// Regression tests for bugs that only a real Docker stack showed (found 2026-10-15). The fake `docker` cannot run
// a shell or a compose file, so each test checks the exact property that was wrong.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createDocker } from "../src/lib/docker.js";
import { createFakeDocker, healthyStack } from "./helpers/fakeDocker.js";
import { makeInstall, runCli } from "./helpers/cli.js";
import { writePlugin } from "./helpers/plugins.js";

const ARCHIVE = "polysite-20260101T000000Z.tar.enc";

test("restore asks compose for profile-gated services: `config --services` alone leaves `restore` out", async () => {
  const dir = makeInstall();
  writeFileSync(join(dir, "backups", ARCHIVE), "x".repeat(2048));
  writeFileSync(join(dir, "backups", `${ARCHIVE}.sha256`), "abc  file\n");
  const all = ["caddy", "web", "cms", "db", "redis", "backup", "restore"];
  const fake = createFakeDocker([
    { match: "--profile [*] config --services$", stdout: `${all.join("\n")}\n` },
    { match: "config --services$", stdout: `${all.filter((s) => s !== "restore").join("\n")}\n` },
    { match: `verify.sh ${ARCHIVE}$`, stdout: "Verified: it restores completely\n" },
    { match: "run --rm -T restore .* --yes$", stdout: "Restore complete\n" },
    { match: "reapplyErasures", stdout: "Deleted 0 submission(s)\n" },
    ...healthyStack(),
  ]);
  const r = await runCli(["restore", ARCHIVE, "--confirm", ARCHIVE], { cwd: dir, fake });
  assert.equal(r.code, 0, [r.stderr, ...fake.lines()].join("\n"));
  assert.ok(fake.lines().includes("--profile * config --services"));
});

test("the psql command line is valid shell: the field separator is quoted, not a pipe", () => {
  const fake = createFakeDocker([]);
  const saved = process.env.PATH;
  process.env.PATH = fake.pathWith(saved);
  try {
    const d = createDocker({ root: process.cwd(), files: [], project: "p", env: { ...process.env } });
    return d.psql("SELECT 1;").then(() => {
      const call = fake.calls().find((c) => c.args.includes("-c"));
      const script = call.args[call.args.indexOf("-c") + 1];
      const parsed = spawnSync("sh", ["-n", "-c", script]);
      assert.equal(parsed.status, 0, `${script}\n${parsed.stderr}`);
      assert.ok(script.includes("-F '|'"), script);
    });
  } finally {
    process.env.PATH = saved;
  }
});

test("the CMS operations script is an .mts file, so it stays ES-module code inside Next's CommonJS .next folder", async () => {
  const fake = createFakeDocker([
    { match: "exec -T cms sh -c", stdout: `POLYSITE_CLI_RESULT:${JSON.stringify({ sites: [] })}\n` },
    ...healthyStack(),
  ]);
  const r = await runCli(["site", "list"], { cwd: makeInstall(), fake });
  assert.equal(r.code, 0, r.stderr);
  const call = fake.calls().find((c) => c.args.includes("sh") && c.args.some((a) => a.includes("polysite-cli-ops")));
  assert.ok(call, "the ops script was run");
  assert.ok(call.args.some((a) => a.includes("polysite-cli-ops.mts")));
});

test("a failed CMS operation reports the cause, not just 'Error running script'", async () => {
  const fake = createFakeDocker([
    { match: "exec -T cms sh -c", code: 1, stderr: "Error running script: /repo/apps/cms/.next/polysite-cli-ops.mts\nError: Cannot find module '../src/payload.config'\n" },
    ...healthyStack(),
  ]);
  const r = await runCli(["site", "list"], { cwd: makeInstall(), fake });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Cannot find module/);
});

test("plugin disable --restart and restart wait until cms and web are healthy, as `up` does", async () => {
  const dir = makeInstall();
  writePlugin(dir, "share");
  const fake = createFakeDocker(healthyStack());
  const a = await runCli(["plugin", "disable", "share", "--restart"], { cwd: dir, fake });
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stderr + a.stdout, /Waiting for cms to be healthy/);
  const b = await runCli(["restart", "cms"], { cwd: dir, fake });
  assert.equal(b.code, 0, b.stderr);
  assert.match(b.stderr + b.stdout, /Waiting for cms to be healthy/);
  assert.doesNotMatch(b.stderr + b.stdout, /Waiting for web/);
});

test("the generated Caddyfile carries the core's security headers and body-size limits", () => {
  const caddy = readFileSync(new URL("../templates/Caddyfile", import.meta.url), "utf8");
  for (const needle of ["Strict-Transport-Security", "X-Content-Type-Options nosniff", "X-Frame-Options DENY", "frame-ancestors 'none'", "max_size 64KB", "max_size 100MB", "import admin_headers", "-Server"]) {
    assert.ok(caddy.includes(needle), `the template lacks ${needle}`);
  }
  assert.ok(caddy.includes("{$SITE_SCHEME:https}") && caddy.includes("{$CMS_SCHEME:https}"), "production defaults stay https");
});
