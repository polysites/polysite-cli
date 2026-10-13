// Reads what is on disk about plugins: manifest, package type, entry file, migrations and the tables each migration
// creates. Uses only Node's own modules and no other file of this CLI, because the same text is also run inside the CMS
// container (`node --input-type=module -e`) when the plugins are baked into the image rather than in a folder on the host.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RELS_TABLES = ["payload_locked_documents_rels", "payload_preferences_rels", "site_urls_rels"];

const strip = (key) => key.replace(/^public\./, "");

function latest(dir, ext) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(ext)).sort();
  return files.length ? join(dir, files[files.length - 1]) : null;
}

/** Table, enum and bookkeeping-column names out of one Payload migration snapshot (the .json beside a migration). */
function snapshotFacts(file) {
  if (!file) return null;
  const d = JSON.parse(readFileSync(file, "utf8"));
  const relColumns = {};
  for (const t of RELS_TABLES) relColumns[t] = Object.keys(d.tables?.[`public.${t}`]?.columns ?? d.tables?.[t]?.columns ?? {});
  return {
    file: file.split(/[\\/]/).pop(),
    tables: Object.keys(d.tables ?? {}).map(strip),
    enums: Object.keys(d.enums ?? {}).map(strip),
    relColumns,
  };
}

/** The `up()` half of a plugin migration file. */
function upPart(text) {
  const i = text.search(/export\s+async\s+function\s+down/);
  return i === -1 ? text : text.slice(0, i);
}

/** What the plugin's own migrations create, read from their SQL (the cross-check for the snapshot). */
function createdBy(migrationsDir) {
  const tables = new Set();
  const types = new Set();
  const relColumns = {};
  const files = existsSync(migrationsDir) ? readdirSync(migrationsDir).filter((f) => /\.m?js$/.test(f)).sort() : [];
  for (const f of files) {
    const up = upPart(readFileSync(join(migrationsDir, f), "utf8"));
    for (const m of up.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(?:"public"\.)?"([A-Za-z0-9_]+)"/g)) tables.add(m[1]);
    for (const m of up.matchAll(/CREATE TYPE\s+(?:"public"\.)?"([A-Za-z0-9_]+)"/g)) types.add(m[1]);
    for (const m of up.matchAll(/ALTER TABLE\s+(?:"public"\.)?"([A-Za-z0-9_]+)"\s+ADD COLUMN(?: IF NOT EXISTS)?\s+"([A-Za-z0-9_]+)"/g)) {
      (relColumns[m[1]] ??= []).push(m[2]);
    }
  }
  return { files, tables: [...tables], types: [...types], relColumns };
}

/** Facts about one plugin folder, or null when the folder is not a plugin at all (no manifest file). */
export function pluginFacts(dir, folder) {
  const manifestFile = join(dir, "polysite.plugin.json");
  if (!existsSync(manifestFile)) return null;
  const facts = { folder, problems: [] };
  try {
    facts.manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch {
    facts.manifest = null;
    facts.problems.push("polysite.plugin.json is not valid JSON");
  }
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    facts.problems.push("package.json is missing or not valid JSON");
  }
  if (pkg && pkg.type !== "module") facts.problems.push('package.json lacks "type": "module"');
  if (!existsSync(join(dir, "src", "index.js"))) facts.problems.push("src/index.js is missing");
  if (facts.manifest) {
    const m = facts.manifest;
    if (!m.slug || !/^[a-z0-9][a-z0-9-]*$/.test(m.slug)) facts.problems.push("the manifest has no valid slug");
    else if (m.slug !== folder) facts.problems.push(`the folder is named "${folder}" but the manifest slug is "${m.slug}"`);
  }
  const migrationsDir = join(dir, facts.manifest?.migrations || "migrations");
  facts.created = createdBy(migrationsDir);
  facts.snapshot = snapshotFacts(latest(migrationsDir, ".json"));
  facts.hasWeb = existsSync(join(dir, "web", "nuxt.config.ts")) || existsSync(join(dir, "web", "nuxt.config.js"));
  facts.version = facts.manifest?.version ?? null;
  return facts;
}

/**
 * { plugins: [facts...], core: { tables, enums, relColumns } | null }
 * `slug` limits the work to one plugin folder.
 */
export function collectFacts({ pluginsDir, coreMigrationsDir, slug }) {
  const plugins = [];
  if (pluginsDir && existsSync(pluginsDir)) {
    for (const e of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      if (slug && e.name !== slug) continue;
      const f = pluginFacts(join(pluginsDir, e.name), e.name);
      if (f) plugins.push(f);
    }
  }
  return { plugins, core: coreMigrationsDir ? snapshotFacts(latest(coreMigrationsDir, ".json")) : null };
}

/** The exact text to hand to `node --input-type=module -e` so the container produces the same answer as the host. */
export function containerProgram({ pluginsDir, coreMigrationsDir, slug }) {
  const self = readFileSync(new URL(import.meta.url), "utf8").replace(/^export /gm, "");
  const call = `console.log(JSON.stringify(collectFacts(${JSON.stringify({ pluginsDir, coreMigrationsDir, slug: slug ?? null })})));`;
  return `${self}\n${call}`;
}
