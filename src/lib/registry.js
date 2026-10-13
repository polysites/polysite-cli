import { CliError } from "./errors.js";
import { compareVersions, parseVersion } from "./semver.js";

const isLocalHost = (h) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(h);

async function getJson(url, headers, timeoutMs = 15000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  return res;
}

/**
 * Lists the tags of `<registry>/<image>` from a Docker registry's HTTP API (anonymous access, with the usual bearer-token
 * handshake that GitHub's registry and Docker Hub use). Returns an array of tag names.
 */
export async function listTags(registry, image, { fetchImpl } = {}) {
  const first = registry.split("/")[0];
  const host = first.includes(".") || first.includes(":") || first === "localhost" ? first : "registry-1.docker.io";
  const prefix = host === first ? registry.split("/").slice(1).join("/") : registry;
  const name = [prefix, image].filter(Boolean).join("/");
  const base = `${isLocalHost(host) ? "http" : "https"}://${host}`;
  void fetchImpl;
  const url = `${base}/v2/${name}/tags/list?n=1000`;
  let res = await getJson(url, {});
  if (res.status === 401) {
    const challenge = res.headers.get("www-authenticate") ?? "";
    const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
    const service = /service="([^"]+)"/.exec(challenge)?.[1];
    if (!realm) throw new CliError(`The registry ${host} wants a login to list ${name}.`, { hint: "Pass --to <version> instead." });
    const tokenUrl = `${realm}?${service ? `service=${encodeURIComponent(service)}&` : ""}scope=${encodeURIComponent(`repository:${name}:pull`)}`;
    const t = await getJson(tokenUrl, {});
    if (!t.ok) throw new CliError(`The registry ${host} refused an anonymous read of ${name} (${t.status}).`, { hint: "The images may be private. Pass --to <version> instead." });
    const token = (await t.json()).token;
    res = await getJson(url, { Authorization: `Bearer ${token}` });
  }
  if (!res.ok) throw new CliError(`Could not list tags for ${name} on ${host} (HTTP ${res.status}).`, { hint: "Pass --to <version> instead." });
  const body = await res.json();
  return body.tags ?? [];
}

/** The newest release tag (v1.2.3, and v1.2.3-beta.1 with `pre`), or null when there is none. */
export async function latestVersion(registry, image, { pre = false } = {}) {
  const tags = await listTags(registry, image);
  const versions = tags
    .filter((t) => /^v\d/.test(t))
    .map((t) => parseVersion(t))
    .filter((v) => v && (pre || v.pre.length === 0))
    .map((v) => v.text);
  if (!versions.length) return null;
  return versions.sort(compareVersions).pop();
}
