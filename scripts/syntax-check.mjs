// Parses every source file (node --check) so a typo is found before a test run does.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") && files.push(p); } };
for (const d of ["bin", "src", "test"]) { try { walk(d); } catch { /* optional */ } }
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) { bad++; console.error(r.stderr); }
}
console.log(`${files.length} files checked, ${bad} with errors`);
process.exit(bad ? 1 : 0);
