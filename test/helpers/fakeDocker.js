// A stand-in `docker` program put first on PATH. It records every call (arguments and, for -T calls, stdin) and answers
// from a list of rules, so a test can assert the exact commands the CLI runs without any Docker daemon or network.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const SCRIPT = `#!/usr/bin/env node
const fs = require("fs");
const dir = __dirname;
const args = process.argv.slice(2);
let input = "";
if (args.includes("-T")) { try { input = fs.readFileSync(0, "utf8"); } catch {} }
const joined = args.join(" ");
const rules = JSON.parse(fs.readFileSync(dir + "/rules.json", "utf8"));
const statePath = dir + "/state.json";
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
let answer = { stdout: "", stderr: "", code: 0 };
for (let i = 0; i < rules.length; i++) {
  const r = rules[i];
  if (!new RegExp(r.match).test(joined)) continue;
  if (r.inputMatch && !new RegExp(r.inputMatch).test(input)) continue;
  if (r.responses) {
    const n = state["r" + i] || 0;
    state["r" + i] = n + 1;
    answer = { ...answer, ...r.responses[Math.min(n, r.responses.length - 1)] };
  } else answer = { ...answer, ...r };
  break;
}
fs.writeFileSync(statePath, JSON.stringify(state));
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify({ args, input }) + "\\n");
process.stdout.write(answer.stdout || "");
process.stderr.write(answer.stderr || "");
process.exit(answer.code || 0);
`;

export function createFakeDocker(rules = []) {
  const dir = mkdtempSync(join(tmpdir(), "polysite-fake-docker-"));
  writeFileSync(join(dir, "docker"), SCRIPT, { mode: 0o755 });
  chmodSync(join(dir, "docker"), 0o755);
  writeFileSync(join(dir, "docker.cmd"), `@echo off\r\nnode "%~dp0docker" %*\r\n`);
  writeFileSync(join(dir, "rules.json"), JSON.stringify(rules));
  writeFileSync(join(dir, "calls.jsonl"), "");
  return {
    dir,
    pathWith: (path = process.env.PATH) => `${dir}${delimiter}${path}`,
    /** Replace the rules (later calls see the new answers). */
    setRules(next) { writeFileSync(join(dir, "rules.json"), JSON.stringify(next)); },
    /** Every call so far: { args, input, line } where `line` is the arguments after the compose flags, joined. */
    calls() {
      return readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => {
        const c = JSON.parse(l);
        return { ...c, line: simplify(c.args) };
      });
    },
    /** Just the simplified command lines. */
    lines() { return this.calls().map((c) => c.line); },
    clear() {
      writeFileSync(join(dir, "calls.jsonl"), "");
      if (existsSync(join(dir, "state.json"))) writeFileSync(join(dir, "state.json"), "{}");
    },
  };
}

/** `compose -p x --project-directory d --env-file e -f a -f b up -d` -> `up -d`; other commands unchanged. */
export function simplify(args) {
  if (args[0] !== "compose") return args.join(" ");
  let i = 1;
  while (i < args.length) {
    const a = args[i];
    if (["-p", "--project-directory", "--env-file", "-f"].includes(a)) i += 2;
    else break;
  }
  return args.slice(i).join(" ");
}

/** Rules describing a healthy production stack running `version`. */
export function healthyStack({ version = "0.1.0", services = ["caddy", "web", "cms", "db", "redis", "backup", "restore"] } = {}) {
  const running = ["caddy", "web", "cms", "db", "redis", "backup"];
  const rules = [
    { match: "^compose .*config --services$", stdout: `${services.join("\n")}\n` },
    { match: "^compose .*config -q", stdout: "" },
    { match: "^version --format", stdout: "27.0.0\n" },
    { match: "^compose version --short", stdout: "2.29.0\n" },
    { match: "wget -q -O - http://127.0.0.1:3001/api/health", stdout: JSON.stringify({ status: "ok", version }) },
    { match: "wget -q -O - http://127.0.0.1:3000/api/health", stdout: JSON.stringify({ status: "ok", version }) },
  ];
  for (const s of running) {
    rules.push({ match: ` ps -q ${s}$`, stdout: `id-${s}\n` });
    const labelled = ["cms", "web", "backup"].includes(s) ? version : "";
    rules.push({ match: `^inspect --format .* id-${s}$`, stdout: `running|${["db", "cms", "web", "backup"].includes(s) ? "healthy" : ""}|img-${s}:v${version}|${labelled}|sha256:${s}\n` });
  }
  return rules;
}
