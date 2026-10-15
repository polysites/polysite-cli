import { existsSync } from "node:fs";

import { EXIT } from "./constants.js";
import { CliError } from "./errors.js";
import { run } from "./exec.js";

const HEALTH_PORT = { cms: 3001, web: 3000 };

/**
 * Everything the CLI asks of Docker goes through here, so there is one place that decides how a compose command is
 * built (project name, env file, compose files) and one place that honours --dry-run.
 */
export function createDocker({ root, files = [], project = null, envPath = null, dryRun = false, out, env = {}, sleep }) {
  const base = () => [
    "compose",
    ...(project ? ["-p", project] : []),
    "--project-directory", root,
    ...(envPath && existsSync(envPath) ? ["--env-file", envPath] : []),
    ...files.flatMap((f) => ["-f", f]),
  ];
  const opts = (o = {}) => ({ cwd: root, env: { ...env, ...o.env }, input: o.input, stream: o.stream, timeoutMs: o.timeoutMs });

  const dry = (what) => {
    out?.dryRun(what);
    return { code: 0, stdout: "", stderr: "", dry: true };
  };

  const api = {
    /** `docker <args>` (no compose). */
    raw: (args, o) => run("docker", args, opts(o)),
    /** `docker compose ... <args>`. Read-only use: it runs even under --dry-run. */
    compose: (args, o) => run("docker", [...base(), ...args], opts(o)),
    /** The same, for a command that changes something: under --dry-run it is only announced. */
    async mutate(args, o) {
      if (dryRun) {
        out?.dryRun(`docker ${[...base(), ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
        return { code: 0, stdout: "", stderr: "", dry: true };
      }
      return api.compose(args, o);
    },
    base,

    async version() {
      const r = await api.raw(["version", "--format", "{{.Server.Version}}"]);
      return r.code === 0 ? r.stdout.trim() : null;
    },
    async composeVersion() {
      const r = await api.raw(["compose", "version", "--short"]);
      return r.code === 0 ? r.stdout.trim().replace(/^v/, "") : null;
    },

    /** `allProfiles` also lists profile-gated services such as `restore`, which `config --services` leaves out by default. */
    async services(allProfiles = false) {
      const r = await api.compose(allProfiles ? ["--profile", "*", "config", "--services"] : ["config", "--services"]);
      if (r.code !== 0) throw new CliError(`docker compose could not read the compose files: ${firstLine(r.stderr)}`, { hint: "Run `polysite doctor`." });
      return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    },

    async containerId(service) {
      const r = await api.compose(["ps", "-q", service]);
      return r.code === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null : null;
    },

    /** { service, id, status, health, image, version } for the service's container, or null when there is none. */
    async inspect(service) {
      const id = await api.containerId(service);
      if (!id) return null;
      const fmt = '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.Config.Image}}|{{index .Config.Labels "org.opencontainers.image.version"}}|{{.Image}}';
      const r = await api.raw(["inspect", "--format", fmt, id]);
      if (r.code !== 0) return null;
      const [status, health, image, version, imageId] = r.stdout.trim().split("|");
      return { service, id, status, health: health || null, image, version: version || null, imageId };
    },

    async isRunning(service) {
      const s = await api.inspect(service);
      return Boolean(s && s.status === "running");
    },

    /** The app's own /api/health answer, asked from inside its container (so no published port is needed). */
    async appHealth(service) {
      const port = HEALTH_PORT[service];
      if (!port) return null;
      const r = await api.compose(["exec", "-T", service, "wget", "-q", "-O", "-", `http://127.0.0.1:${port}/api/health`], { timeoutMs: 20000 });
      if (r.code !== 0) return null;
      try {
        return JSON.parse(r.stdout);
      } catch {
        return null;
      }
    },

    /**
     * Waits until the service is healthy (or, without a health check, running steadily). Returns { ok, state }.
     * Gives up at once on exited/unhealthy/restarting.
     */
    async waitReady(service, { timeoutSec = 300, pollMs = 3000 } = {}) {
      const deadline = Date.now() + timeoutSec * 1000;
      let steady = 0;
      let state = "missing";
      do {
        const s = await api.inspect(service);
        state = !s ? "missing" : s.status !== "running" ? s.status : s.health || "running";
        if (state === "healthy") return { ok: true, state };
        if (["unhealthy", "exited", "dead", "restarting"].includes(state)) return { ok: false, state };
        if (state === "running") {
          steady += 1;
          if (steady >= 3) return { ok: true, state };
        }
        await sleep(pollMs);
      } while (Date.now() < deadline);
      return { ok: false, state };
    },

    /** Runs a program in the CMS: in the running container when there is one, else in a one-off container. */
    async inCms(args, { noDeps = true, mounts = [], mutating = false, ...o } = {}) {
      if (dryRun && mutating) return dry(`in the CMS: ${args.join(" ")}`);
      if (!dryRun && (await api.isRunning("cms")) && !mounts.length) return api.compose(["exec", "-T", "cms", ...args], o);
      const mountArgs = mounts.flatMap((m) => ["-v", m]);
      return api.compose(["run", "--rm", "-T", ...(noDeps ? ["--no-deps"] : []), ...mountArgs, "cms", ...args], o);
    },

    /** Runs a script from the backup tooling (backup/) in the backup service. */
    async inBackup(script, args = [], o = {}) {
      if (dryRun && o.mutating) return dry(`in the backup service: ${script} ${args.join(" ")}`);
      const path = `/opt/backup/${script}`;
      if (await api.isRunning("backup")) return api.compose(["exec", "-T", "backup", path, ...args], o);
      return api.compose(["run", "--rm", "-T", "--entrypoint", path, "backup", ...args], o);
    },

    /** Runs SQL through psql in the backup service (it has the client and DATABASE_URL). Read-only unless `write`. */
    async psql(sql, { write = false, tuples = true } = {}) {
      if (dryRun && write) return dry(`SQL in the database:
${sql}`);
      const flags = ["-X", "-v", "ON_ERROR_STOP=1", ...(tuples ? ["-At", "-F", "'|'"] : []), ...(write ? ["--single-transaction"] : [])].join(" ");
      const script = `psql "$DATABASE_URL" ${flags}`;
      const args = ["sh", "-c", script];
      const o = { input: sql };
      if (await api.isRunning("backup")) return api.compose(["exec", "-T", "backup", ...args], o);
      return api.compose(["run", "--rm", "-T", "--entrypoint", "sh", "backup", "-c", script], o);
    },
  };
  return api;
}

export const firstLine = (s) => String(s ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";

/** Turns a failed result into an error with the tool's own message. */
export function mustSucceed(result, what) {
  if (result.code === 0) return result;
  const detail = firstLine(result.stderr) || firstLine(result.stdout) || `exit code ${result.code}`;
  const missing = result.code === 127 ? " Is Docker installed and on the PATH?" : "";
  throw new CliError(`${what} failed: ${detail}.${missing}`, { code: EXIT.FAILED });
}
