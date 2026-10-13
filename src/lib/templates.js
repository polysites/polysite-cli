import { readFileSync } from "node:fs";

const DIR = new URL("../../templates/", import.meta.url);

export const readTemplate = (name) => readFileSync(new URL(name, DIR), "utf8");

/** Replaces {{NAME}} with vars.NAME and fails loudly on a placeholder nobody filled in. */
export function fill(text, vars) {
  const out = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`Template placeholder {{${k}}} has no value`);
    return String(vars[k]);
  });
  return out;
}

/** Lines starting with "#@db " are kept (marker removed) when `localDb` is true and dropped otherwise. */
export function applyDbMarkers(text, localDb) {
  return text
    .split("\n")
    .flatMap((line) => {
      if (!line.startsWith("#@db ")) return [line];
      return localDb ? [line.slice(5)] : [];
    })
    .join("\n");
}
