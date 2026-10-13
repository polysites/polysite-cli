import { CliError } from "./errors.js";

const IDENT = /^[A-Za-z0-9_]+$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
/** Tables that are the core's or Payload's own: a purge must never name one, whatever the snapshots say. */
const PROTECTED = /^(payload_|_pages_v|_sites_v|_users_v|(users|roles|sites|pages|media|redirects|forms|form_submissions|privacy_requests|site_urls)(_|$)|search(_rels|_locales)?$)/;

const q = (name) => {
  if (!IDENT.test(name)) throw new CliError(`Refusing to build SQL with the odd identifier "${name}".`);
  return `"${name}"`;
};

/** The tables, enums and bookkeeping columns a plugin owns: what its snapshot, its own SQL and the core agree on. */
export function ownedObjects(plugin, core) {
  const coreTables = new Set(core.tables);
  const createdTables = new Set(plugin.created.tables);
  const tables = plugin.snapshot.tables.filter((t) => createdTables.has(t) && !coreTables.has(t));
  const coreEnums = new Set(core.enums);
  const createdTypes = new Set(plugin.created.types);
  const enums = plugin.snapshot.enums.filter((e) => createdTypes.has(e) && !coreEnums.has(e));
  const relColumns = [];
  for (const [table, cols] of Object.entries(plugin.snapshot.relColumns)) {
    const coreCols = new Set(core.relColumns?.[table] ?? []);
    const added = new Set(plugin.created.relColumns?.[table] ?? []);
    for (const c of cols) if (!coreCols.has(c) && added.has(c)) relColumns.push({ table, column: c });
  }

  return { tables, enums, relColumns };
}

/**
 * What `plugin purge` would remove, worked out from the plugin's own migration snapshot and the core's.
 *
 *   owned tables   in the plugin's latest snapshot, created by the plugin's own migrations (read from their SQL), and not
 *                  in the core's snapshot. All three must agree, so a stale snapshot can never make it drop a core table.
 *   owned enums    the same for CREATE TYPE.
 *   owned columns  the per-collection columns Payload keeps in its bookkeeping tables for the plugin's collections.
 *
 * Returns { slug, tables, enums, relColumns, statements }. Throws CliError when it cannot be sure.
 */
export function buildPurgePlan({ slug, plugin, core }) {
  if (!SLUG.test(slug)) throw new CliError(`"${slug}" is not a valid plugin slug.`);
  if (!plugin) throw new CliError(`No plugin "${slug}" was found to read its migrations from.`, { hint: "Its folder must still exist (disabled is fine), or be in .polysite/removed-plugins/. Use --plugin-dir to point at a copy." });
  if (!plugin.snapshot) throw new CliError(`Plugin "${slug}" has no migration snapshot (a .json beside its migrations), so the tables it owns cannot be determined.`, { hint: "Nothing was changed." });
  if (!core) throw new CliError("The core's migration snapshot could not be read, so the plugin's tables cannot be told apart from the core's.", { hint: "Is the CMS image present? Nothing was changed." });

  const { tables, enums, relColumns } = ownedObjects(plugin, core);

  const bad = tables.filter((t) => PROTECTED.test(t));
  if (bad.length) throw new CliError(`The plan names core tables (${bad.join(", ")}). Refusing; this is a bug or a damaged snapshot.`, { hint: "Nothing was changed." });
  if (!tables.length) throw new CliError(`Plugin "${slug}" owns no tables according to its migrations, so there is nothing to purge.`);

  const statements = [
    ...relColumns.map((r) => `ALTER TABLE ${q(r.table)} DROP COLUMN IF EXISTS ${q(r.column)};`),
    ...tables.map((t) => `DROP TABLE IF EXISTS ${q(t)} CASCADE;`),
    ...enums.map((e) => `DROP TYPE IF EXISTS "public".${q(e)};`),
    // The plugin's migration records, so putting the plugin back later re-creates its tables.
    `DELETE FROM "payload_migrations" WHERE "name" LIKE '${slug}\\_\\_%' ESCAPE '\\';`,
  ];
  return { slug, tables, enums, relColumns, statements };
}
