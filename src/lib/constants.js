import { readFileSync } from "node:fs";

export const CLI_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

/** The core release `polysite init` installs when --core-version is not given. */
export const DEFAULT_CORE_VERSION = "0.1.0";
export const DEFAULT_REGISTRY = "ghcr.io/polysites";

/** Exit codes scripts can rely on (documented in the README). */
export const EXIT = {
  OK: 0,
  FAILED: 1, // something went wrong while doing the work
  USAGE: 2, // wrong command line
  CHECK_FAILED: 3, // a check ran and reported a problem (doctor, migrate --check)
  REFUSED: 4, // refused or cancelled: a safety rule, or a confirmation not given
  ROLLED_BACK: 5, // an upgrade failed and the previous version was put back
  ROLLBACK_FAILED: 6, // an upgrade failed and putting the previous version back failed too
};

export const SERVICES = ["caddy", "web", "cms", "db", "redis", "backup"];
