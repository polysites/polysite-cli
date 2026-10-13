import { EXIT, SERVICES } from "../lib/constants.js";
import { CliError, usageError } from "../lib/errors.js";
import { confirmTyped } from "../lib/confirm.js";
import { mustSucceed } from "../lib/docker.js";

function checkServices(list, known) {
  const unknown = list.filter((s) => !known.includes(s));
  if (unknown.length) throw usageError(`Unknown service: ${unknown.join(", ")}.`, `Services in this install: ${known.join(", ")}`);
}

function requireVersion(ctx) {
  const { mode } = ctx.project();
  if (mode !== "prod") return;
  const env = ctx.envFile();
  if (!env.get("POLYSITE_VERSION") && !ctx.env.POLYSITE_VERSION && !env.get("POLYSITE_CMS_IMAGE")) {
    throw new CliError("POLYSITE_VERSION is not set in the env file, so compose does not know which release to run.", {
      hint: "Add POLYSITE_VERSION=<x.y.z> to .env, or run `polysite upgrade --to <x.y.z>`.",
    });
  }
}

export const up = {
  name: "up",
  summary: "Start the stack (or some services)",
  usage: "up [service...] [--build] [--no-wait]",
  description: "Runs `docker compose up -d` for the chosen environment, then waits until the CMS and the site report healthy.",
  options: {
    build: { type: "boolean", description: "Build images first (dev checkouts)" },
    "no-wait": { type: "boolean", description: "Do not wait for the services to become healthy" },
    "timeout": { type: "string", placeholder: "seconds", description: "How long to wait for health (default 300)" },
  },
  async run(ctx, { values, positionals }) {
    const docker = ctx.docker();
    requireVersion(ctx);
    checkServices(positionals, await docker.services());
    const r = await docker.mutate(["up", "-d", ...(values.build ? ["--build"] : []), ...positionals], { stream: true });
    if (r.code !== 0) throw new CliError("docker compose up failed.", { hint: "Run `polysite logs` and `polysite doctor`." });
    if (ctx.dryRun) return EXIT.OK;
    const states = {};
    if (!values["no-wait"]) {
      const targets = (positionals.length ? positionals : ["cms", "web"]).filter((s) => ["cms", "web"].includes(s));
      for (const s of targets) {
        ctx.out.info(`Waiting for ${s} to be healthy...`);
        const w = await docker.waitReady(s, { timeoutSec: Number(values.timeout ?? 300), pollMs: ctx.pollMs });
        states[s] = w.state;
        if (!w.ok) throw new CliError(`${s} is ${w.state}.`, { hint: `polysite logs ${s} --tail 50` });
      }
    }
    ctx.out.ok("The stack is up.");
    ctx.out.result({ ok: true, services: states });
    return EXIT.OK;
  },
};

export const down = {
  name: "down",
  summary: "Stop and remove the containers (data volumes are kept)",
  usage: "down [--volumes --confirm <project>]",
  description: `
Stops the stack and removes its containers and network. Your data (database, uploads, certificates) lives in Docker
volumes and is kept. --volumes also deletes those volumes: that destroys the database and needs a typed confirmation
of the project name.`,
  options: { volumes: { type: "boolean", description: "Also delete the data volumes (destroys the database and uploads)" } },
  async run(ctx, { values }) {
    const docker = ctx.docker();
    const project = ctx.project();
    if (values.volumes) {
      const name = project.project ?? project.config.project ?? "polysite";
      if (!ctx.dryRun) await confirmTyped(ctx, `This deletes the data volumes of "${name}": the database, uploads and certificates. Take a backup first (polysite backup).`, name);
      ctx.audit("down-volumes", { project: name });
    }
    const r = await docker.mutate(["down", ...(values.volumes ? ["--volumes"] : [])], { stream: true });
    if (r.code !== 0) throw new CliError("docker compose down failed.");
    ctx.out.ok(values.volumes ? "Stopped; data volumes deleted." : "Stopped. Data volumes are kept.");
    ctx.out.result({ ok: true, volumesDeleted: Boolean(values.volumes) && !ctx.dryRun });
    return EXIT.OK;
  },
};

export const restart = {
  name: "restart",
  summary: "Restart the stack or some services",
  usage: "restart [service...]",
  async run(ctx, { positionals }) {
    const docker = ctx.docker();
    checkServices(positionals, await docker.services());
    const r = await docker.mutate(["restart", ...positionals], { stream: true });
    if (r.code !== 0) throw new CliError("docker compose restart failed.");
    ctx.out.ok("Restarted.");
    ctx.out.result({ ok: true });
    return EXIT.OK;
  },
};

export const logs = {
  name: "logs",
  summary: "Show service logs",
  usage: "logs [service] [--tail N] [--follow] [--since 10m]",
  positionals: { max: 1 },
  options: {
    tail: { type: "string", placeholder: "N", description: "Lines per service (default 100)" },
    follow: { type: "boolean", short: "f", description: "Keep printing new lines" },
    since: { type: "string", placeholder: "duration", description: "Only logs newer than this, such as 10m or 2h" },
  },
  async run(ctx, { values, positionals }) {
    const docker = ctx.docker();
    checkServices(positionals, await docker.services());
    const tail = values.tail ?? "100";
    if (!/^\d+$|^all$/.test(tail)) throw usageError("--tail must be a number or all.");
    const args = ["logs", "--tail", tail, ...(values.follow ? ["--follow"] : []), ...(values.since ? ["--since", values.since] : []), ...positionals];
    const r = await docker.compose(args, { stream: true });
    return r.code === 0 ? EXIT.OK : EXIT.FAILED;
  },
};

export const status = {
  name: "status",
  summary: "Show what is running and whether it is healthy",
  usage: "status [--json]",
  async run(ctx) {
    const { out } = ctx;
    const docker = ctx.docker();
    const project = ctx.project();
    mustSucceed(await docker.compose(["config", "-q"]), "Reading the compose files");
    const names = await docker.services();
    const rows = [];
    for (const name of SERVICES.filter((s) => names.includes(s)).concat(names.filter((n) => !SERVICES.includes(n) && n !== "restore"))) {
      const s = await docker.inspect(name);
      rows.push({ service: name, state: s ? s.status : "not running", health: s?.health ?? "-", version: s?.version ?? "-", image: s?.image ?? "-" });
    }
    const app = {};
    for (const svc of ["cms", "web"]) {
      const row = rows.find((r) => r.service === svc);
      if (row?.state === "running") app[svc] = await docker.appHealth(svc);
    }
    const env = ctx.envFile();
    const unhealthy = rows.filter((r) => r.service !== "restore" && (r.state !== "running" || r.health === "unhealthy"));
    out.say(`Install ${project.root} (${project.mode})${env.get("POLYSITE_VERSION") ? `, release ${env.get("POLYSITE_VERSION")}` : ""}`);
    out.table(rows, [{ key: "service", header: "SERVICE" }, { key: "state", header: "STATE" }, { key: "health", header: "HEALTH" }, { key: "version", header: "VERSION" }]);
    out.result({ ok: unhealthy.length === 0, root: project.root, mode: project.mode, release: env.get("POLYSITE_VERSION") ?? null, services: rows, app });
    return unhealthy.length ? EXIT.CHECK_FAILED : EXIT.OK;
  },
};
