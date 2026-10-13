import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const columns = (names) => Object.fromEntries(names.map((n) => [n, { name: n, type: "integer" }]));

/** The kind of snapshot Payload writes beside a migration: tables and enums keyed "public.<name>". */
export function snapshot({ tables, enums = [], relColumns = {} }) {
  const t = Object.fromEntries(tables.map((n) => [`public.${n}`, { name: n, schema: "public", columns: columns(["id"]) }]));
  for (const [table, cols] of Object.entries(relColumns)) t[`public.${table}`] = { name: table, schema: "public", columns: columns(["id", ...cols]) };
  return { version: "7", dialect: "postgresql", tables: t, enums: Object.fromEntries(enums.map((e) => [`public.${e}`, { name: e, schema: "public", values: ["a"] }])) };
}

/** The core's own latest snapshot, where a source checkout keeps it. */
export function writeCore(root) {
  const dir = join(root, "apps", "cms", "src", "migrations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "20260101_000000_core.json"),
    JSON.stringify(snapshot({ tables: ["users", "pages", "sites", "payload_migrations", "payload_locked_documents_rels", "payload_preferences_rels", "site_urls_rels"], enums: ["enum_pages_status"], relColumns: { payload_locked_documents_rels: ["pages_id"], payload_preferences_rels: ["users_id"], site_urls_rels: ["pages_id"] } })),
  );
}

/** A plugin folder that owns tables `<slug>` and `<slug>_locales` and one enum. */
export function writePlugin(root, slug, { version = "1.0.0", scope = "per-site", migrationSql, problems = [] } = {}) {
  const dir = join(root, "plugins", slug);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "migrations"), { recursive: true });
  writeFileSync(join(dir, "polysite.plugin.json"), JSON.stringify({ slug, label: slug, scope, version }));
  writeFileSync(join(dir, "package.json"), JSON.stringify(problems.includes("no-module") ? { name: slug } : { name: slug, type: "module" }));
  writeFileSync(join(dir, "src", "index.js"), "export default (c) => c;\n");
  const sql =
    migrationSql ??
    `CREATE TYPE "public"."enum_${slug}_kind" AS ENUM('a');
  CREATE TABLE "${slug}" ("id" serial PRIMARY KEY);
  CREATE TABLE "${slug}_locales" ("id" serial PRIMARY KEY);
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "${slug}_id" integer;
  ALTER TABLE "site_urls_rels" ADD COLUMN "${slug}_id" integer;`;
  writeFileSync(
    join(dir, "migrations", "20260102_000000_tables.js"),
    `export async function up({ db, sql }) {\n  await db.execute(sql\`\n  ${sql}\`)\n}\n\nexport async function down({ db, sql }) {\n  await db.execute(sql\`DROP TABLE "${slug}" CASCADE;\`)\n}\n`,
  );
  writeFileSync(
    join(dir, "migrations", "20260102_000000_tables.json"),
    JSON.stringify(
      snapshot({
        tables: ["users", "pages", "sites", "payload_migrations", `${slug}`, `${slug}_locales`],
        enums: ["enum_pages_status", `enum_${slug}_kind`],
        relColumns: { payload_locked_documents_rels: ["pages_id", `${slug}_id`], payload_preferences_rels: ["users_id"], site_urls_rels: ["pages_id", `${slug}_id`] },
      }),
    ),
  );
  return dir;
}
