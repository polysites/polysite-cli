import { EXIT } from "../lib/constants.js";
import { cmsOp } from "../lib/cmsOps.js";
import { usageError } from "../lib/errors.js";
import { generatePassword } from "../lib/secrets.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 12;

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

async function readStdinLine(stdin) {
  let data = "";
  for await (const chunk of stdin) {
    data += chunk;
    if (data.includes("\n")) break;
  }
  return data.split(/\r?\n/)[0];
}

/**
 * Where the password comes from: --generate-password (printed once, because you asked for it), --password-stdin (a
 * pipe), or a hidden prompt. Never a command-line value, which would sit in shell history and the process list.
 */
async function obtainPassword(ctx, values) {
  const sources = ["generate-password", "password-stdin"].filter((k) => values[k]);
  if (sources.length > 1) throw usageError("Choose one of --generate-password and --password-stdin.");
  let password;
  let generated = false;
  if (values["generate-password"]) {
    password = generatePassword(20);
    generated = true;
  } else if (values["password-stdin"]) {
    password = await readStdinLine(ctx.io.stdin);
  } else if (ctx.prompter().interactive) {
    password = await ctx.prompter().askPassword("New password");
  } else {
    throw usageError("There is no terminal to ask for a password on.", "Use --generate-password, or pipe it with --password-stdin.");
  }
  if (password.length < MIN_PASSWORD) throw usageError(`The password must be at least ${MIN_PASSWORD} characters.`);
  return { password, generated };
}

const passwordOptions = {
  "generate-password": { type: "boolean", description: "Generate a strong password and print it once" },
  "password-stdin": { type: "boolean", description: "Read the password from the first line of stdin" },
};

const create = {
  name: "create",
  summary: "Create a user",
  usage: "user create <email> [--super-admin | --role <name>] [--site <domain|id>...] [--generate-password | --password-stdin]",
  positionals: { min: 1, max: 1, name: "an email address" },
  description: `
Creates the account through the CMS itself (so roles and checks apply). The password is read from a hidden prompt,
from stdin, or generated; it is only ever printed when you ask for --generate-password.`,
  options: {
    "super-admin": { type: "boolean", description: "Make a Super Admin (full access to everything)" },
    role: { type: "string", placeholder: "name", description: "The role's name (default: Site User; Super Admin with --super-admin)" },
    site: { type: "string", multiple: true, placeholder: "domain|id", description: "A site this user may work on (repeatable)" },
    ...passwordOptions,
  },
  async run(ctx, { values, positionals }) {
    const { out } = ctx;
    const email = positionals[0].trim().toLowerCase();
    if (!EMAIL.test(email)) throw usageError(`"${positionals[0]}" is not an email address.`);
    if (values["super-admin"] && values.role && values.role.toLowerCase() !== "super admin") throw usageError("--super-admin and --role disagree.");
    const { password, generated } = await obtainPassword(ctx, values);
    if (ctx.dryRun) {
      out.dryRun(`would create user ${email}${values["super-admin"] ? " as a Super Admin" : ""}`);
      out.result({ ok: true, dryRun: true, email });
      return EXIT.OK;
    }
    const r = await cmsOp(ctx, { action: "users.create", email, password, role: values.role, superAdmin: Boolean(values["super-admin"]), sites: asList(values.site) });
    ctx.audit("user-create", { email: r.email, role: r.role, superAdmin: r.superAdmin });
    out.ok(`Created ${r.email} (${r.role}${r.superAdmin ? ", super admin" : ""}).`);
    if (generated) {
      // stdout on purpose, so `pw=$(polysite user create ... --generate-password --json | jq -r .password)` works.
      if (!out.json) out.say(`Generated password (shown once): ${password}`);
    }
    out.result({ ok: true, id: r.id, email: r.email, role: r.role, superAdmin: r.superAdmin, ...(generated ? { password } : {}) });
    return EXIT.OK;
  },
};

const resetPassword = {
  name: "reset-password",
  summary: "Set a new password for a user (and unlock the account)",
  usage: "user reset-password <email> [--generate-password | --password-stdin]",
  positionals: { min: 1, max: 1, name: "an email address" },
  options: passwordOptions,
  async run(ctx, { values, positionals }) {
    const { out } = ctx;
    const email = positionals[0].trim().toLowerCase();
    const { password, generated } = await obtainPassword(ctx, values);
    if (ctx.dryRun) {
      out.dryRun(`would set a new password for ${email}`);
      out.result({ ok: true, dryRun: true, email });
      return EXIT.OK;
    }
    const r = await cmsOp(ctx, { action: "users.resetPassword", email, password });
    ctx.audit("user-reset-password", { email: r.email });
    out.ok(`Password changed for ${r.email}${r.unlocked ? " (account unlocked)" : ""}.`);
    if (generated && !out.json) out.say(`Generated password (shown once): ${password}`);
    out.result({ ok: true, email: r.email, ...(generated ? { password } : {}) });
    return EXIT.OK;
  },
};

const list = {
  name: "list",
  summary: "List users (never shows passwords)",
  usage: "user list [--json]",
  async run(ctx) {
    const r = await cmsOp(ctx, { action: "users.list" });
    ctx.out.table(
      r.users.map((u) => ({ ...u, super: u.superAdmin ? "yes" : "", sitesText: u.sites.join(", "), state: u.locked ? "locked" : "" })),
      [{ key: "id", header: "ID" }, { key: "email", header: "EMAIL" }, { key: "role", header: "ROLE" }, { key: "super", header: "SUPER" }, { key: "sitesText", header: "SITES" }, { key: "state", header: "STATE" }],
    );
    ctx.out.result({ ok: true, ...r });
    return EXIT.OK;
  },
};

export default {
  name: "user",
  summary: "Create users, reset passwords, list accounts",
  usage: "user <create|reset-password|list> ...",
  subcommands: { create, "reset-password": resetPassword, list },
};
