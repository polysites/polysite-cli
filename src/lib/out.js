// Output. Human text goes to stdout; with --json it goes to stderr instead and stdout carries only the one JSON result,
// so a script can always parse stdout.
const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m" };

export function createOut({ json = false, color = false, quiet = false, stdout = process.stdout, stderr = process.stderr } = {}) {
  const paint = (name, s) => (color ? `${ANSI[name]}${s}${ANSI.reset}` : String(s));
  const human = json ? stderr : stdout;
  const write = (stream, s) => stream.write(s.endsWith("\n") ? s : `${s}\n`);
  return {
    json,
    color,
    paint,
    bold: (s) => paint("bold", s),
    dim: (s) => paint("dim", s),
    say: (s = "") => { if (!quiet) write(human, s); },
    ok: (s) => { if (!quiet) write(human, `${paint("green", "ok")}    ${s}`); },
    info: (s) => { if (!quiet) write(human, `${paint("cyan", "..")}    ${s}`); },
    warn: (s) => write(stderr, `${paint("yellow", "warn")}  ${s}`),
    fail: (s) => write(stderr, `${paint("red", "error")} ${s}`),
    hint: (s) => write(stderr, `      ${paint("dim", s)}`),
    step: (n, total, s) => { if (!quiet) write(human, `${paint("bold", `[${n}/${total}]`)} ${s}`); },
    dryRun: (s) => write(human, `${paint("yellow", "dry-run")} ${s}`),
    /** The machine-readable result. Printed only with --json. */
    result: (obj) => { if (json) stdout.write(`${JSON.stringify(obj, null, 2)}\n`); },
    table(rows, columns) {
      if (quiet) return;
      const widths = columns.map((c) => Math.max(c.header.length, ...rows.map((r) => String(r[c.key] ?? "").length)));
      const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join("  ").trimEnd();
      write(human, paint("bold", line(columns.map((c) => c.header))));
      for (const r of rows) write(human, line(columns.map((c) => r[c.key] ?? "")));
    },
  };
}
