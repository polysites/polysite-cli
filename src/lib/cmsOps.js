import { readFileSync } from "node:fs";

import { CliError } from "./errors.js";
import { firstLine } from "./docker.js";

const SEPARATOR = "@@POLYSITE_REQUEST@@";
const SCRIPT = () => readFileSync(new URL("../../templates/cms-ops.ts", import.meta.url), "utf8");

// Written, run and deleted inside the container. The folder is Next's cache, which the image's unprivileged user can write
// (the rest of the app is read-only to it), and the script's relative imports resolve from there.
const SHELL = [
  "set -e",
  "f=.next/polysite-cli-ops.ts",
  "in=$(mktemp)",
  'trap \'rm -f "$f" "$in"\' EXIT',
  'cat > "$in"',
  `sed '/^${SEPARATOR}$/,$d' "$in" > "$f"`,
  `sed '1,/^${SEPARATOR}$/d' "$in" | npx payload run "$f"`,
].join("; ");

/**
 * Runs one of the CMS's data operations (create a user, list sites...) through Payload's local API inside the CMS container.
 * The request, including any password, travels on stdin only. Returns the operation's result object.
 */
export async function cmsOp(ctx, request) {
  const input = `${SCRIPT()}\n${SEPARATOR}\n${JSON.stringify(request)}\n`;
  const r = await ctx.docker().inCms(["sh", "-c", SHELL], { input, noDeps: false, timeoutMs: 180000 });
  const text = `${r.stdout}\n${r.stderr}`;
  const error = /POLYSITE_CLI_ERROR:(.*)/.exec(text);
  if (error) throw new CliError(error[1].trim());
  const ok = /POLYSITE_CLI_RESULT:(.*)/.exec(r.stdout);
  if (!ok || r.code !== 0) {
    const why = firstLine(r.stderr) || firstLine(text.split(/\r?\n/).filter((l) => /error/i.test(l)).join("\n")) || `exit code ${r.code}`;
    throw new CliError(`The CMS could not run the operation: ${why}`, { hint: "Is the database up (`polysite status`)? Details: `polysite logs cms --tail 50`." });
  }
  return JSON.parse(ok[1]);
}
