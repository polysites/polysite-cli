// The plugin isolation rule (plugins/README.md), checked statically on a plugin's migration files. This is the same rule
// apps/cms/scripts/pluginMigrations.sh `check` enforces inside the CMS container; this copy needs no container, so
// `polysite plugin add` and `polysite doctor` can run it on files alone. `polysite migrate --check` runs the real one.

/** Payload and the URL index keep one column per collection in these; a plugin that adds a collection adds a column. */
export const ALLOWED_TABLES = ["payload_locked_documents_rels", "payload_preferences_rels", "site_urls_rels"];
/** Payload's job queue lists every task slug in an enum; a plugin that registers a task adds its slug. */
export const ALLOWED_ENUMS = ["enum_payload_jobs_task_slug", "enum_payload_jobs_log_task_slug"];

const IDENT = '(?:"public"\\.)?"([A-Za-z0-9_]+)"';

/** The `up()` part of a migration file's text. */
export function upPart(text) {
  const i = text.search(/export\s+async\s+function\s+down/);
  return i === -1 ? text : text.slice(0, i);
}

/**
 * Returns a list of problems (empty when the migration respects the rule).
 *   - it may alter only the tables it creates, plus Payload's bookkeeping tables
 *   - it may not change an enum it did not create (except the job queue's)
 *   - up() may not drop or delete anything
 */
export function checkMigrationText(text, file = "migration") {
  const up = upPart(text);
  const problems = [];
  const created = new Set([...up.matchAll(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+${IDENT}`, "g"))].map((m) => m[1]));
  const altered = new Set([...up.matchAll(new RegExp(`ALTER TABLE\\s+${IDENT}`, "g"))].map((m) => m[1]));
  const foreign = [...altered].filter((t) => !created.has(t) && !ALLOWED_TABLES.includes(t));
  if (foreign.length) problems.push(`${file} alters tables it did not create: ${foreign.join(", ")}`);
  const createdTypes = new Set([...up.matchAll(new RegExp(`CREATE TYPE\\s+${IDENT}`, "g"))].map((m) => m[1]));
  const alteredTypes = new Set([...up.matchAll(new RegExp(`ALTER TYPE\\s+${IDENT}`, "g"))].map((m) => m[1]));
  const foreignTypes = [...alteredTypes].filter((t) => !createdTypes.has(t) && !ALLOWED_ENUMS.includes(t));
  if (foreignTypes.length) problems.push(`${file} changes types it did not create: ${foreignTypes.join(", ")}`);
  if (/DROP (TABLE|COLUMN|TYPE)|DELETE FROM|TRUNCATE/i.test(up)) problems.push(`${file} deletes data or structure in up()`);
  return problems;
}
