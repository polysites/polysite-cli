import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { EXIT } from "../lib/constants.js";
import { confirmTyped, confirmYes } from "../lib/confirm.js";
import { CliError, refused, usageError } from "../lib/errors.js";
import { run } from "../lib/exec.js";
import { checkMigrationText } from "../lib/isolation.js";
import { pluginFacts } from "../lib/pluginFacts.js";
import { buildPurgePlan, ownedObjects } from "../lib/pluginPlan.js";
import { databaseState, disabledPlugins, loadFacts, pluginsDirOf, removedCopy, trashDirOf } from "../lib/pluginSource.js";
import { takeBackup } from "./backup.js";

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const slugArg = (s) => {
  if (!SLUG.test(s)) throw usageError(`"${s}" is not a plugin slug (lowercase letters, digits and dashes).`);
  return s;
};
const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function restartAdvice(ctx, mode) {
  ctx.out.say(
    mode === "prod"
      ? "Restart to apply: `polysite restart cms web`. Plugins are fixed in the image at build time, so adding or removing code in a production install means building your own image (docs/guide/plugins.md); switching one off needs no build."
      : "Restart to apply: `polysite restart cms web`.",
  );
}

// ---------------------------------------------------------------------------------------------------------------------

const list = {
  name: "list",
  summary: "List plugins: version, scope, kind, state and whether their tables exist",
  usage: "plugin list [--json]",
  async run(ctx) {
    const { out } = ctx;
    const { plugins, core, source } = await loadFacts(ctx);
    const off = new Set(disabledPlugins(ctx));
    const db = await databaseState(ctx);
    const rows = plugins.map((p) => {
      const m = p.manifest ?? {};
      const slug = m.slug ?? p.folder;
      let tables = "unknown";
      let tableCount = null;
      let present = null;
      if (p.snapshot && core) {
        const owned = ownedObjects(p, core).tables;
        tableCount = owned.length;
        if (db) {
          present = owned.filter((t) => db.tables.has(t)).length;
          tables = `${present}/${owned.length}`;
        } else tables = `?/${owned.length}`;
      } else if (!p.created.tables.length) tables = "none needed";
      const migrations = p.created.files.map((f) => `${slug}__${f.replace(/\.m?js$/, "")}`);
      return {
        slug,
        version: m.version ?? "?",
        scope: m.scope ?? "?",
        kind: [].concat(m.kind ?? "plain").join("+"),
        state: p.problems.length ? "problem" : off.has(slug) || off.has(p.folder) ? "disabled" : "enabled",
        tables,
        migrations: db ? `${migrations.filter((n) => db.migrations.has(n)).length}/${migrations.length}` : `?/${migrations.length}`,
        problems: p.problems,
        tablesPresent: present,
        tablesOwned: tableCount,
      };
    });
    const known = new Set(plugins.flatMap((p) => [p.folder, p.manifest?.slug]));
    const missing = [...off].filter((s) => !known.has(s));
    if (!rows.length) {
      out.say(source === "none" ? "No plugins found (no plugins/ folder here, and the CMS image could not be read)." : "No plugins installed.");
    } else {
      out.table(rows, [
        { key: "slug", header: "PLUGIN" }, { key: "version", header: "VERSION" }, { key: "scope", header: "SCOPE" },
        { key: "kind", header: "KIND" }, { key: "state", header: "STATE" }, { key: "tables", header: "TABLES" }, { key: "migrations", header: "MIGRATIONS" },
      ]);
      for (const r of rows) for (const p of r.problems) out.warn(`${r.slug}: ${p}`);
    }
    for (const s of missing) out.warn(`POLYSITE_PLUGINS_OFF names "${s}" but no such plugin is installed (its data, if any, stays in the database).`);
    if (db === null && rows.length) out.hint("The database could not be asked, so table counts show ?. Is the stack running (`polysite status`)?");
    out.say(`${rows.length ? "\n" : ""}Read from ${source === "folder" ? "the plugins/ folder" : source === "image" ? "inside the CMS image" : "nowhere"}. TABLES is present/owned; MIGRATIONS is applied/total.`);
    out.result({ ok: true, source, databaseReachable: db !== null, plugins: rows, disabledButMissing: missing });
    return EXIT.OK;
  },
};

