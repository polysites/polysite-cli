import { EXIT } from "../lib/constants.js";
import { CliError, refused, usageError } from "../lib/errors.js";
import { firstLine } from "../lib/docker.js";
import { latestVersion } from "../lib/registry.js";
import { compareVersions, normalizeVersion } from "../lib/semver.js";
import { takeBackup } from "./backup.js";

const ROLLOUT = ["cms", "web", "backup"];

function imageOverrides(vars) {
  return ["POLYSITE_CMS_IMAGE", "POLYSITE_WEB_IMAGE", "POLYSITE_BACKUP_IMAGE"].filter((k) => vars[k]);
}

export default {
  name: "upgrade",
  summary: "Move to another release: back up, migrate, restart, check health, roll back if it fails",
  usage: "upgrade [--to vX.Y.Z] [--pre] [--dry-run]",
  description: `
Production installs only (a stack that runs published images, POLYSITE_VERSION in .env). In order:
  1. checks the stack is healthy and works out the target release (--to, or the newest stable tag in the registry)
  2. pulls the new images and checks each says it is that version
  3. runs the migration guard from the new image (refuses a migration that deletes data)
  4. takes a backup and test-restores it (refuses to go on if that fails)
  5. applies the migrations from the new image while the old services keep serving
  6. switches cms, web and backup one at a time, waiting for each to be healthy and to report the new version
If step 6 fails, the previous release is put back automatically (exit code 5; 6 if even that fails). Migrations only add,
so the old release runs on the migrated database; the backup from step 4 is the way back for anything else.
--dry-run does steps 1 and the plan only: it pulls nothing and changes nothing.`,
  options: {
    to: { type: "string", placeholder: "vX.Y.Z", description: "The release to move to (default: the newest stable one)" },
    pre: { type: "boolean", description: "Allow a pre-release as the newest one (with no --to)" },
    "skip-backup": { type: "boolean", description: "Do not take a backup first (recorded in the audit log)" },
    force: { type: "boolean", description: "Go on although the stack is not healthy, or the target is the version already running" },
    "allow-downgrade": { type: "boolean", description: "Allow moving to an older release" },
    "health-timeout": { type: "string", placeholder: "seconds", description: "How long each service gets to become healthy (default 300)" },
  },

  async run(ctx, { values }) {
    const { out } = ctx;
    const project = ctx.project();
    const docker = ctx.docker();
    const timeoutSec = Number(values["health-timeout"] ?? 300);
    if (project.mode !== "prod") throw refused("upgrade is for production installs that run published images.", "A source checkout updates with git: `git pull`, then `polysite up --build`.");
    const env = ctx.envFile();
    const vars = env.all();
    const pinned = imageOverrides(vars);
    if (pinned.length) throw refused(`${pinned.join(", ")} pin(s) images by hand in .env, so POLYSITE_VERSION does not decide what runs.`, "Build and set your own images, or remove the pins to use published releases.");
    const current = normalizeVersion(vars.POLYSITE_VERSION ?? "");
    if (!current) throw usageError("POLYSITE_VERSION is missing or not a version in .env.", "Set POLYSITE_VERSION=<x.y.z> to the release you run now.");

    // 1. target
    let target;
    if (values.to) {
      target = normalizeVersion(values.to);
      if (!target) throw usageError(`"${values.to}" is not a version like v0.2.0 or 0.2.0-beta.1.`);
    } else {
      out.info("Looking up the newest release in the registry...");
      const registry = vars.POLYSITE_REGISTRY || "ghcr.io/polysites";
      target = await latestVersion(registry, "polysite-cms", { pre: Boolean(values.pre) });
      if (!target) throw new CliError(`No release tag found for polysite-cms in ${registry}.`, { hint: "Pass --to <version>." });
    }
    const order = compareVersions(target, current);
    if (order === 0 && !values.force) {
      out.ok(`Already on ${current}; nothing to do.`);
      out.result({ ok: true, from: current, to: target, changed: false });
      return EXIT.OK;
    }
    if (order < 0 && !values["allow-downgrade"]) throw refused(`${target} is older than the running ${current}.`, "A newer database may not suit an older release. If you mean it, pass --allow-downgrade (and have a backup).");

    const withTarget = { POLYSITE_VERSION: target };
    const cfg = await docker.compose(["config", "-q"], { env: withTarget });
    if (cfg.code !== 0) throw new CliError(`The compose file is not valid for ${target}: ${firstLine(cfg.stderr)}`);

    // Health of what runs now: do not stack a change on a broken stack.
    const before = {};
    for (const svc of ROLLOUT) before[svc] = await docker.inspect(svc);
    const cmsNow = before.cms;
    if (!values.force && (!cmsNow || cmsNow.status !== "running" || cmsNow.health === "unhealthy")) {
      throw refused(`The CMS is ${cmsNow ? (cmsNow.health === "unhealthy" ? "unhealthy" : cmsNow.status) : "not running"}, so an upgrade would not be a safe change.`, "Fix it first (`polysite doctor`, `polysite logs cms`), or pass --force.");
    }

    const plan = [
      `pull the ${target} images (cms, web, backup) and check their version labels`,
      "run the migration guard from the new cms image (nothing that deletes data)",
      values["skip-backup"] ? "SKIP the backup (--skip-backup)" : "take a backup and test-restore it into a scratch database",
      "apply the migrations from the new image while the old services keep serving",
      `set POLYSITE_VERSION=${target} and switch cms, web, backup one at a time behind health checks`,
      `if anything fails after the switch starts: put ${current} back automatically`,
    ];
    out.say(`Upgrade ${current} -> ${target}${order < 0 ? "  (DOWNGRADE)" : ""}`);
    plan.forEach((p, i) => out.say(`  ${i + 1}. ${p}`));
    if (ctx.dryRun) {
      out.dryRun("nothing was pulled or changed (this was a dry run); the registry was not contacted for the images");
      out.result({ ok: true, dryRun: true, from: current, to: target, plan, healthy: cmsNow?.health ?? cmsNow?.status ?? "not running" });
      return EXIT.OK;
    }
    out.say("");

    ctx.audit("upgrade-start", { from: current, to: target, skipBackup: Boolean(values["skip-backup"]) });
    const fail = (reason, code = EXIT.FAILED, hint) => {
      ctx.audit("upgrade-failed", { from: current, to: target, reason });
      return new CliError(reason, { code, hint });
    };

    // 2. pull
    out.step(1, 5, `Pulling ${target} images...`);
    const pulled = await docker.compose(["pull", ...ROLLOUT], { env: withTarget, stream: true });
    if (pulled.code !== 0) throw fail(`Pulling the ${target} images failed. Nothing was changed.`, EXIT.FAILED, "Check the version exists and the network/registry login (docker login ghcr.io).");
    const cfgJson = await docker.compose(["config", "--format", "json"], { env: withTarget });
    let refs = {};
    try {
      const services = JSON.parse(cfgJson.stdout).services ?? {};
      refs = Object.fromEntries(ROLLOUT.map((s) => [s, services[s]?.image]));
    } catch { /* fall through to the label check being skipped with a warning */ }
    for (const svc of ROLLOUT) {
      if (!refs[svc]) { out.warn(`Could not work out ${svc}'s image to check its version label.`); continue; }
      const r = await docker.raw(["image", "inspect", refs[svc], "--format", '{{index .Config.Labels "org.opencontainers.image.version"}}']);
      const label = r.stdout.trim();
      if (r.code !== 0 || label !== target) throw fail(`${refs[svc]} says it is version "${label || "none"}", not ${target}. Refusing: the tag and the image disagree. Nothing was changed.`, EXIT.REFUSED);
    }
    out.ok("All images pulled and labelled as " + target);

    // 3. guard
    out.step(2, 5, "Checking the new migrations delete nothing...");
    const guard = await docker.compose(["run", "--rm", "--no-deps", "-T", "cms", "node", "scripts/checkMigrations.mjs"], { env: withTarget });
    if (guard.code !== 0) throw fail(`The ${target} migrations would delete data: ${firstLine(guard.stderr) || firstLine(guard.stdout)}. Nothing was changed.`, EXIT.REFUSED, "Read the release notes; this needs a deliberate, backed-up step.");
    out.ok("The migrations only add.");

    // 4. backup
    let backupName = null;
    if (values["skip-backup"]) out.warn("Skipping the backup as asked.");
    else {
      out.step(3, 5, "Taking and verifying a backup...");
      try {
        ({ name: backupName } = await takeBackup(ctx, { verify: true }));
      } catch (e) {
        throw fail(`No good backup, so no upgrade: ${e.message}`, EXIT.REFUSED, "Nothing was changed. Fix the backup (polysite doctor) or pass --skip-backup.");
      }
    }

    // 5. migrate with the new image while the old one serves
    out.step(4, 5, "Applying migrations from the new image...");
    const mig = await docker.compose(["run", "--rm", "--no-deps", "-T", "cms", "npx", "payload", "migrate"], { env: withTarget });
    if (mig.code !== 0) throw fail(`The migrations failed: ${firstLine(mig.stderr) || firstLine(mig.stdout)}. The old release is still serving and unchanged.`, EXIT.FAILED, backupName ? `Backup kept: ${backupName}` : undefined);
    out.ok("Migrations applied.");

    // 6. switch
    out.step(5, 5, `Switching to ${target}...`);
    env.set("POLYSITE_VERSION", target);
    env.write();
    const rollback = async (reason) => {
      out.fail(`${reason}`);
      out.warn(`Putting ${current} back...`);
      env.set("POLYSITE_VERSION", current);
      env.write();
      const up = await docker.compose(["up", "-d", "--no-deps", ...ROLLOUT], { stream: true });
      let ok = up.code === 0;
      for (const svc of ["cms", "web"]) if (ok) ok = (await docker.waitReady(svc, { timeoutSec, pollMs: ctx.pollMs })).ok;
      ctx.audit(ok ? "upgrade-rolled-back" : "upgrade-rollback-failed", { from: current, to: target, reason, backup: backupName ?? "none" });
      if (ok) {
        out.ok(`${current} is running again.`);
        throw new CliError(`The upgrade to ${target} failed and was rolled back to ${current}: ${reason}`, { code: EXIT.ROLLED_BACK, hint: "Migrations stay applied (they only add). See `polysite logs cms`." });
      }
      throw new CliError(`The upgrade to ${target} failed AND putting ${current} back failed: ${reason}`, {
        code: EXIT.ROLLBACK_FAILED,
        hint: `Check \`polysite status\` and \`polysite logs\`. POLYSITE_VERSION in .env is ${current}.${backupName ? ` Restore with \`polysite restore ${backupName}\` if the data is damaged.` : ""}`,
      });
    };
    for (const svc of ROLLOUT) {
      const up = await docker.compose(["up", "-d", "--no-deps", svc], { stream: true });
      if (up.code !== 0) await rollback(`could not start the new ${svc}`);
      const w = await docker.waitReady(svc, { timeoutSec, pollMs: ctx.pollMs });
      if (!w.ok) await rollback(`the new ${svc} did not become healthy (${w.state})`);
      if (svc !== "backup") {
        const h = await docker.appHealth(svc);
        if (!h || h.status !== "ok") await rollback(`the new ${svc} does not answer /api/health`);
        if (h.version !== target) await rollback(`the new ${svc} reports version "${h.version}", expected ${target}`);
      }
      out.ok(`${svc} is on ${target} and healthy`);
    }
    await docker.compose(["up", "-d", "--no-recreate"], { stream: false });
    ctx.audit("upgrade-done", { from: current, to: target, backup: backupName ?? "none" });
    out.say("");
    out.ok(`Upgraded ${current} -> ${target}.`);
    out.say(`To go back to ${current} if you find a problem later: \`polysite upgrade --to ${current} --allow-downgrade\`${backupName ? `, or restore ${backupName}` : ""}.`);
    out.result({ ok: true, from: current, to: target, backup: backupName, changed: true });
    return EXIT.OK;
  },
};
