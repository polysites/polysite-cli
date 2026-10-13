import { createInterface } from "node:readline";
import { Writable } from "node:stream";

import { EXIT } from "./constants.js";
import { CliError } from "./errors.js";

// Prompts with no dependency. One readline over stdin, consumed line by line, so piped input (scripts, tests) and a
// terminal behave the same. Secret answers are not echoed.
export function createPrompter({ stdin = process.stdin, stdout = process.stderr } = {}) {
  let muted = false;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) stdout.write(chunk);
      cb();
    },
  });
  let iterator = null;
  let rl = null;
  const lines = () => {
    if (!iterator) {
      rl = createInterface({ input: stdin, output: sink, terminal: Boolean(stdin.isTTY) });
      iterator = rl[Symbol.asyncIterator]();
    }
    return iterator;
  };
  const interactive = Boolean(stdin.isTTY);

  async function read(question, { secret = false } = {}) {
    stdout.write(question);
    muted = secret;
    const { value, done } = await lines().next();
    muted = false;
    if (secret && interactive) stdout.write("\n");
    if (done) throw new CliError("No input is available to answer the question above.", { code: EXIT.REFUSED, hint: "Pass the value as an option instead." });
    return value;
  }

  return {
    interactive,
    async ask(question, { default: def, secret = false, validate } = {}) {
      for (;;) {
        const raw = await read(def !== undefined && !secret ? `${question} [${def}]: ` : `${question}: `, { secret });
        const value = raw.trim() === "" && def !== undefined ? def : raw.trim();
        const problem = validate ? validate(value) : null;
        if (!problem) return value;
        stdout.write(`${problem}\n`);
        if (!interactive) throw new CliError(problem, { code: EXIT.USAGE });
      }
    },
    /** Reads a password twice. */
    async askPassword(question = "Password") {
      const a = await read(`${question}: `, { secret: true });
      const b = await read(`${question} (again): `, { secret: true });
      if (a !== b) throw new CliError("The two passwords differ.", { code: EXIT.USAGE });
      return a;
    },
    async yesNo(question, def = false) {
      const raw = (await read(`${question} [${def ? "Y/n" : "y/N"}]: `)).trim().toLowerCase();
      return raw === "" ? def : raw === "y" || raw === "yes";
    },
    /** The caller types back exactly `expected`. Anything else cancels. */
    async typeToConfirm(message, expected) {
      stdout.write(`${message}\n`);
      const got = (await read(`Type "${expected}" to continue: `)).trim();
      return got === expected;
    },
    close() { rl?.close(); },
  };
}
