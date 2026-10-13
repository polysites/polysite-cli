import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { EXIT } from "../lib/constants.js";
import { confirmTyped } from "../lib/confirm.js";
import { CliError, usageError } from "../lib/errors.js";
import { firstLine } from "../lib/docker.js";

const ARCHIVE = /^polysite-(\d{8}T\d{6}Z)\.tar(\.enc)?$/;

/** The folder backups are written to on this machine (BACKUP_HOST_DIR in the env file, default ./backups). */
export function backupDir(ctx) {
  const { root } = ctx.project();
  const configured = ctx.envFile().get("BACKUP_HOST_DIR") || "./backups";
  return isAbsolute(configured) ? configured : resolve(root, configured);
}

const human = (bytes) => (bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`);

function parseStamp(ts) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(ts);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

export function listBackups(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, m: ARCHIVE.exec(name) }))
    .filter((x) => x.m)
    .map(({ name, m }) => {
      const st = statSync(join(dir, name));
      return { name, createdAt: parseStamp(m[1]), sizeBytes: st.size, encrypted: Boolean(m[2]), checksum: existsSync(join(dir, `${name}.sha256`)) };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

/** Takes a backup with the backup service and returns its file name. Used by `backup` and by the steps that must back up first. */
export async function takeBackup(ctx, { verify = true } = {}) {
  const docker = ctx.docker();
  const { out } = ctx;
  if (ctx.dryRun) {
    out.dryRun("would take a backup with /opt/backup/backup.sh in the backup service" + (verify ? ", then verify it with verify.sh" : ""));
    return { name: null, verified: false };
  }
  out.info("Taking a backup (database dump + media)...");
  const r = await docker.inBackup("backup.sh", []);
  const text = `${r.stdout}\n${r.stderr}`;
  if (r.code !== 0) {
    const reason = text.split(/\r?\n/).filter((l) => /ERROR/.test(l)).pop() ?? firstLine(r.stderr) ?? `exit code ${r.code}`;
    throw new CliError(`The backup failed: ${reason.replace(/^\S+\s+/, "")}`, { hint: "polysite logs backup --tail 50" });
  }
  const name = /wrote (polysite-\S+?\.tar(?:\.enc)?)\b/.exec(text)?.[1];
  if (!name) throw new CliError("The backup ran but did not report a file name.", { hint: "Check `polysite backups`." });
  out.ok(`Wrote ${name}`);
  if (/No off-site copy configured/.test(text)) out.warn("No off-site copy is configured: this backup is only as safe as this machine (BACKUP_RCLONE_REMOTE).");
  let verified = false;
  if (verify) {
    out.info("Verifying it restores into a scratch database...");
    const v = await docker.inBackup("verify.sh", [name]);
    if (v.code !== 0) {
      const reason = `${v.stdout}\n${v.stderr}`.split(/\r?\n/).filter((l) => /ERROR/.test(l)).pop() ?? `exit code ${v.code}`;
      throw new CliError(`The backup ${name} was written but does not verify: ${reason.replace(/^\S+\s+ERROR:\s*/, "")}`, { hint: "Do not rely on it. Check `polysite logs backup`." });
    }
    verified = true;
    out.ok("Verified: it restores completely.");
  }
  return { name, verified };
}

export const backup = {
  name: "backup",
  summary: "Take a backup now (database + media) and verify it",
  usage: "backup [--now] [--no-verify]",
  description: `
Runs the backup service's own backup script (backup/backup.sh), then test-restores the result into a scratch
database (verify.sh) so you know it can be used. The nightly schedule keeps running; this is for before a risky change.`,
  options: {
    now: { type: "boolean", description: "Accepted for clarity; a backup is always taken now" },
    "no-verify": { type: "boolean", description: "Skip the test restore" },
  },
  async run(ctx, { values }) {
    const res = await takeBackup(ctx, { verify: !values["no-verify"] });
    if (!ctx.dryRun) ctx.audit("backup", { archive: res.name, verified: res.verified });
    ctx.out.result({ ok: true, archive: res.name, verified: res.verified });
    return EXIT.OK;
  },
};

export const backups = {
  name: "backups",
  summary: "List the backups on this machine",
  usage: "backups [--json]",
  async run(ctx) {
    const dir = backupDir(ctx);
    const list = listBackups(dir);
    let last = null;
    try {
      last = readFileSync(join(dir, "LAST_SUCCESS"), "utf8").trim();
    } catch { /* none yet */ }
    if (!list.length) {
      ctx.out.say(`No backups in ${dir}.`);
      ctx.out.hint("Take one with `polysite backup`.");
    } else {
      ctx.out.table(
        list.map((b) => ({ ...b, size: human(b.sizeBytes), enc: b.encrypted ? "yes" : "no", sum: b.checksum ? "yes" : "no" })),
        [{ key: "name", header: "BACKUP" }, { key: "createdAt", header: "CREATED (UTC)" }, { key: "size", header: "SIZE" }, { key: "enc", header: "ENCRYPTED" }, { key: "sum", header: "CHECKSUM" }],
      );
      ctx.out.say(`Last successful backup: ${last ?? "unknown"}.   Folder: ${dir}`);
    }
    ctx.out.result({ ok: true, dir, lastSuccess: last, backups: list });
    return EXIT.OK;
  },
};

export const restore = {
  name: "restore",
  summary: "Verify a backup, then restore it over the live data",
  usage: "restore <backup|latest> [--verify-only] [--db-only|--media-only] [--confirm <backup name>]",
  positionals: { min: 1, max: 1, name: "the backup to restore (a name from `polysite backups`, or latest)" },
  description: `
Always verifies the archive first (checksum, a test restore into a scratch database, row counts). With --verify-only it
stops there and changes nothing. Otherwise it stops the CMS and the site, takes a safety copy of the current database
(the backup tool does this itself), restores, starts them again and re-applies privacy erasures that happened after the
backup. Replacing live data needs the backup's name typed back (or --confirm).`,
  options: {
    "verify-only": { type: "boolean", description: "Only check that the backup restores; change nothing" },
    "db-only": { type: "boolean", description: "Restore the database but not the media files" },
    "media-only": { type: "boolean", description: "Restore the media files but not the database" },
    "skip-erasures": { type: "boolean", description: "Do not re-apply privacy erasures made since the backup" },
  },
  async run(ctx, { values, positionals }) {
    const { out } = ctx;
    const docker = ctx.docker();
    if (values["db-only"] && values["media-only"]) throw usageError("Choose --db-only or --media-only, not both.");
    const dir = backupDir(ctx);
    let target = positionals[0];
    if (target !== "latest") {
      if (isAbsolute(target) || target.includes("/") || target.includes("\\")) {
        if (resolve(dirname(target)) !== resolve(dir)) throw usageError(`${target} is not in the backups folder (${dir}).`, "Copy the archive into that folder and name it here.");
        target = basename(target);
      }
      if (!ARCHIVE.test(target)) throw usageError(`"${target}" is not a backup file name (polysite-<time>.tar or .tar.enc).`);
      if (existsSync(dir) && !existsSync(join(dir, target))) throw usageError(`No such backup: ${target}`, "List them with `polysite backups`.");
    } else {
      const newest = listBackups(dir)[0];
      if (existsSync(dir) && !newest) throw usageError(`There are no backups in ${dir}.`);
      if (newest) target = newest.name;
    }

    out.info(`Verifying ${target} (checksum, test restore into a scratch database)...`);
    const v = await docker.inBackup("verify.sh", [target]);
    const vtext = `${v.stdout}\n${v.stderr}`;
    if (v.code !== 0) {
      const reason = vtext.split(/\r?\n/).filter((l) => /ERROR/.test(l)).pop() ?? `exit code ${v.code}`;
      throw new CliError(`${target} does not verify, so it will not be restored: ${reason.replace(/^\S+\s+ERROR:\s*/, "")}`, { code: EXIT.CHECK_FAILED });
    }
    out.ok(`${target} restores completely.`);
    for (const l of vtext.split(/\r?\n/).filter((x) => /rows OK/.test(x))) out.say(`      ${l.replace(/^\S+\s+/, "").trim()}`);
    if (values["verify-only"]) {
      ctx.audit("restore-verify", { archive: target, result: "ok" });
      out.result({ ok: true, archive: target, verified: true, restored: false });
      return EXIT.OK;
    }

    const what = values["db-only"] ? "the database" : values["media-only"] ? "the uploaded media" : "the database and the uploaded media";
    if (ctx.dryRun) {
      out.dryRun(`would stop web and cms, restore ${what} from ${target}, start them, wait for health${values["skip-erasures"] ? "" : ", re-apply privacy erasures"}`);
      out.result({ ok: true, dryRun: true, archive: target, verified: true });
      return EXIT.OK;
    }
    await confirmTyped(ctx, `This replaces ${what} of the live install with the contents of ${target}. Anything saved since that backup is lost\n(a copy of the current database is kept in the backups folder as pre-restore-*.dump).`, target);

    ctx.audit("restore-start", { archive: target, scope: what });
    const services = await docker.services();
    if (!services.includes("restore")) throw new CliError("This install's compose files have no `restore` service.", { hint: "Use the compose file written by `polysite init`." });
    out.info("Stopping web and cms...");
    await docker.mutate(["stop", "web", "cms"]);
    out.info("Restoring...");
    const r = await docker.compose(["--profile", "restore", "run", "--rm", "-T", "restore", target, "--yes", ...(values["db-only"] ? ["--db-only"] : []), ...(values["media-only"] ? ["--media-only"] : [])]);
    const rtext = `${r.stdout}\n${r.stderr}`;
    if (r.code !== 0) {
      ctx.audit("restore-failed", { archive: target });
      out.warn("The restore failed. Starting the previous version of the app again; the database restore runs in one transaction, so nothing was changed by it.");
      await docker.mutate(["start", "cms", "web"]);
      throw new CliError(`The restore failed: ${(rtext.split(/\r?\n/).filter((l) => /ERROR/.test(l)).pop() ?? firstLine(r.stderr)).replace(/^\S+\s+ERROR:\s*/, "")}`);
    }
    out.ok("Restored.");
    out.info("Starting cms and web...");
    await docker.mutate(["start", "cms", "web"]);
    for (const s of ["cms", "web"]) {
      const w = await docker.waitReady(s, { timeoutSec: 300, pollMs: ctx.pollMs });
      if (!w.ok) throw new CliError(`${s} did not come back healthy after the restore (${w.state}).`, { hint: `polysite logs ${s}` });
    }
    let erasures = "skipped";
    if (!values["skip-erasures"] && !values["media-only"]) {
      const e = await docker.inCms(["npx", "payload", "run", "scripts/reapplyErasures.ts"], { mutating: true });
      erasures = e.code === 0 ? "reapplied" : "failed";
      if (e.code === 0) out.ok(`Privacy erasures re-applied. ${firstLine(e.stdout.split(/\r?\n/).filter((l) => /Deleted/.test(l)).join("\n"))}`.trim());
      else out.warn("Could not re-apply privacy erasures. Run: docker compose exec cms npx payload run scripts/reapplyErasures.ts");
    }
    ctx.audit("restore-done", { archive: target, erasures });
    out.ok("The install is running on the restored data. Check a few pages and images.");
    out.result({ ok: true, archive: target, verified: true, restored: true, erasures });
    return EXIT.OK;
  },
};

