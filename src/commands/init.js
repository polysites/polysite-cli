import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { DEFAULT_CORE_VERSION, DEFAULT_REGISTRY, EXIT } from "../lib/constants.js";
import { createAudit } from "../lib/audit.js";
import { CliError, refused, usageError } from "../lib/errors.js";
import { generatePassword, randomSecret } from "../lib/secrets.js";
import { normalizeVersion } from "../lib/semver.js";
import { applyDbMarkers, fill, readTemplate } from "../lib/templates.js";
import { writeConfig } from "../lib/project.js";

const HOST = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?(:\d{1,5})?$/i;

export const validateHost = (v) => (HOST.test(v) ? null : `"${v}" is not a host name like example.org`);

const isLocalName = (host) => /^(localhost|.*\.localhost|.*\.test|.*\.local)(:\d+)?$/i.test(host) || /^\d+\.\d+\.\d+\.\d+/.test(host);

/** The files `init` would write, as { path, content, mode }, with secrets already generated. Pure: nothing is written here. */
export function planInstall({ dir, domain, cmsDomain, scheme, coreVersion, registry, database, databaseUrl, postgresMajor, encryptBackups, project }) {
  const localDb = database === "local";
  const pgPassword = randomSecret(24);
  const vars = {
    DATE: new Date().toISOString().slice(0, 10),
    COMPOSE_PROJECT: project,
    POLYSITE_VERSION: coreVersion,
    POLYSITE_REGISTRY: registry,
    SITE_DOMAIN: domain,
    CMS_DOMAIN: cmsDomain,
    SCHEME: scheme,
    POSTGRES_USER: "polysite",
    POSTGRES_PASSWORD: localDb ? pgPassword : "",
    POSTGRES_DB: "polysite",
    POSTGRES_MAJOR: postgresMajor,
    DATABASE_URL: localDb ? `postgres://polysite:${pgPassword}@db:5432/polysite` : databaseUrl,
    PAYLOAD_SECRET: randomSecret(32),
    REVALIDATE_SECRET: randomSecret(32),
    SETUP_TOKEN: randomSecret(24),
    BACKUP_PASSPHRASE: encryptBackups ? randomSecret(32) : "",
  };
  let env = fill(readTemplate("env.tmpl"), vars);
  if (!localDb) env = env.replace(/^POSTGRES_(USER|PASSWORD|DB|MAJOR)=.*\n/gm, "");
  if (!encryptBackups) env = env.replace(/^BACKUP_ENCRYPTION_PASSPHRASE=\n/m, "# BACKUP_ENCRYPTION_PASSPHRASE=\n");
  const compose = fill(applyDbMarkers(readTemplate("docker-compose.prod.yml"), localDb), vars);
  return [
    { path: join(dir, "docker-compose.prod.yml"), content: compose, mode: 0o644 },
    { path: join(dir, "Caddyfile"), content: readTemplate("Caddyfile"), mode: 0o644 },
    { path: join(dir, ".env"), content: env, mode: 0o600, secret: true },
    { path: join(dir, ".gitignore"), content: ".env\n.env.*\nbackups/\n.polysite/\n", mode: 0o644 },
  ];
}

