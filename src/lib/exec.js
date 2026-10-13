import { spawn } from "node:child_process";

/**
 * Runs a program without a shell (so no quoting surprises on any platform) and collects its output.
 *   input   text written to its stdin
 *   stream  true: pass its output straight through to ours (logs, long operations)
 */
export function run(cmd, args = [], { cwd, env, input, stream = false, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: [input !== undefined ? "pipe" : stream ? "inherit" : "ignore", stream ? "inherit" : "pipe", stream ? "inherit" : "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: String(e.message), error: e });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timer;
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    if (timeoutMs) timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: e.code === "ENOENT" ? 127 : 1, stdout, stderr: stderr || String(e.message), error: e });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}
