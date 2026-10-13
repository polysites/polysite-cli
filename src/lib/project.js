import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { EXIT } from "./constants.js";
import { CliError } from "./errors.js";

export const CONFIG_DIR = ".polysite";
export const CONFIG_FILE = "config.json";

const PROD_FILES = ["docker-compose.prod.yml"];
const DEV_FILES = ["docker-compose.yml", "docker-compose.dev.yml"];

/** Walks up from `start` to the folder that holds an install: a .polysite/config.json, or a compose file. */
export function findRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_DIR, CONFIG_FILE))) return dir;
    if (["docker-compose.prod.yml", "docker-compose.yml"].some((f) => existsSync(join(dir, f)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readConfig(root) {
  const file = join(root, CONFIG_DIR, CONFIG_FILE);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new CliError(`${file} is not valid JSON: ${e.message}`, { hint: "Fix or delete the file; `polysite init` writes it." });
  }
}

export function writeConfig(root, config) {
  mkdirSync(join(root, CONFIG_DIR), { recursive: true });
  writeFileSync(join(root, CONFIG_DIR, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Works out which install a command is about and how to talk to its Docker Compose project.
 * Precedence for each setting: command line, then POLYSITE_* environment, then .polysite/config.json, then a guess
 * from the files in the folder (a dev override file means a dev checkout; otherwise production).
 */
export function resolveProject({ dir, env = "", project, composeFiles = [], envFile, cwd, environ = process.env }) {
  const start = dir ?? environ.POLYSITE_DIR ?? cwd;
  const root = dir ? resolve(cwd, dir) : findRoot(resolve(cwd, start));
  if (!root || !existsSync(root)) {
    throw new CliError("No Polysite install found here.", {
      code: EXIT.USAGE,
      hint: "Run it from the install folder, pass --dir <folder>, or create one with `polysite init <folder>`.",
    });
  }
  const config = readConfig(root);
  const modeRaw = env || environ.POLYSITE_ENV || config.mode || (existsSync(join(root, "docker-compose.dev.yml")) && !existsSync(join(root, "docker-compose.prod.yml")) ? "dev" : "prod");
  if (!["dev", "prod"].includes(modeRaw)) throw new CliError(`Unknown environment "${modeRaw}" (use dev or prod).`, { code: EXIT.USAGE });
  const mode = modeRaw;

  const names = composeFiles.length ? composeFiles : config.composeFiles?.length && !env ? config.composeFiles : mode === "dev" ? DEV_FILES : PROD_FILES;
  const files = names.map((f) => (isAbsolute(f) ? f : resolve(root, f)));
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length) {
    throw new CliError(`Compose file not found: ${missing.join(", ")}`, { hint: mode === "prod" ? "Is this a production install? Use --env dev for a source checkout." : "Pass --compose-file or use --env prod." });
  }
  const envPath = resolve(root, envFile ?? config.envFile ?? ".env");
  return {
    root,
    mode,
    files,
    project: project ?? environ.POLYSITE_PROJECT ?? config.project ?? null,
    envPath,
    config,
  };
}
