import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { main } from "../../src/cli.js";

/**
 * Runs the CLI in process and returns { code, stdout, stderr }.
 *   fake   a createFakeDocker() result (its folder goes first on PATH)
 *   stdin  text the program can read (answers to prompts, a password)
 */
export async function runCli(argv, { cwd = process.cwd(), env = {}, fake, stdin = "" } = {}) {
  const out = new PassThrough();
  const err = new PassThrough();
  const input = new PassThrough();
  let stdout = "";
  let stderr = "";
  out.on("data", (d) => { stdout += d; });
  err.on("data", (d) => { stderr += d; });
  input.end(stdin);
  const fullEnv = { ...process.env, POLYSITE_POLL_MS: "0", NO_COLOR: "1", ...env };
  if (fake) fullEnv.PATH = fake.pathWith(process.env.PATH);
  const savedPath = process.env.PATH;
  if (fake) process.env.PATH = fullEnv.PATH;
  try {
    const code = await main(argv, { stdout: out, stderr: err, stdin: input, env: fullEnv, cwd });
    return { code, stdout, stderr, json: () => JSON.parse(stdout) };
  } finally {
    process.env.PATH = savedPath;
  }
}

/** A production install folder as `polysite init` writes it, without involving the init command. */
export function makeInstall({ version = "0.1.0", env = {}, mode = "prod" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "polysite-install-"));
  writeFileSync(join(dir, "docker-compose.prod.yml"), "name: polysite-test\nservices:\n  cms: {}\n");
  const vars = {
    POLYSITE_VERSION: version,
    POLYSITE_REGISTRY: "example.test/polysite",
    SITE_DOMAIN: "example.test",
    SITE_SCHEME: "https",
    CMS_DOMAIN: "admin.example.test",
    CMS_SCHEME: "https",
    DATABASE_URL: "postgres://polysite:Zq8vLm2Xr4Tn7Hb9Kd3Wf6Jc@db:5432/polysite",
    POSTGRES_PASSWORD: "Zq8vLm2Xr4Tn7Hb9Kd3Wf6Jc",
    PAYLOAD_SECRET: "q7R2mV9xKp4Lc8Zt1Ng6Yb3Hd5Fw0JaSe_u-AoXi",
    NUXT_REVALIDATE_SECRET: "e3T8wQ1zUo5Pn7Rk2Mx9Cv4Bh6Ls0DyGj-fAaIt",
    REVALIDATE_SECRET: "e3T8wQ1zUo5Pn7Rk2Mx9Cv4Bh6Ls0DyGj-fAaIt",
    POLYSITE_SETUP_TOKEN: "n4Y7bK2xP9sL5vC8dH1gQ3wE6rT0uZjM",
    NUXT_REVALIDATE_URL: "http://web:3000/api/revalidate",
    NUXT_API_BASE_INTERNAL: "http://cms:3001/api",
    REDIS_URL: "redis://redis:6379",
    BACKUP_HOST_DIR: "./backups",
    BACKUP_ENCRYPTION_PASSPHRASE: "p9X3kT7mQ2vL5nB8cR1wZ4yH6dF0gJsA",
    BACKUP_RCLONE_REMOTE: "offsite:bucket/polysite",
    ...env,
  };
  writeFileSync(join(dir, ".env"), `# test env\n${Object.entries(vars).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`).join("\n")}\n`, { mode: 0o600 });
  mkdirSync(join(dir, "backups"), { recursive: true });
  mkdirSync(join(dir, ".polysite"), { recursive: true });
  writeFileSync(join(dir, ".polysite", "config.json"), JSON.stringify({ mode, composeFiles: ["docker-compose.prod.yml"], project: "polysite-test" }));
  return dir;
}

export const readEnv = (dir) => readFileSync(join(dir, ".env"), "utf8");
export const readAudit = (dir) => (existsSync(join(dir, ".polysite", "audit.log")) ? readFileSync(join(dir, ".polysite", "audit.log"), "utf8") : "");