export default {
  name: "init",
  summary: "Create a production-ready install in a new folder",
  usage: "init <dir> [--domain example.org] [options]",
  positionals: { min: 1, max: 1, name: "the install folder" },
  description: `
Writes docker-compose.prod.yml, a Caddyfile and a .env with freshly generated secrets into <dir>, and records it as a
production install. Nothing is started and no secret is printed: they are only in .env (readable by you alone).
It never overwrites an existing .env. Run \`polysite doctor\` next, then \`polysite up\`.`,
  options: {
    domain: { type: "string", placeholder: "host", description: "The public site's domain (asked for when omitted)" },
    "cms-domain": { type: "string", placeholder: "host", description: "The admin's domain (default: admin.<domain>)" },
    scheme: { type: "string", placeholder: "https|http", description: "https (default) gets certificates automatically; http is for local trials" },
    "core-version": { type: "string", placeholder: "X.Y.Z", description: `The Polysite release to install (default ${DEFAULT_CORE_VERSION})` },
    registry: { type: "string", placeholder: "ref", description: `Where the images live (default ${DEFAULT_REGISTRY})` },
    database: { type: "string", placeholder: "local|external", description: "local (default): a PostgreSQL container; external: your own server" },
    "database-url": { type: "string", placeholder: "url", description: "The connection string, with --database external" },
    "postgres-major": { type: "string", placeholder: "n", description: "PostgreSQL major version of the bundled database (default 16)" },
    "no-backup-encryption": { type: "boolean", description: "Do not generate a passphrase that encrypts backups" },
    force: { type: "boolean", description: "Write into a folder that already has a compose file (an existing .env is still never touched)" },
  },
  examples: ["polysite init /opt/polysite --domain example.org", "polysite init ./site --domain localhost:8080 --cms-domain admin.localhost:8080 --scheme http"],

  async run(ctx, { values, positionals }) {
    const { out } = ctx;
    const dir = resolve(ctx.cwd, positionals[0]);
    const prompter = () => ctx.prompter();

    const domain = (values.domain ?? (await askDomain(prompter(), "The public site's domain (for example example.org)"))).toLowerCase();
    const badDomain = validateHost(domain);
    if (badDomain) throw usageError(badDomain);
    const defaultCms = domain.includes(".") && !isLocalName(domain) ? `admin.${domain}` : `admin.${domain.replace(/^www\./, "")}`;
    const cmsDomain = (values["cms-domain"] ?? (prompter().interactive && values.domain === undefined ? await prompter().ask("The admin's domain", { default: defaultCms, validate: validateHost }) : defaultCms)).toLowerCase();
    const badCms = validateHost(cmsDomain);
    if (badCms) throw usageError(badCms);
    if (cmsDomain === domain) throw usageError("The admin domain must differ from the site domain.", "Pass --cms-domain admin.example.org");

    const scheme = values.scheme ?? "https";
    if (!["https", "http"].includes(scheme)) throw usageError("--scheme must be https or http.");
    const coreVersion = normalizeVersion(values["core-version"] ?? DEFAULT_CORE_VERSION);
    if (!coreVersion) throw usageError(`"${values["core-version"]}" is not a version like 0.1.0.`);
    const database = values.database ?? "local";
    if (!["local", "external"].includes(database)) throw usageError("--database must be local or external.");
    if (database === "external" && !values["database-url"]) throw usageError("--database external needs --database-url <postgres://...>.");
    if (database === "external" && !/^postgres(ql)?:\/\//.test(values["database-url"])) throw usageError("--database-url must start with postgres:// or postgresql://");
    const postgresMajor = values["postgres-major"] ?? "16";
    if (!/^\d{2}$/.test(postgresMajor)) throw usageError("--postgres-major must be a number such as 16.");

    if (existsSync(join(dir, ".env"))) {
      throw refused(`${join(dir, ".env")} already exists. init never replaces an existing .env (new secrets would break stored data).`, "Edit it, or choose another folder.");
    }
    if (existsSync(dir) && readdirSync(dir).length && !values.force && existsSync(join(dir, "docker-compose.prod.yml"))) {
      throw refused(`${dir} already has a docker-compose.prod.yml.`, "Pass --force to write the files again (the .env is still left alone).");
    }

    const base = basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "install";
    const project = base.startsWith("polysite") ? base : `polysite-${base}`;
    const files = planInstall({
      dir, domain, cmsDomain, scheme, coreVersion, registry: values.registry ?? DEFAULT_REGISTRY, database,
      databaseUrl: values["database-url"], postgresMajor, encryptBackups: !values["no-backup-encryption"], project,
    });

    if (ctx.dryRun) {
      out.dryRun(`would create ${dir}`);
      for (const f of files) out.dryRun(`would write ${f.path}${f.secret ? " (with generated secrets, mode 600)" : ""}`);
      out.dryRun(`would write ${join(dir, ".polysite", "config.json")} and create ${join(dir, "backups")}`);
      out.result({ ok: true, dryRun: true, dir, files: files.map((f) => f.path) });
      return EXIT.OK;
    }

    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "backups"), { recursive: true });
    for (const f of files) writeFileSync(f.path, f.content, { mode: f.mode });
    writeConfig(dir, { mode: "prod", composeFiles: ["docker-compose.prod.yml"], project, createdBy: "polysite init", createdAt: new Date().toISOString() });
    createAudit(dir).write("init", { domain, cmsDomain, version: coreVersion, database });

    out.ok(`Wrote ${files.map((f) => basename(f.path)).join(", ")} to ${dir}`);
    out.say("");
    out.say("Next steps:");
    out.say(`  1. Point DNS for ${domain} and ${cmsDomain} at this server, and open ports 80 and 443.`);
    out.say(`  2. cd ${dir} && polysite doctor`);
    out.say("  3. polysite up");
    out.say(`  4. Open ${scheme}://${cmsDomain}/admin to create the first administrator (the setup token is POLYSITE_SETUP_TOKEN in .env).`);
    out.say("");
    out.say("Keep a copy of .env somewhere safe, apart from the backups: PAYLOAD_SECRET and the backup passphrase are needed to restore.");
    out.result({ ok: true, dir, domain, cmsDomain, scheme, version: coreVersion, database, files: files.map((f) => f.path), envFile: join(dir, ".env") });
    return EXIT.OK;
  },
};

async function askDomain(prompter, question) {
  if (!prompter.interactive) throw new CliError("--domain is required when there is no terminal to ask on.", { code: EXIT.USAGE, hint: "polysite init <dir> --domain example.org" });
  return prompter.ask(question, { validate: validateHost });
}
