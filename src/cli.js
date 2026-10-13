import { parseArgs } from "node:util";

import { commands } from "./commands/index.js";
import { CLI_VERSION, EXIT } from "./lib/constants.js";
import { createContext, GLOBAL_OPTIONS } from "./lib/context.js";
import { CliError } from "./lib/errors.js";
import { renderHelp, renderTopHelp } from "./lib/help.js";
import { createOut } from "./lib/out.js";

const globalTakesValue = new Set(
  Object.entries(GLOBAL_OPTIONS).filter(([, o]) => o.type === "string").flatMap(([name, o]) => [`--${name}`, ...(o.short ? [`-${o.short}`] : [])]),
);

/** Splits argv into the command words (`plugin list`) and everything else, skipping global options that sit before them. */
function takeWord(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") return null;
    if (a.startsWith("-")) {
      if (globalTakesValue.has(a)) i++;
      continue;
    }
    return { word: a, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
  }
  return null;
}

/**
 * Runs the CLI. Returns the exit code instead of exiting, so tests can call it in process.
 *   argv: the arguments after the program name
 */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, env = process.env, cwd = process.cwd() } = {}) {
  const io = { stdout, stderr, stdin };
  let ctx;
  let out = createOut({ stdout, stderr, json: argv.includes("--json") });
  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      stdout.write(renderTopHelp(commands));
      return EXIT.OK;
    }
    if (argv[0] === "--version" || argv[0] === "-v") {
      stdout.write(`${CLI_VERSION}\n`);
      return EXIT.OK;
    }
    if (argv[0] === "help") {
      const target = resolve(commands, argv.slice(1));
      stdout.write(target ? renderHelp(target.path, target.cmd) : renderTopHelp(commands));
      return EXIT.OK;
    }

    // Find the command (and subcommand) words, then parse everything with that command's own options added.
    let rest = argv;
    const path = [];
    let cmd = null;
    let table = commands;
    for (;;) {
      const t = takeWord(rest);
      if (!t || !table[t.word]) {
        if (!cmd && t) throw new CliError(`Unknown command "${t.word}".`, { code: EXIT.USAGE, hint: "Run `polysite --help` for the list." });
        break;
      }
      cmd = table[t.word];
      path.push(t.word);
      rest = t.rest;
      if (!cmd.subcommands) break;
      table = cmd.subcommands;
      // A command with subcommands but no word for one: show its help (below) or run its own default.
    }
    if (!cmd) throw new CliError("No command given.", { code: EXIT.USAGE, hint: "Run `polysite --help`." });

    const options = { ...GLOBAL_OPTIONS, ...(cmd.options ?? {}) };
    const parsed = parseArgs({
      args: rest,
      options: Object.fromEntries(Object.entries(options).map(([k, o]) => [k, { type: o.type, ...(o.short ? { short: o.short } : {}), ...(o.multiple ? { multiple: true } : {}) }])),
      allowPositionals: true,
      strict: true,
    });
    out = createOut({ stdout, stderr, json: Boolean(parsed.values.json) });

    if (parsed.values.help || (cmd.subcommands && !cmd.run)) {
      stdout.write(renderHelp(path, cmd));
      return cmd.subcommands && !cmd.run && !parsed.values.help ? EXIT.USAGE : EXIT.OK;
    }
    if (cmd.positionals?.min !== undefined && parsed.positionals.length < cmd.positionals.min) {
      throw new CliError(`Missing ${cmd.positionals.name ?? "argument"}.`, { code: EXIT.USAGE, hint: `Usage: polysite ${cmd.usage ?? path.join(" ")}` });
    }
    if (cmd.positionals?.max !== undefined && parsed.positionals.length > cmd.positionals.max) {
      throw new CliError(`Too many arguments: ${parsed.positionals.slice(cmd.positionals.max).join(" ")}`, { code: EXIT.USAGE, hint: `Usage: polysite ${cmd.usage ?? path.join(" ")}` });
    }

    ctx = createContext({ values: parsed.values, io, env, cwd });
    out = ctx.out;
    const code = await cmd.run(ctx, { values: parsed.values, positionals: parsed.positionals, path });
    return typeof code === "number" ? code : EXIT.OK;
  } catch (e) {
    if (e instanceof CliError) {
      out.fail(e.message);
      if (e.hint) out.hint(e.hint);
      if (out.json) out.result({ ok: false, error: e.message, hint: e.hint ?? undefined, exitCode: e.code, ...(e.data ?? {}) });
      return e.code;
    }
    if (e?.code?.startsWith?.("ERR_PARSE_ARGS")) {
      out.fail(e.message.split("\n")[0]);
      out.hint("Run the command with --help to see its options.");
      return EXIT.USAGE;
    }
    out.fail(`Unexpected error: ${e?.stack ?? e}`);
    return EXIT.FAILED;
  } finally {
    ctx?.close();
  }
}

function resolve(table, words) {
  let cmd = null;
  const path = [];
  let t = table;
  for (const w of words) {
    if (!t[w]) break;
    cmd = t[w];
    path.push(w);
    if (!cmd.subcommands) break;
    t = cmd.subcommands;
  }
  return cmd ? { cmd, path } : null;
}
