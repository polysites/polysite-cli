// Run by `polysite user|site ...` inside the CMS container, through Payload's local API:
//   npx payload run .next/polysite-cli-ops.mts   (JSON request on stdin)
// It prints one line, POLYSITE_CLI_RESULT:<json> or POLYSITE_CLI_ERROR:<message>, which the CLI parses; everything else
// on stdout (Payload's own logging) is ignored. Passwords arrive on stdin, never on a command line or in the environment,
// and are never printed.
import { createLocalReq, getPayload } from "payload";

import config from "../src/payload.config";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const done = (code: number, line: string) => {
  process.stdout.write(`\n${line}\n`, () => process.exit(code));
};

try {
  const req = JSON.parse(await readStdin());
  const payload: any = await getPayload({ config });
  const lowered = (s: string) => String(s).trim().toLowerCase();

  const findRole = async (name: string) => {
    const roles = await payload.find({ collection: "roles", limit: 100, depth: 0, overrideAccess: true });
    const hit = roles.docs.find((r: any) => lowered(r.name) === lowered(name));
    if (!hit) throw new Error(`No role named "${name}". Roles: ${roles.docs.map((r: any) => r.name).join(", ")}`);
    return hit;
  };
  const findSite = async (ref: string) => {
    const sites = await payload.find({ collection: "sites", limit: 500, depth: 0, overrideAccess: true });
    const hit = sites.docs.find((s: any) => String(s.id) === String(ref) || lowered(s.domain) === lowered(ref));
    if (!hit) throw new Error(`No site "${ref}". Sites: ${sites.docs.map((s: any) => s.domain).join(", ")}`);
    return hit;
  };
  const findUser = async (email: string) => {
    const r = await payload.find({ collection: "users", where: { email: { equals: lowered(email) } }, limit: 1, depth: 0, overrideAccess: true });
    return r.docs[0] ?? null;
  };

  let result: unknown;
  switch (req.action) {
    case "users.list": {
      const r = await payload.find({ collection: "users", limit: 500, depth: 1, sort: "email", overrideAccess: true });
      result = {
        users: r.docs.map((u: any) => ({
          id: u.id,
          email: u.email,
          role: typeof u.role === "object" ? u.role?.name : u.role ?? null,
          superAdmin: Boolean(u.isSuperAdmin),
          sites: (u.assignedSites ?? []).map((a: any) => (typeof a.site === "object" ? a.site?.domain : a.site)),
          locked: Boolean(u.lockUntil && new Date(u.lockUntil) > new Date()),
          createdAt: u.createdAt,
        })),
        total: r.totalDocs,
      };
      break;
    }
    case "users.create": {
      if (await findUser(req.email)) throw new Error(`A user with the email ${req.email} already exists.`);
      const role = await findRole(req.role ?? (req.superAdmin ? "Super Admin" : "Site User"));
      const sites = [];
      for (const ref of req.sites ?? []) sites.push({ site: (await findSite(ref)).id });
      // The first account on a server that uses a setup token is normally made on the setup page; whoever can run this
      // command already controls the server, so it is allowed the same step.
      const local = await createLocalReq({ context: { polysiteSetup: true } }, payload);
      const user = await payload.create({
        collection: "users",
        data: { email: lowered(req.email), password: req.password, role: role.id, isSuperAdmin: Boolean(req.superAdmin), ...(sites.length ? { assignedSites: sites } : {}) },
        overrideAccess: true,
        req: local,
      });
      result = { id: user.id, email: user.email, role: role.name, superAdmin: Boolean(user.isSuperAdmin) };
      break;
    }
    case "users.resetPassword": {
      const user = await findUser(req.email);
      if (!user) throw new Error(`No user with the email ${req.email}.`);
      await payload.update({ collection: "users", id: user.id, data: { password: req.password }, overrideAccess: true });
      let unlocked = false;
      try {
        await payload.unlock({ collection: "users", data: { email: user.email }, overrideAccess: true });
        unlocked = true;
      } catch {
        /* not locked, or unlocking is not available: the new password is set either way */
      }
      result = { id: user.id, email: user.email, unlocked };
      break;
    }
    case "sites.list": {
      const r = await payload.find({ collection: "sites", limit: 500, depth: 0, sort: "id", overrideAccess: true });
      result = { sites: r.docs.map((s: any) => ({ id: s.id, name: s.name, domain: s.domain, theme: s.theme, modules: s.enabledModules ?? [] })) };
      break;
    }
    case "sites.create": {
      const existing = await payload.find({ collection: "sites", where: { domain: { equals: lowered(req.domain) } }, limit: 1, depth: 0, overrideAccess: true });
      if (existing.docs.length) throw new Error(`A site with the domain ${req.domain} already exists.`);
      const site = await payload.create({
        collection: "sites",
        data: { name: req.name, domain: lowered(req.domain), ...(req.theme ? { theme: req.theme } : {}), showDonateButton: false },
        overrideAccess: true,
      });
      result = { id: site.id, name: site.name, domain: site.domain, theme: site.theme };
      break;
    }
    default:
      throw new Error(`Unknown action ${req.action}`);
  }
  done(0, `POLYSITE_CLI_RESULT:${JSON.stringify(result)}`);
} catch (e: any) {
  done(1, `POLYSITE_CLI_ERROR:${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 500)}`);
}