// ---------------------------------------------------------------------------------------------------------------------

function candidatesIn(root) {
  const here = pluginFacts(root, basename(root));
  if (here) return [{ dir: root, facts: here }];
  const found = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    const f = pluginFacts(join(root, e.name), e.name);
    if (f) found.push({ dir: join(root, e.name), facts: f });
  }
  return found;
}

const add = {
  name: "add",
  summary: "Install a plugin from a git URL or a folder (never deletes data)",
  usage: "plugin add <git-url|path> [--only <slug>] [--ref <tag|branch>]",
  positionals: { min: 1, max: 1, name: "a git URL or a folder path" },
  description: `
Copies the plugin's code into plugins/<slug>. Nothing from the plugin is executed: no npm install, no scripts. The plugin
must carry a valid polysite.plugin.json and its migrations must respect the isolation rule (own tables only), or it is
not installed. Run \`polysite migrate\` afterwards in a production install.
A repository that holds several plugins (such as polysite-plugins) needs --only <slug>, or --all.`,
  options: {
    only: { type: "string", multiple: true, placeholder: "slug", description: "Install just this plugin from a repository with several (repeatable)" },
    all: { type: "boolean", description: "Install every plugin found in the repository" },
    ref: { type: "string", placeholder: "ref", description: "Git tag or branch to fetch (default: the default branch)" },
  },
  async run(ctx, { values, positionals }) {
    const { out } = ctx;
    const source = positionals[0];
    const pluginsDir = pluginsDirOf(ctx);
    const isGit = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/.test(source) || /\.git$/.test(source);
    let workRoot;
    let cleanup = () => {};
    if (isGit) {
      const tmp = mkdtempSync(join(tmpdir(), "polysite-plugin-"));
      cleanup = () => rmSync(tmp, { recursive: true, force: true });
      out.info(`Fetching ${source} ...`);
      const r = await run("git", ["clone", "--depth", "1", ...(values.ref ? ["--branch", values.ref] : []), "--", source, join(tmp, "repo")], { env: { GIT_TERMINAL_PROMPT: "0" } });
      if (r.code !== 0) {
        cleanup();
        throw new CliError(`git clone failed: ${r.stderr.trim().split(/\r?\n/).pop() || `exit code ${r.code}`}`, { hint: r.code === 127 ? "Install git, or pass a folder path instead." : "Check the URL and that you can read the repository." });
      }
      workRoot = join(tmp, "repo");
    } else {
      workRoot = resolve(ctx.cwd, source);
      if (!existsSync(workRoot)) throw usageError(`${source} is neither a git URL nor an existing folder.`);
    }
    try {
      const found = candidatesIn(workRoot);
      if (!found.length) throw usageError(`No plugin found in ${source} (no polysite.plugin.json).`);
      const only = asList(values.only);
      let chosen = found;
      if (only.length) {
        chosen = found.filter((c) => only.includes(c.facts.manifest?.slug ?? c.facts.folder));
        const missing = only.filter((s) => !chosen.some((c) => (c.facts.manifest?.slug ?? c.facts.folder) === s));
        if (missing.length) throw usageError(`Not found in the source: ${missing.join(", ")}.`, `Available: ${found.map((c) => c.facts.manifest?.slug ?? c.facts.folder).join(", ")}`);
      } else if (found.length > 1 && !values.all) {
        throw usageError(`The source holds ${found.length} plugins: ${found.map((c) => c.facts.manifest?.slug ?? c.facts.folder).join(", ")}.`, "Choose with --only <slug> (repeatable), or install all with --all.");
      }
      const installed = [];
      for (const c of chosen) {
        const slug = c.facts.manifest?.slug ?? c.facts.folder;
        // Folder name and slug must agree for single-plugin repositories whose clone folder is named after the repo.
        const facts = c.dir === workRoot ? pluginFacts(c.dir, slug) : c.facts;
        const problems = [...facts.problems];
        const migDir = join(c.dir, facts.manifest?.migrations || "migrations");
        if (existsSync(migDir)) {
          for (const f of readdirSync(migDir).filter((n) => /\.m?js$/.test(n))) problems.push(...checkMigrationText(readFileSync(join(migDir, f), "utf8"), `migrations/${f}`));
        }
        if (problems.length) {
          throw new CliError(`Plugin "${slug}" cannot be installed:\n  - ${problems.join("\n  - ")}`, { code: EXIT.CHECK_FAILED, hint: "See plugins/README.md (the isolation rule)." });
        }
        const dest = join(pluginsDir, slug);
        if (existsSync(dest)) throw refused(`Plugin "${slug}" is already installed (${dest}).`, "Remove it first with `polysite plugin remove` (its data stays), or install under another folder.");
        if (ctx.dryRun) {
          out.dryRun(`would copy plugin "${slug}" ${facts.version ?? ""} to ${dest}`);
        } else {
          mkdirSync(pluginsDir, { recursive: true });
          cpSync(c.dir, dest, { recursive: true, filter: (p) => ![".git", "node_modules"].includes(basename(p)) });
          ctx.audit("plugin-add", { slug, version: facts.version ?? "?", source });
          out.ok(`Installed plugin "${slug}" ${facts.version ?? ""} into ${dest}`);
        }
        installed.push({ slug, version: facts.version, scope: facts.manifest?.scope });
      }
      if (!ctx.dryRun) {
        out.say("");
        out.say("Its code is in place. Next: `polysite migrate` (creates its tables), then restart.");
        restartAdvice(ctx, ctx.project().mode);
      }
      out.result({ ok: true, installed, dryRun: ctx.dryRun });
      return EXIT.OK;
    } finally {
      cleanup();
    }
  },
};

