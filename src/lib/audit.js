import { appendFileSync, mkdirSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";

const who = () => {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return "unknown";
  }
};
const clean = (v) => String(v).replace(/\s+/g, " ");
const fmt = (v) => (/[\s"=]/.test(clean(v)) ? JSON.stringify(clean(v)) : clean(v));

/** One line per sensitive action in <install>/.polysite/audit.log: time, who, event, key=value pairs. Values never include secrets. */
export function createAudit(root, { dryRun = false } = {}) {
  const file = join(root, ".polysite", "audit.log");
  return {
    file,
    write(event, fields = {}) {
      if (dryRun) return null;
      const pairs = Object.entries(fields).map(([k, v]) => `${k}=${fmt(v)}`).join(" ");
      const line = `${new Date().toISOString()} ${who()} event=${event} ${pairs}`.trimEnd();
      mkdirSync(join(root, ".polysite"), { recursive: true });
      appendFileSync(file, `${line}\n`);
      return line;
    },
  };
}
