import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// Reads and edits a .env file without disturbing it: comments, blank lines, ordering and the file's own line endings
// are kept. Only the lines for the keys you set change.
const ASSIGN = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function unquote(raw) {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  // An unquoted value ends at a " #" comment.
  const hash = v.search(/\s#/);
  return (hash === -1 ? v : v.slice(0, hash)).trim();
}

const needsQuotes = (v) => /[\s#"'$`\\]/.test(v) || v === "";

export class EnvFile {
  constructor(text = "", path = null) {
    this.path = path;
    this.eol = text.includes("\r\n") ? "\r\n" : "\n";
    this.lines = text === "" ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  }

  static read(path) {
    return new EnvFile(existsSync(path) ? readFileSync(path, "utf8") : "", path);
  }

  #find(key) {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const m = ASSIGN.exec(this.lines[i]);
      if (m && m[3] === key) return i;
    }
    return -1;
  }

  has(key) { return this.#find(key) !== -1; }

  get(key) {
    const i = this.#find(key);
    return i === -1 ? undefined : unquote(ASSIGN.exec(this.lines[i])[4]);
  }

  /** Every assignment, later lines winning, as a plain object. */
  all() {
    const out = {};
    for (const line of this.lines) {
      const m = ASSIGN.exec(line);
      if (m) out[m[3]] = unquote(m[4]);
    }
    return out;
  }

  set(key, value) {
    const v = String(value);
    if (/[\r\n]/.test(v)) throw new Error(`The value for ${key} contains a line break`);
    const text = needsQuotes(v) ? `"${v.replace(/(["\\$`])/g, "\\$1")}"` : v;
    const i = this.#find(key);
    if (i !== -1) { this.lines[i] = `${ASSIGN.exec(this.lines[i])[1]}${key}=${text}`; return this; }
    // A commented-out example ("# KEY=...") is replaced in place, so the file keeps reading in order.
    const commented = this.lines.findIndex((l) => new RegExp(`^\\s*#\\s*${key}\\s*=`).test(l));
    if (commented !== -1) this.lines[commented] = `${key}=${text}`;
    else this.lines.push(`${key}=${text}`);
    return this;
  }

  unset(key) {
    const i = this.#find(key);
    if (i !== -1) this.lines.splice(i, 1);
    return this;
  }

  toString() { return this.lines.length ? this.lines.join(this.eol) + this.eol : ""; }

  /** Writes next to the file and renames over it, so a crash never leaves half a file. Secrets stay readable by the owner only. */
  write(path = this.path) {
    if (!path) throw new Error("No path to write the env file to");
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, this.toString(), { mode: 0o600 });
    renameSync(tmp, path);
    try { chmodSync(path, 0o600); } catch { /* not supported on this platform */ }
  }
}

/** Splits a comma separated list value ("posts, search") into clean items. */
export const splitList = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
