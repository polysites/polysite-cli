import { backup, backups, restore } from "./backup.js";
import doctor from "./doctor.js";
import init from "./init.js";
import migrate from "./migrate.js";
import plugin from "./plugin.js";
import site from "./site.js";
import { down, logs, restart, status, up } from "./stack.js";
import theme from "./theme.js";
import upgrade from "./upgrade.js";
import user from "./user.js";
import version from "./version.js";

/** The command table, in the order `polysite --help` lists it. */
export const commands = Object.fromEntries(
  [init, doctor, up, down, status, logs, restart, plugin, migrate, backup, backups, restore, upgrade, user, site, theme, version].map((c) => [c.name, c]),
);
