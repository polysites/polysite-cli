import { EnvFile } from "./envfile.js";
import { createAudit } from "./audit.js";
import { createDocker } from "./docker.js";
import { createOut } from "./out.js";
import { createPrompter } from "./prompt.js";
import { resolveProject } from "./project.js";

/** Options every command accepts. */
export const GLOBAL_OPTIONS = {
  dir: { type: "string", short: "C", description: "The install folder (default: the current folder or the nearest one above it)" },
  env: { type: "string", description: "dev or prod: which compose files to use (default: from .polysite/config.json)" },
  project: { type: "string", short: "p", description: "Docker Compose project name" },
  "compose-file": { type: "string", multiple: true, description: "Compose file to use instead of the default (repeatable)" },
  "env-file": { type: "string", description: "The env file (default: .env)" },
  json: { type: "boolean", description: "Print one JSON result on stdout (progress goes to stderr)" },
  "dry-run": { type: "boolean", description: "Show what would change; change nothing" },
  yes: { type: "boolean", short: "y", description: "Answer yes to plain confirmations (typed confirmations still need --confirm)" },
  confirm: { type: "string", description: "The text a typed confirmation asks for, given up front (for scripts)" },
  quiet: { type: "boolean", short: "q", description: "Only errors and the final result" },
  "no-color": { type: "boolean", description: "No colours" },
  help: { type: "boolean", short: "h", description: "Show help" },
};

/**
 * What every command receives: the parsed global options plus lazy access to the install, its env file, Docker,
 * the audit log and prompts. Nothing here touches disk or Docker until a command asks.
 */
export function createContext({ values, io, env, cwd }) {
  const color = !values["no-color"] && !env.NO_COLOR && Boolean(io.stdout.isTTY);
  const out = createOut({ json: Boolean(values.json), color, quiet: Boolean(values.quiet), stdout: io.stdout, stderr: io.stderr });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ctx = {
    values,
    io,
    env,
    cwd,
    out,
    dryRun: Boolean(values["dry-run"]),
    yes: Boolean(values.yes),
    confirmText: values.confirm,
    pollMs: env.POLYSITE_POLL_MS !== undefined ? Number(env.POLYSITE_POLL_MS) : 3000,
    sleep,
    _prompter: null,
    _project: null,
    _docker: null,
    _audit: null,
    prompter() {
      return (ctx._prompter ??= createPrompter({ stdin: io.stdin, stdout: io.stderr }));
    },
    /** The install this command is about. Throws a usage error when there is none. */
    project() {
      return (ctx._project ??= resolveProject({
        dir: values.dir,
        env: values.env,
        project: values.project,
        composeFiles: values["compose-file"] ?? [],
        envFile: values["env-file"],
        cwd,
        environ: env,
      }));
    },
    /** The install's env file, read fresh each call (a command may have changed it). */
    envFile() {
      return EnvFile.read(ctx.project().envPath);
    },
    docker() {
      if (!ctx._docker) {
        const p = ctx.project();
        ctx._docker = createDocker({ root: p.root, files: p.files, project: p.project, envPath: p.envPath, dryRun: ctx.dryRun, out, env, sleep });
      }
      return ctx._docker;
    },
    audit(event, fields) {
      ctx._audit ??= createAudit(ctx.project().root, { dryRun: ctx.dryRun });
      return ctx._audit.write(event, fields);
    },
    /** Docker with no install behind it (for `doctor` before anything exists, and `version`). */
    bareDocker() {
      return createDocker({ root: cwd, files: [], dryRun: false, out, env, sleep });
    },
    close() {
      ctx._prompter?.close();
    },
  };
  return ctx;
}
