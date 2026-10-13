import { EXIT } from "../lib/constants.js";
import { CliError, refused } from "../lib/errors.js";
import { firstLine } from "../lib/docker.js";

const tail = (s, n = 12) => s.trim().split(/\r?\n/).slice(-n).join("\n");

/** The two read-only guards the core ships: no migration deletes data, and every plugin owns only its own tables. */
export async function runChecks(ctx) {
  const docker = ctx.docker();
  const results = [];
  const guard = await docker.inCms(["node", "scripts/checkMigrations.mjs"], { noDeps: true });
  results.push({ name: "core migrations delete nothing", ok: guard.code === 0, output: tail(`${guard.stdout}\n${guard.stderr}`) });
  // Generating migrations to compare needs every plugin loaded, so the switch-off list is cleared for this one command.
  const iso = await docker.inCms(["sh", "-c", "unset POLYSITE_PLUGINS_OFF; sh scripts/pluginMigrations.sh check"], { noDeps: true, timeoutMs: 600000 });
  results.push({ name: "core and plugins own only their own tables", ok: iso.code === 0, output: tail(`${iso.stdout}\n${iso.stderr}`, 40) });
  return results;
}

export default {
  name: "migrate",
  summary: "Apply database migrations, or check them without applying",
  usage: "migrate [--check | --status] [--backup]",
  description: `
Without options: applies pending core and plugin migrations (npx payload migrate) in the CMS. Production only: a dev
checkout syncs its schema on boot, and running migrations on top of that confuses it (pass --force to do it anyway).
--check runs the read-only guards: no migration deletes data, and the core and every plugin own only their own tables.
--status lists which migrations ran. Exits 3 when --check finds a problem.`,
  options: {
    check: { type: "boolean", description: "Validate the migrations; change nothing" },
    status: { type: "boolean", description: "Show which migrations have run" },
    backup: { type: "boolean", description: "Take and verify a backup before applying" },
    force: { type: "boolean", description: "Apply migrations even in a dev checkout" },
  },
  async run(ctx, { values }) {
    const { out } = ctx;
    const docker = ctx.docker();
    const { mode } = ctx.project();

    if (values.check) {
      out.info("Running the migration guards in the CMS image (the plugin comparison can take a minute)...");
      const results = await runChecks(ctx);
      for (const r of results) {
        (r.ok ? out.ok : out.fail)(`${r.name}`);
        if (!r.ok || ctx.values.verbose) for (const l of r.output.split(/\r?\n/)) out.say(`      ${l}`);
      }
      const ok = results.every((r) => r.ok);
      if (ok) for (const l of results[1].output.split(/\r?\n/).filter((x) => /^ok /.test(x))) out.say(`      ${l}`);
      out.result({ ok, checks: results });
      return ok ? EXIT.OK : EXIT.CHECK_FAILED;
    }

    if (values.status) {
      const r = await docker.inCms(["npx", "payload", "migrate:status"], { noDeps: false });
      if (r.code !== 0) throw new CliError(`Could not read the migration status: ${firstLine(r.stderr) || firstLine(r.stdout)}`);
      out.say(r.stdout.trim());
      out.result({ ok: true, output: r.stdout.trim() });
      return EXIT.OK;
    }

    if (mode === "dev" && !values.force) {
      throw refused("This is a dev checkout: it syncs its schema to the code on boot, so migrations are not applied here.", "Pass --force to run them anyway (for example to test a new migration).");
    }
    if (values.backup) {
      const { takeBackup } = await import("./backup.js");
      await takeBackup(ctx, { verify: true });
    } else if (mode === "prod") out.hint("Tip: --backup takes and verifies a backup first. Migrations here only add; `polysite upgrade` does it all for you.");
    out.info("Applying migrations...");
    const r = await docker.inCms(["npx", "payload", "migrate"], { noDeps: false, mutating: true });
    if (r.code !== 0) throw new CliError(`The migration failed: ${tail(`${r.stderr}\n${r.stdout}`, 6)}`, { hint: "Each migration runs in its own transaction; earlier ones stay applied. Nothing is half-applied." });
    if (!ctx.dryRun) ctx.audit("migrate", { result: "ok" });
    out.ok("Migrations are up to date.");
    out.result({ ok: true, output: tail(r.stdout, 30) });
    return EXIT.OK;
  },
};
