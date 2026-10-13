import { GLOBAL_OPTIONS } from "./context.js";
import { CLI_VERSION } from "./constants.js";

const pad = (s, n) => s.padEnd(n);

function optionLines(options) {
  const entries = Object.entries(options);
  const labels = entries.map(([name, o]) => `${o.short ? `-${o.short}, ` : "    "}--${name}${o.type === "string" ? ` <${o.placeholder ?? "value"}>` : ""}`);
  const width = Math.max(0, ...labels.map((l) => l.length));
  return entries.map(([, o], i) => `  ${pad(labels[i], width)}  ${o.description ?? ""}`);
}

export function renderTopHelp(commands) {
  const names = Object.keys(commands);
  const width = Math.max(...names.map((n) => n.length));
  return [
    `polysite ${CLI_VERSION}: install, run, back up and upgrade a Polysite CMS`,
    "",
    "Usage: polysite <command> [options]      (also: polysites, poly)",
    "",
    "Commands:",
    ...names.map((n) => `  ${pad(n, width)}  ${commands[n].summary}`),
    "",
    "Run `polysite <command> --help` for a command's options, or `polysite help <command>`.",
    "Options every command accepts:",
    ...optionLines(GLOBAL_OPTIONS),
    "",
    "Exit codes: 0 ok, 1 failed, 2 wrong usage, 3 a check reported a problem, 4 refused or not confirmed,",
    "            5 upgrade failed and was rolled back, 6 upgrade failed and the rollback failed too.",
    "",
  ].join("\n");
}

export function renderHelp(path, cmd) {
  const lines = [`polysite ${path.join(" ")}: ${cmd.summary}`, ""];
  lines.push(`Usage: polysite ${cmd.usage ?? path.join(" ")}`, "");
  if (cmd.description) lines.push(cmd.description.trim(), "");
  if (cmd.subcommands) {
    const names = Object.keys(cmd.subcommands);
    const width = Math.max(...names.map((n) => n.length));
    lines.push("Subcommands:", ...names.map((n) => `  ${pad(n, width)}  ${cmd.subcommands[n].summary}`), "");
  }
  if (cmd.options && Object.keys(cmd.options).length) lines.push("Options:", ...optionLines(cmd.options), "");
  lines.push("Global options:", ...optionLines(GLOBAL_OPTIONS), "");
  if (cmd.examples?.length) lines.push("Examples:", ...cmd.examples.map((e) => `  ${e}`), "");
  return lines.join("\n");
}
