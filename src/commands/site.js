import { EXIT } from "../lib/constants.js";
import { cmsOp } from "../lib/cmsOps.js";
import { usageError } from "../lib/errors.js";
import { validateHost } from "./init.js";

const list = {
  name: "list",
  summary: "List the sites in this install",
  usage: "site list [--json]",
  async run(ctx) {
    const r = await cmsOp(ctx, { action: "sites.list" });
    ctx.out.table(
      r.sites.map((s) => ({ ...s, modulesText: s.modules.join(",") })),
      [{ key: "id", header: "ID" }, { key: "name", header: "NAME" }, { key: "domain", header: "DOMAIN" }, { key: "theme", header: "THEME" }, { key: "modulesText", header: "MODULES" }],
    );
    ctx.out.result({ ok: true, ...r });
    return EXIT.OK;
  },
};

const create = {
  name: "create",
  summary: "Create a site",
  usage: "site create <name> --domain <host> [--theme <theme>]",
  positionals: { min: 1, max: 1, name: "the site's name" },
  description: "Adds a site to the CMS. Point the domain's DNS at the server and list it in the Caddyfile for HTTPS (see `polysite doctor`).",
  options: {
    domain: { type: "string", placeholder: "host", description: "The site's domain, for example news.example.org" },
    theme: { type: "string", placeholder: "theme", description: "A theme from `polysite theme list` (default: the installation's default)" },
  },
  async run(ctx, { values, positionals }) {
    const { out } = ctx;
    if (!values.domain) throw usageError("--domain is required.", "polysite site create \"My Site\" --domain site.example.org");
    const bad = validateHost(values.domain.toLowerCase());
    if (bad) throw usageError(bad);
    if (ctx.dryRun) {
      out.dryRun(`would create the site "${positionals[0]}" at ${values.domain}`);
      out.result({ ok: true, dryRun: true });
      return EXIT.OK;
    }
    const r = await cmsOp(ctx, { action: "sites.create", name: positionals[0], domain: values.domain, theme: values.theme });
    ctx.audit("site-create", { id: r.id, domain: r.domain, theme: r.theme });
    out.ok(`Created site "${r.name}" (${r.domain}, theme ${r.theme}).`);
    out.say(`Next: point DNS for ${r.domain} at this server and add it to the Caddyfile so it gets a certificate.`);
    out.result({ ok: true, ...r });
    return EXIT.OK;
  },
};

export default {
  name: "site",
  summary: "List and create sites",
  usage: "site <list|create> ...",
  subcommands: { list, create },
};