// ---------------------------------------------------------------------------------------------------------------------

const remove = {
  name: "remove",
  summary: "Take a plugin's code out of plugins/ (its data stays in the database)",
  usage: "plugin remove <slug> [--yes]",
  positionals: { min: 1, max: 1, name: "the plugin slug" },
  description: `
Moves plugins/<slug> to .polysite/removed-plugins/ (nothing is deleted from disk either) and switches nothing else. The
plugin's tables and everything people saved with it stay in the database, so putting the plugin back finds it all as it
was. \`polysite plugin purge <slug>\` is the only command that deletes plugin data.`,
  async run(ctx, { positionals }) {
    const { out } = ctx;
    const slug = slugArg(positionals[0]);
    const src = join(pluginsDirOf(ctx), slug);
    if (!existsSync(src)) throw usageError(`There is no plugins/${slug} folder in this install.`, "Plugins baked into an image cannot be removed here; switch them off with `polysite plugin disable`.");
    await confirmYes(ctx, `Move plugins/${slug} out of the install? (its data stays in the database)`);
    const dest = join(trashDirOf(ctx), `${slug}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    if (ctx.dryRun) out.dryRun(`would move ${src} to ${dest}`);
    else {
      mkdirSync(trashDirOf(ctx), { recursive: true });
      try {
        renameSync(src, dest);
      } catch {
        cpSync(src, dest, { recursive: true });
        rmSync(src, { recursive: true, force: true });
      }
      ctx.audit("plugin-remove", { slug, movedTo: dest });
    }
    out.ok(`Removed plugin "${slug}" (a copy is kept in ${dest}).`);
    out.say("Its tables and content stay in the database. To delete them for good: `polysite plugin purge " + slug + "`.");
    restartAdvice(ctx, ctx.project().mode);
    out.result({ ok: true, slug, movedTo: dest, dataKept: true });
    return EXIT.OK;
  },
};

// ---------------------------------------------------------------------------------------------------------------------

function toggle(kind) {
  const disabling = kind === "disable";
  return {
    name: kind,
    summary: disabling ? "Switch a plugin off without touching its data (POLYSITE_PLUGINS_OFF)" : "Switch a disabled plugin back on",
    usage: `plugin ${kind} <slug> [--restart]`,
    positionals: { min: 1, max: 1, name: "the plugin slug" },
    options: { restart: { type: "boolean", description: "Restart cms and web now so the change takes effect" } },
    async run(ctx, { values, positionals }) {
      const { out } = ctx;
      const slug = slugArg(positionals[0]);
      const env = ctx.envFile();
      const off = disabledPlugins(ctx);
      const isOff = off.includes(slug);
      if (disabling) {
        const { plugins } = await loadFacts(ctx);
        const known = plugins.some((p) => p.folder === slug || p.manifest?.slug === slug);
        if (!known) throw usageError(`No plugin "${slug}" is installed.`, "See `polysite plugin list`.");
      } else if (!isOff) {
        out.ok(`"${slug}" is not disabled; nothing to do.`);
        out.result({ ok: true, slug, changed: false });
        return EXIT.OK;
      }
      if (disabling && isOff) {
        out.ok(`"${slug}" is already disabled.`);
        out.result({ ok: true, slug, changed: false });
        return EXIT.OK;
      }
      const next = disabling ? [...off, slug] : off.filter((s) => s !== slug);
      if (ctx.dryRun) out.dryRun(`would set POLYSITE_PLUGINS_OFF=${next.join(",")} in ${ctx.project().envPath}`);
      else {
        if (next.length) env.set("POLYSITE_PLUGINS_OFF", next.join(","));
        else env.unset("POLYSITE_PLUGINS_OFF");
        env.write();
        ctx.audit(`plugin-${kind}`, { slug });
      }
      out.ok(disabling ? `Plugin "${slug}" is switched off. Its data stays in the database.` : `Plugin "${slug}" is switched on.`);
      if (values.restart) {
        const r = await ctx.docker().mutate(["up", "-d", "--force-recreate", "--no-deps", "cms", "web"], { stream: true });
        if (r.code !== 0) throw new CliError("docker compose could not restart cms and web.", { hint: "Run `polysite logs` and `polysite doctor`." });
        if (!ctx.dryRun) {
          for (const s of ["cms", "web"]) {
            out.info(`Waiting for ${s} to be healthy...`);
            const w = await ctx.docker().waitReady(s, { timeoutSec: 300, pollMs: ctx.pollMs });
            if (!w.ok) throw new CliError(`${s} is ${w.state} after the restart.`, { hint: `polysite logs ${s} --tail 50` });
          }
        }
      } else out.say("Run `polysite restart cms web` (or pass --restart) for it to take effect.");
      out.result({ ok: true, slug, changed: true, disabled: next });
      return EXIT.OK;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------

const purge = {
  name: "purge",
  summary: "DELETE a plugin's tables and data for good (the only command that does)",
  usage: "plugin purge <slug> [--dry-run] [--confirm <slug>]",
  positionals: { min: 1, max: 1, name: "the plugin slug" },
  description: `
Drops the tables a plugin created, worked out from the plugin's own migration snapshot, cross-checked against its
migration SQL and the core's snapshot (so a core table can never be named). It shows exactly what will be dropped, with
row counts, and then:
  1. needs the plugin switched off or removed first (a loaded plugin would break),
  2. needs the slug typed back (or --confirm <slug>; --yes is not enough),
  3. takes a fresh backup and test-restores it, and refuses if that fails,
  4. runs the drops in ONE transaction and writes an audit line before and after.
There is no undo except restoring that backup.`,
  options: { "plugin-dir": { type: "string", placeholder: "path", description: "Read the plugin's migrations from this folder (if plugins/ no longer has it)" } },
  async run(ctx, { values, positionals }) {
    const { out } = ctx;
    const slug = slugArg(positionals[0]);
    const off = disabledPlugins(ctx);
    const loaded = await loadFacts(ctx, { slug });
    const installed = loaded.plugins.find((p) => p.folder === slug || p.manifest?.slug === slug);
    if (installed && !off.includes(slug)) {
      throw refused(`Plugin "${slug}" is still switched on.`, `Switch it off first (\`polysite plugin disable ${slug} --restart\`) or remove it (\`polysite plugin remove ${slug}\`), then purge.`);
    }
    let plugin = installed;
    let core = loaded.core;
    let from = loaded.source === "image" ? "the CMS image" : "plugins/";
    if (values["plugin-dir"]) {
      const r = await loadFacts(ctx, { pluginDir: values["plugin-dir"], slug });
      plugin = r.plugins[0] ?? null;
      core ??= r.core;
      from = values["plugin-dir"];
    } else if (!plugin) {
      const copy = removedCopy(ctx, slug);
      if (copy) {
        plugin = pluginFacts(copy, slug);
        from = copy;
      }
    }
    const plan = buildPurgePlan({ slug, plugin, core });

    const db = await databaseState(ctx);
    if (!db) throw new CliError("The database could not be reached, so what exists cannot be listed.", { hint: "Start the stack (`polysite up`) and try again. Nothing was changed." });
    const existing = plan.tables.filter((t) => db.tables.has(t));
    const counts = {};
    if (existing.length) {
      const r = await ctx.docker().psql(existing.map((t) => `SELECT '${t}', count(*) FROM "${t}"`).join(" UNION ALL ") + ";");
      for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) {
        const [t, n] = line.split("|");
        counts[t] = Number(n);
      }
    }
    const relIn = [...new Set(plan.relColumns.map((r) => `'${r.table}'`))].join(", ");
    const existingCols = new Set();
    if (relIn) {
      const c = await ctx.docker().psql(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN (${relIn});`);
      for (const l of c.stdout.split(/\r?\n/)) if (l.trim()) existingCols.add(l.trim());
    }
    const presentCols = plan.relColumns.filter((r) => existingCols.has(`${r.table}|${r.column}`));
    const recorded = [...db.migrations].filter((n) => n.startsWith(`${slug}__`));
    out.say(`Purge plan for plugin "${slug}" (migrations read from ${from}):`);
    out.say("");
    out.table(plan.tables.map((t) => ({ table: t, state: db.tables.has(t) ? "present" : "absent", rows: db.tables.has(t) ? (counts[t] ?? "?") : "-" })), [
      { key: "table", header: "TABLE" }, { key: "state", header: "STATE" }, { key: "rows", header: "ROWS" },
    ]);
    out.say("");
    out.say("SQL that will run, in one transaction:");
    for (const s of plan.statements) out.say(`  ${s}`);
    out.say("");

    if (!existing.length && !presentCols.length && !recorded.length) {
      out.ok("None of its tables exist: nothing to purge.");
      out.result({ ok: true, slug, purged: false, plan });
      return EXIT.OK;
    }
    if (ctx.dryRun) {
      out.dryRun("nothing was dropped (this was a dry run)");
      out.result({ ok: true, dryRun: true, slug, plan, rows: counts });
      return EXIT.OK;
    }

    const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
    await confirmTyped(ctx, `This permanently deletes ${existing.length} table(s) holding ${totalRows} row(s) of the "${slug}" plugin. It cannot be undone except by restoring a backup.`, slug);

    let backupName;
    try {
      ({ name: backupName } = await takeBackup(ctx, { verify: true }));
    } catch (e) {
      throw new CliError(`Refusing to purge without a good backup. ${e.message}`, { code: EXIT.REFUSED, hint: "Nothing was dropped." });
    }
    ctx.audit("plugin-purge-start", { slug, tables: plan.tables.length, rows: totalRows, backup: backupName });
    const sql = `${plan.statements.join("\n")}\n`;
    const r = await ctx.docker().psql(sql, { write: true, tuples: false });
    if (r.code !== 0) {
      ctx.audit("plugin-purge-failed", { slug, backup: backupName });
      throw new CliError(`The drop failed and was rolled back (it ran in one transaction): ${r.stderr.trim().split(/\r?\n/).pop()}`, { hint: `Nothing was dropped. Backup kept: ${backupName}` });
    }
    const after = await databaseState(ctx);
    const left = after ? plan.tables.filter((t) => after.tables.has(t)) : [];
    ctx.audit("plugin-purge-done", { slug, tables: plan.tables.length, backup: backupName, remaining: left.length });
    if (left.length) throw new CliError(`The purge ran but these tables still exist: ${left.join(", ")}.`);
    out.ok(`Purged plugin "${slug}": ${plan.tables.length} table(s), ${plan.enums.length} type(s), ${plan.relColumns.length} bookkeeping column(s) dropped.`);
    out.say(`Backup taken first: ${backupName}  (restore it with \`polysite restore ${backupName}\`).`);
    out.result({ ok: true, slug, purged: true, backup: backupName, tablesDropped: plan.tables, rows: counts });
    return EXIT.OK;
  },
};

export default {
  name: "plugin",
  summary: "List, add, remove, switch off or purge plugins",
  usage: "plugin <list|add|remove|enable|disable|purge> ...",
  subcommands: { list, add, remove, enable: toggle("enable"), disable: toggle("disable"), purge },
};
