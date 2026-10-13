import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, statfsSync, mkdirSync, writeFileSync } from "node:fs";
import dns from "node:dns/promises";
import net from "node:net";
import { join } from "node:path";

import { EXIT } from "../lib/constants.js";
import { splitList } from "../lib/envfile.js";
import { checkMigrationText } from "../lib/isolation.js";
import { pluginFacts } from "../lib/pluginFacts.js";
import { backupDir } from "./backup.js";
import { runChecks } from "./migrate.js";
import { weakSecretReason } from "../lib/secrets.js";

const GB = 1024 ** 3;

const isLocalName = (h) => /^(localhost|.*\.localhost|.*\.test|.*\.local|.*\.internal)(:\d+)?$/i.test(h) || /^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(h);
const hostOnly = (h) => h.replace(/:\d+$/, "");
const privateIp = (ip) => /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:)/i.test(ip);

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", (e) => resolve(e.code === "EADDRINUSE" ? "busy" : e.code === "EACCES" ? "unknown" : "unknown"));
    s.once("listening", () => s.close(() => resolve("free")));
    s.listen(port, "0.0.0.0");
  });
}

const STATE = (root) => join(root, ".polysite", "state.json");
function readState(root) {
  try {
    return JSON.parse(readFileSync(STATE(root), "utf8"));
  } catch {
    return {};
  }
}

