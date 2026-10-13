import { EXIT, CLI_VERSION } from "../lib/constants.js";
import { findRoot } from "../lib/project.js";

export default {
  name: "version",
  summary: "Show the CLI version and the release this install runs",
  usage: "version [--json]",
  async run(ctx) {
    const { out } = ctx;
    const info = { cli: CLI_VERSION, node: process.versions.node, install: null, release: null, running: {} };
    const root = findRoot(ctx.values.dir ?? ctx.cwd);
    if (root) {
      try {
        const project = ctx.project();
        info.install = project.root;
        info.release = ctx.envFile().get("POLYSITE_VERSION") ?? null;
        const docker = ctx.docker();
        for (const svc of ["cms", "web"]) {
          const s = await docker.inspect(svc).catch(() => null);
          if (s?.status === "running") info.running[svc] = s.version ?? (await docker.appHealth(svc))?.version ?? null;
        }
      } catch { /* no usable install here: report the CLI alone */ }
    }
    out.say(`polysite ${info.cli} (node ${info.node})`);
    if (info.install) {
      out.say(`install  ${info.install}`);
      out.say(`release  ${info.release ?? "not set (a source checkout builds its own images)"}`);
      for (const [svc, v] of Object.entries(info.running)) out.say(`running  ${svc} ${v ?? "unknown version"}`);
    } else out.say("No install found here.");
    out.result({ ok: true, ...info });
    return EXIT.OK;
  },
};
