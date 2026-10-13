import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { EXIT } from "../lib/constants.js";
import { CliError } from "../lib/errors.js";

/** The same rule the CMS uses to offer themes (Sites.ts discoverThemes): polysite-theme-<name>/layouts/<name>.vue. */
export function discoverThemes(dir) {
  if (!existsSync(dir)) return [];
  const themes = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const m = e.isDirectory() && /^polysite-theme-(.+)$/.exec(e.name);
    if (!m || !existsSync(join(dir, e.name, "layouts", `${m[1]}.vue`))) continue;
    let label = m[1];
    let description = "";
    try {
      const meta = JSON.parse(readFileSync(join(dir, e.name, "theme.json"), "utf8"));
      if (typeof meta.label === "string" && meta.label) label = meta.label;
      if (typeof meta.description === "string") description = meta.description;
    } catch { /* no theme.json: the folder name is the label */ }
    themes.push({ value: m[1], label, description });
  }
  return themes.sort((a, b) => a.value.localeCompare(b.value));
}

const PROGRAM = `
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
${discoverThemes.toString()}
console.log(JSON.stringify(discoverThemes("/repo/themes")));
`;

const list = {
  name: "list",
  summary: "List the themes this install offers to sites",
  usage: "theme list [--json]",
  async run(ctx) {
    const { out } = ctx;
    const hostDir = join(ctx.project().root, "themes");
    let themes;
    let source;
    if (existsSync(hostDir)) {
      themes = discoverThemes(hostDir);
      source = "the themes/ folder";
    } else {
      const r = await ctx.docker().inCms(["node", "--input-type=module", "-e", PROGRAM]);
      if (r.code !== 0) throw new CliError("The themes could not be read from the CMS image.", { hint: "Is Docker running? Try `polysite status`." });
      themes = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
      source = "inside the CMS image";
    }
    if (!themes.length) out.say("No themes found (the CMS falls back to its built-in default).");
    else out.table(themes, [{ key: "value", header: "THEME" }, { key: "label", header: "NAME" }, { key: "description", header: "DESCRIPTION" }]);
    out.say(`\nRead from ${source}. Themes are fixed at build time; use one with \`polysite site create --theme <theme>\`.`);
    out.result({ ok: true, source, themes });
    return EXIT.OK;
  },
};

export default {
  name: "theme",
  summary: "List the available themes",
  usage: "theme list",
  subcommands: { list },
};
