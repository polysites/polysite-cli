import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { splitList } from "./envfile.js";
import { collectFacts, containerProgram } from "./pluginFacts.js";

export const CONTAINER_PLUGINS = "/repo/plugins";
export const CONTAINER_CORE_MIGRATIONS = "/repo/apps/cms/src/migrations";

/** Plugin folders switched off with POLYSITE_PLUGINS_OFF. */
export const disabledPlugins = (ctx) => splitList(ctx.envFile().get("POLYSITE_PLUGINS_OFF"));

export const pluginsDirOf = (ctx) => join(ctx.project().root, "plugins");
export const trashDirOf = (ctx) => join(ctx.project().root, ".polysite", "removed-plugins");

/** The newest copy of a removed plugin kept in .polysite/removed-plugins, or null. */
export function removedCopy(ctx, slug) {
  const dir = trashDirOf(ctx);
  if (!existsSync(dir)) return null;
  const match = readdirSync(dir).filter((n) => n === slug || n.startsWith(`${slug}-`)).sort();
  return match.length ? join(dir, match[match.length - 1]) : null;
}

async function viaContainer(ctx, args) {
  const r = await ctx.docker().inCms(["node", "--input-type=module", "-e", containerProgram(args)]);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  } catch {
    return null;
  }
}

/**
 * What is installed and what the core's own tables are.
 * Plugins come from the install folder's plugins/ when it has one (source checkouts, dev), otherwise from inside the CMS
 * image (published images carry their plugins). The core's migration snapshot comes from a checkout when there is one,
 * otherwise from the image. Returns { plugins, core, source } where source says where the plugins were read from.
 */
export async function loadFacts(ctx, { slug, pluginDir } = {}) {
  const root = ctx.project().root;
  const hostPlugins = pluginDir ? resolve(ctx.cwd, pluginDir) : pluginsDirOf(ctx);
  const hostCore = join(root, "apps", "cms", "src", "migrations");
  let plugins = [];
  let core = null;
  let source = "none";
  if (existsSync(hostPlugins)) {
    const r = collectFacts({ pluginsDir: hostPlugins, coreMigrationsDir: existsSync(hostCore) ? hostCore : null, slug });
    plugins = r.plugins;
    core = r.core;
    source = "folder";
  } else {
    const r = await viaContainer(ctx, { pluginsDir: CONTAINER_PLUGINS, coreMigrationsDir: CONTAINER_CORE_MIGRATIONS, slug });
    if (r) {
      plugins = r.plugins;
      core = r.core;
      source = "image";
    }
  }
  if (!core && source !== "image") {
    const r = await viaContainer(ctx, { pluginsDir: null, coreMigrationsDir: CONTAINER_CORE_MIGRATIONS, slug: null });
    core = r?.core ?? null;
  }
  return { plugins, core, source };
}

/** Table names and applied plugin migrations from the database, or null when it cannot be asked. */
export async function databaseState(ctx) {
  const docker = ctx.docker();
  const t = await docker.psql("SELECT tablename FROM pg_tables WHERE schemaname = 'public';");
  if (t.code !== 0) return null;
  const tables = new Set(t.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  let migrations = new Set();
  if (tables.has("payload_migrations")) {
    const m = await docker.psql("SELECT name FROM payload_migrations;");
    if (m.code === 0) migrations = new Set(m.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  }
  return { tables, migrations };
}