export default {
  name: "doctor",
  summary: "Check Docker, ports, DNS, secrets, disk, backups, plugins and health; say how to fix what is wrong",
  usage: "doctor [--online] [--deep] [--offline] [--strict] [--skip <id>]",
  description: `
Read-only. Prints each check as ok, warn or FAIL, with the fix under anything that is not ok. Exits 3 when any check
fails (with --strict, also on warnings), so it can gate a deploy script.
  --online   also request the public site and admin URLs from here
  --deep     also run the migration guards inside the CMS image (slow)
  --offline  skip the DNS lookup
  --skip     skip a check by its id (repeatable): docker, compose, ports, dns, disk, env, secrets, backups, plugins, health, ...`,
  options: {
    online: { type: "boolean", description: "Also request the public URLs from here" },
    deep: { type: "boolean", description: "Also run the migration and plugin guards in the CMS image" },
    offline: { type: "boolean", description: "Skip the DNS lookup" },
    strict: { type: "boolean", description: "Exit non-zero on warnings too" },
    skip: { type: "string", multiple: true, placeholder: "id", description: "Skip a check by id (repeatable)" },
    "accept-secret-change": { type: "boolean", description: "Accept a changed PAYLOAD_SECRET as the new baseline" },
  },

  async run(ctx, { values }) {
    const { out } = ctx;
    const skip = new Set([].concat(values.skip ?? []).flatMap((s) => s.split(",")));
    const checks = [];
    const add = (id, level, title, detail = "", fix = "") => {
      if (!skip.has(id)) checks.push({ id, level, title, detail, fix });
    };

    // ---- Docker -------------------------------------------------------------------------------------------------
    let project = null;
    try {
      project = ctx.project();
    } catch (e) {
      add("install", "fail", "No Polysite install found here", e.message, "Run from the install folder, pass --dir, or create one with `polysite init <dir>`.");
    }
    const docker = project ? ctx.docker() : ctx.bareDocker();
    const dockerVersion = await docker.version();
    if (!dockerVersion) {
      add("docker", "fail", "Docker is not available", "The docker command did not answer.", "Install Docker Engine (https://docs.docker.com/engine/install/), start it, and make sure your user can run `docker ps`.");
    } else add("docker", "ok", `Docker ${dockerVersion} is running`);
    const composeVersion = dockerVersion ? await docker.composeVersion() : null;
    if (dockerVersion && !composeVersion) add("compose", "fail", "Docker Compose v2 is missing", "`docker compose version` failed.", "Install the Compose plugin (docker-compose-plugin).");
    else if (composeVersion) {
      const [maj, min] = composeVersion.split(".").map(Number);
      if (maj < 2 || (maj === 2 && min < 17)) add("compose", "warn", `Docker Compose ${composeVersion} is old`, "Polysite is tested with 2.20 or newer.", "Update the Compose plugin.");
      else add("compose", "ok", `Docker Compose ${composeVersion}`);
    }

    if (project) {
      const { root, mode } = project;
      add("install", "ok", `Install at ${root} (${mode})`);
      const env = ctx.envFile();
      const vars = env.all();
      const strictLevel = mode === "prod" ? "fail" : "warn";

      // ---- Compose file ------------------------------------------------------------------------------------------
      if (dockerVersion) {
        const cfg = await docker.compose(["config", "-q"]);
        if (cfg.code !== 0) add("compose-file", "fail", "docker compose cannot read the compose files", cfg.stderr.trim().split(/\r?\n/)[0], "Fix the file or the variable it names in .env.");
        else add("compose-file", "ok", "Compose files are valid");
      }

      // ---- .env completeness and secrets ------------------------------------------------------------------------
      if (!existsSync(project.envPath)) {
        add("env", "fail", `${project.envPath} does not exist`, "", "Create it with `polysite init`, or copy .env.example to .env and fill it in.");
      } else {
        const required = ["SITE_DOMAIN", "CMS_DOMAIN", "SITE_SCHEME", "CMS_SCHEME", "DATABASE_URL", "PAYLOAD_SECRET", "NUXT_REVALIDATE_SECRET", "REVALIDATE_SECRET", "NUXT_REVALIDATE_URL", "NUXT_API_BASE_INTERNAL", "REDIS_URL"];
        if (mode === "prod" && !vars.POLYSITE_CMS_IMAGE) required.push("POLYSITE_VERSION");
        const missing = required.filter((k) => !vars[k]);
        if (missing.length) add("env", strictLevel, `${missing.length} required setting(s) missing or empty in .env`, missing.join(", "), "Add them (see .env.example), or re-run `polysite init` in a new folder to compare.");
        else add("env", "ok", ".env has every required setting");

        if (process.platform !== "win32") {
          const perm = statSync(project.envPath).mode & 0o777;
          if (perm & 0o077) add("env-perms", "warn", `.env is readable by other users (mode ${perm.toString(8)})`, "It holds the database password and signing keys.", `chmod 600 ${project.envPath}`);
          else add("env-perms", "ok", ".env is private to its owner");
        }

        const weak = [];
        for (const k of ["PAYLOAD_SECRET", "NUXT_REVALIDATE_SECRET", "REVALIDATE_SECRET"]) {
          if (vars[k] !== undefined) {
            const why = weakSecretReason(vars[k], { minLength: 32 });
            if (why) weak.push(`${k} ${why}`);
          }
        }
        if (vars.POSTGRES_PASSWORD !== undefined) {
          const why = weakSecretReason(vars.POSTGRES_PASSWORD, { minLength: 16 });
          if (why) weak.push(`POSTGRES_PASSWORD ${why}`);
        }
        if (vars.DATABASE_URL) {
          try {
            const pw = decodeURIComponent(new URL(vars.DATABASE_URL).password);
            const why = weakSecretReason(pw, { minLength: 16 });
            if (why) weak.push(`the password in DATABASE_URL ${why}`);
          } catch {
            add("env", "fail", "DATABASE_URL is not a valid URL", "", "Use postgres://user:password@host:5432/dbname (URL-encode special characters in the password).");
          }
        }
        if (vars.BACKUP_ENCRYPTION_PASSPHRASE) {
          const why = weakSecretReason(vars.BACKUP_ENCRYPTION_PASSPHRASE, { minLength: 16 });
          if (why) weak.push(`BACKUP_ENCRYPTION_PASSPHRASE ${why}`);
        }
        if (weak.length) add("secrets", strictLevel, "Weak or placeholder secrets", weak.join("; "), "Generate new ones, for example `openssl rand -base64 32`, and put them in .env. For PAYLOAD_SECRET on a running install read the warning in docs/guide/backups.md first: it encrypts stored credentials.");
        else add("secrets", "ok", "Secrets are long and not placeholders");
        if (vars.NUXT_REVALIDATE_SECRET && vars.REVALIDATE_SECRET && vars.NUXT_REVALIDATE_SECRET !== vars.REVALIDATE_SECRET) {
          add("secrets-match", "fail", "NUXT_REVALIDATE_SECRET and REVALIDATE_SECRET differ", "Publishing would not refresh the public site.", "Give both the same value.");
        }
        if (mode === "prod" && !vars.POLYSITE_SETUP_TOKEN) add("setup-token", "warn", "POLYSITE_SETUP_TOKEN is not set", "Until the first administrator exists, anyone who reaches the setup page can create it.", "Set it to a long random value; the setup page asks for it.");

        if (mode === "prod") {
          if (vars.SITE_SCHEME !== "https" || vars.CMS_SCHEME !== "https") add("https", "warn", "The site is not set to HTTPS", `SITE_SCHEME=${vars.SITE_SCHEME ?? ""} CMS_SCHEME=${vars.CMS_SCHEME ?? ""}`, "Set both to https in .env so Caddy gets certificates and cookies are sent securely.");
          else add("https", "ok", "HTTPS is on for the site and the admin");
        }

        // PAYLOAD_SECRET must not change under an existing install: stored credentials are encrypted with it.
        if (vars.PAYLOAD_SECRET) {
          const fp = createHash("sha256").update(vars.PAYLOAD_SECRET).digest("hex").slice(0, 16);
          const state = readState(root);
          if (!state.payloadSecretFingerprint || values["accept-secret-change"]) {
            if (!ctx.dryRun) {
              mkdirSync(join(root, ".polysite"), { recursive: true });
              writeFileSync(STATE(root), `${JSON.stringify({ ...state, payloadSecretFingerprint: fp }, null, 2)}\n`);
            }
            add("secret-stable", "ok", "PAYLOAD_SECRET recorded (a fingerprint, not the value) to notice if it ever changes");
          } else if (state.payloadSecretFingerprint !== fp) {
            add("secret-stable", "fail", "PAYLOAD_SECRET changed since the last check", "Credentials stored with it (SMTP, single sign-on, webhooks) can no longer be read.", "Put the old value back. If you really meant to change it, re-enter those credentials and run `polysite doctor --accept-secret-change`.");
          } else add("secret-stable", "ok", "PAYLOAD_SECRET is unchanged since the last check");
        }

        // ---- Ports -----------------------------------------------------------------------------------------------
        const caddy = dockerVersion ? await docker.inspect("caddy").catch(() => null) : null;
        if (mode === "prod") {
          if (caddy?.status === "running") add("ports", "ok", "Ports 80 and 443 are served by Caddy");
          else {
            const busy = [];
            const unknown = [];
            for (const p of [80, 443]) {
              const r = await portFree(p);
              if (r === "busy") busy.push(p);
              if (r === "unknown") unknown.push(p);
            }
            if (busy.length) add("ports", "fail", `Port ${busy.join(" and ")} already in use`, "Something else is listening, so Caddy cannot start or get certificates.", "Find it with `ss -ltnp | grep -E ':(80|443) '`, stop it (an old nginx/apache?), then retry.");
            else if (unknown.length) add("ports", "info", `Could not test port ${unknown.join(" and ")} from here`, "Binding ports below 1024 needs root; that is only a limit of this check.", "Run `sudo polysite doctor` to test them, or just run `polysite up`.");
            else add("ports", "ok", "Ports 80 and 443 are free");
          }
        }

        // ---- DNS --------------------------------------------------------------------------------------------------
        if (!values.offline) {
          for (const [label, host] of [["site", vars.SITE_DOMAIN], ["admin", vars.CMS_DOMAIN]]) {
            if (!host) continue;
            const name = hostOnly(host);
            if (isLocalName(host) || name.startsWith("*.")) {
              add("dns", "info", `DNS for the ${label} domain ${host} is not checked`, "A local or wildcard name.");
              continue;
            }
            try {
              const addrs = (await dns.lookup(name, { all: true })).map((a) => a.address);
              if (mode === "prod" && addrs.every(privateIp)) add("dns", "warn", `${host} resolves only to private addresses (${addrs.join(", ")})`, "Let's Encrypt cannot reach a private address.", "Point the DNS A/AAAA record at this server's public address.");
              else add("dns", "ok", `${host} resolves to ${addrs.join(", ")}`);
            } catch {
              add("dns", mode === "prod" ? "fail" : "warn", `${host} does not resolve`, "Caddy cannot get a certificate for a name that does not point at this server.", `Create a DNS A (and AAAA) record for ${host} pointing at this server's public IP, then wait for it to propagate.`);
            }
          }
        }

        // ---- Disk -------------------------------------------------------------------------------------------------
        try {
          const st = statfsSync(root);
          const free = st.bavail * st.bsize;
          const text = `${(free / GB).toFixed(1)} GB free in ${root}`;
          if (free < 1 * GB) add("disk", "fail", `Low disk: ${text}`, "Images, the database and backups need room.", "Free space: `docker system prune`, old backups, logs.");
          else if (free < 5 * GB) add("disk", "warn", `Disk is getting full: ${text}`, "", "Free space before upgrading: images and a backup need a few GB.");
          else add("disk", "ok", text);
        } catch {
          add("disk", "info", "Free disk space could not be read on this platform");
        }

        // ---- Backups ----------------------------------------------------------------------------------------------
        const services = dockerVersion ? await docker.services().catch(() => []) : [];
        if (services.length && !services.includes("backup")) add("backups", "fail", "No backup service in the compose files", "", "Use the compose file `polysite init` writes, or add the backup service from docker-compose.yml.");
        else {
          const dir = backupDir(ctx);
          const bits = [];
          let level = "ok";
          if (!vars.BACKUP_ENCRYPTION_PASSPHRASE) { bits.push("backups are not encrypted"); level = "warn"; }
          if (!vars.BACKUP_RCLONE_REMOTE) { bits.push("no off-site copy (BACKUP_RCLONE_REMOTE): backups die with this machine"); level = "warn"; }
          let age = null;
          try {
            age = (Date.now() - Date.parse(readFileSync(join(dir, "LAST_SUCCESS"), "utf8").trim())) / 3600000;
          } catch { /* none */ }
          const archives = existsSync(dir) ? readdirSync(dir).filter((n) => /^polysite-.*\.tar(\.enc)?$/.test(n)).length : 0;
          if (age === null) { bits.push(archives ? "no LAST_SUCCESS marker" : "no backup has been taken yet"); level = level === "ok" ? "warn" : level; }
          else if (age > 36) { bits.push(`the last successful backup is ${Math.round(age)} hours old`); level = "fail"; }
          add("backups", level, level === "ok" ? `Backups configured; last success ${Math.round(age)} h ago` : "Backups need attention", bits.join("; "), "Take one now with `polysite backup`; set BACKUP_RCLONE_REMOTE and BACKUP_ENCRYPTION_PASSPHRASE in .env (docs/guide/backups.md).");
        }

        // ---- Plugin isolation (static) ---------------------------------------------------------------------------
        const pdir = join(root, "plugins");
        if (existsSync(pdir)) {
          const off = new Set(splitList(vars.POLYSITE_PLUGINS_OFF));
          const problems = [];
          let count = 0;
          for (const e of readdirSync(pdir, { withFileTypes: true })) {
            if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
            const f = pluginFacts(join(pdir, e.name), e.name);
            if (!f) continue;
            count += 1;
            for (const p of f.problems) problems.push(`${e.name}: ${p}`);
            const mdir = join(pdir, e.name, f.manifest?.migrations || "migrations");
            if (existsSync(mdir)) for (const file of readdirSync(mdir).filter((n) => /\.m?js$/.test(n))) problems.push(...checkMigrationText(readFileSync(join(mdir, file), "utf8"), `${e.name}/${file}`));
          }
          const unknownOff = [...off].filter((s) => !existsSync(join(pdir, s)));
          if (problems.length) add("plugins", "fail", "Plugin problems", problems.join("; "), "A plugin must have a valid manifest, a package with \"type\":\"module\", src/index.js, and migrations that touch only its own tables (plugins/README.md).");
          else add("plugins", "ok", `${count} plugin(s) pass the isolation check${off.size ? `; ${[...off].join(", ")} switched off` : ""}`);
          if (unknownOff.length) add("plugins-off", "warn", `POLYSITE_PLUGINS_OFF names plugins that are not installed: ${unknownOff.join(", ")}`, "", "Remove them from the list, or reinstall the plugin.");
        } else {
          add("plugins", "info", "No plugins/ folder: the plugins inside the images are used", "Run `polysite plugin list` to see them.");
        }
        if (values.deep && dockerVersion) {
          const results = await runChecks(ctx);
          for (const r of results) add("deep", r.ok ? "ok" : "fail", `${r.name} (in the CMS image)`, r.ok ? "" : r.output.split(/\r?\n/).slice(0, 4).join(" | "), "Run `polysite migrate --check` for the full report.");
        }

        // ---- Health -----------------------------------------------------------------------------------------------
        if (dockerVersion && services.length) {
          const states = [];
          for (const svc of services.filter((s) => s !== "restore")) states.push(await docker.inspect(svc).catch(() => null) ?? { service: svc, status: "missing" });
          const running = states.filter((s) => s.status === "running");
          if (!running.length) {
            add("health", "info", "The stack is not running", "That is expected before the first `polysite up`.", "");
          } else {
            const bad = states.filter((s) => s.status !== "running" || s.health === "unhealthy" || s.health === "starting");
            if (bad.length) add("health", "fail", "Some services are not healthy", bad.map((s) => `${s.service}: ${s.status === "running" ? s.health : s.status}`).join(", "), "`polysite logs <service> --tail 80`, then `polysite restart <service>`.");
            else add("health", "ok", `All ${states.length} services are running and healthy`);
            for (const svc of ["cms", "web"]) {
              if (!running.some((s) => s.service === svc)) continue;
              const h = await docker.appHealth(svc);
              if (!h) add("health-endpoint", "fail", `${svc}: /api/health did not answer`, "", `polysite logs ${svc} --tail 80`);
              else if (h.status !== "ok") add("health-endpoint", "fail", `${svc}: /api/health says ${h.status}`, "The app is up but cannot reach the database.", "Check DATABASE_URL and the database container.");
              else {
                const want = vars.POLYSITE_VERSION;
                if (want && h.version && h.version !== "dev" && h.version !== want) add("health-endpoint", "warn", `${svc} runs ${h.version} but POLYSITE_VERSION is ${want}`, "", "Run `polysite up` to apply the setting, or `polysite upgrade`.");
                else add("health-endpoint", "ok", `${svc}: /api/health ok${h.version ? ` (${h.version})` : ""}`);
              }
            }
          }
        }

        // ---- Public URLs ------------------------------------------------------------------------------------------
        if (values.online) {
          for (const [label, base, path] of [["site", `${vars.SITE_SCHEME}://${vars.SITE_DOMAIN}`, "/api/health"], ["admin", `${vars.CMS_SCHEME}://${vars.CMS_DOMAIN}`, "/api/health"]]) {
            if (!vars.SITE_DOMAIN || !vars.CMS_DOMAIN) break;
            try {
              const res = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(10000) });
              add("online", res.ok ? "ok" : "fail", `${label} ${base}${path} answered ${res.status}`, "", res.ok ? "" : "Check DNS, the Caddyfile, and `polysite logs caddy`.");
            } catch (e) {
              add("online", "fail", `${label} ${base} is not reachable from here`, String(e.cause?.code ?? e.message), "Check DNS, firewall ports 80/443, and `polysite logs caddy`.");
            }
          }
        }
      }
    }

    // ---- Report ----------------------------------------------------------------------------------------------------
    const shown = checks.filter((c) => !skip.has(c.id));
    const symbol = { ok: out.paint("green", "ok  "), info: out.paint("cyan", "info"), warn: out.paint("yellow", "warn"), fail: out.paint("red", "FAIL") };
    for (const c of shown) {
      out.say(`${symbol[c.level]}  ${c.title}`);
      if (c.level !== "ok" && c.detail) out.say(`      ${c.detail}`);
      if ((c.level === "warn" || c.level === "fail") && c.fix) out.say(`      fix: ${c.fix}`);
    }
    const counts = { ok: 0, info: 0, warn: 0, fail: 0 };
    for (const c of shown) counts[c.level]++;
    out.say("");
    out.say(`${counts.fail} failed, ${counts.warn} warning(s), ${counts.ok + counts.info} fine.`);
    const failed = counts.fail > 0 || (values.strict && counts.warn > 0);
    out.result({ ok: !failed, summary: counts, checks: shown });
    return failed ? EXIT.CHECK_FAILED : EXIT.OK;
  },
};

