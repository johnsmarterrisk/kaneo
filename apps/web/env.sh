#!/bin/sh
set -e

# Node is already in the bundled image; the standalone web image installs it too.
# Runtime configuration and the deployment identity are written into index.html only.
# No .js byte is ever rewritten (open-items 458, Operon repo): see the comment below.
node --input-type=commonjs <<'KANEO_RUNTIME_NODE'
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const root = "/usr/share/nginx/html";
const configPath = "/etc/nginx/conf.d/default.conf";
const env = process.env;
const configValues = Object.fromEntries([
  ["OPERON_APEX_URL", env.OPERON_APEX_URL ?? ""],
  ...Object.entries(env).filter(([key]) => key.startsWith("KANEO_")),
].sort(([a], [b]) => a.localeCompare(b, "en")));
const identity = {
  release: env.VERSION_RELEASE || "unknown",
  operon_sha: env.VERSION_OPERON_SHA || "unknown",
  fork_sha: env.VERSION_FORK_SHA || "unknown",
  config_hash: createHash("sha256").update(JSON.stringify(configValues)).digest("hex"),
  built_at: new Date().toISOString(),
};
// Versioning v1 (docs/specs/versioning-v1-mini-spec.md, Operon repo): releases are now
// canonical vMAJOR.MINOR (v1.0, v1.1, ...; major >= 1, no leading zeros) in place of
// YYYY.MM.DD-N. Both shapes are accepted here —
// the OLD one stays valid for every already-shipped release, since this validator has no
// way to know which scheme a given deployment predates. The old "dev-[0-9a-f]{7,40}" shape
// is dropped: Operon's build-time fallback no longer synthesizes it (an unset
// VITE_APP_VERSION now leaves release empty, same as this file's own "unknown" default
// above), so "unknown" is the only fallback value either side ever produces.
if (!/^(?:unknown|v[1-9]\d*\.(?:0|[1-9]\d*)|\d{4}\.\d{2}\.\d{2}-\d+)$/.test(identity.release) ||
    ![identity.operon_sha, identity.fork_sha].every(value => /^(?:unknown|[0-9a-f]{40})$/i.test(value))) {
  throw new Error("Invalid deployment identity");
}

const writes = [];

// Runtime configuration and the loaded identity live in index.html, never in a hashed
// .js chunk (open-items 458, Operon repo). index.html is served no-cache and is not
// edge-cached, so a reload always sees the release and configuration it belongs to.
// Rewriting a chunk changed its bytes under an unchanged hashed filename, and a CDN that
// rewrote no-cache to max-age kept serving the previous bytes for hours: an old identity
// made the version check reload forever, and old configuration ran under a new identity.
// Each slot element is replaced whole, so a container restart rewrites it idempotently.
// "<" is escaped so no value can close the script element early.
const indexPath = `${root}/index.html`;
const scriptJson = value => JSON.stringify(value).replaceAll("<", "\\u003c");
let index = fs.readFileSync(indexPath, "utf8");

const VERSION_SLOT = /<script id="operon-loaded-version">[\s\S]*?<\/script>/;
if (!VERSION_SLOT.test(index)) throw new Error("index.html has no loaded-version slot");
index = index.replace(VERSION_SLOT, () =>
  `<script id="operon-loaded-version">window.__OPERON_LOADED_VERSION__ = ${scriptJson(identity)};</script>`);

// vite.config.ts lists the keys the bundle reads in data-keys at build time, so only
// those reach the page — never every KANEO_* variable in the container's environment.
const CONFIG_SLOT = /<script id="operon-runtime-config" data-keys="([^"]*)">[\s\S]*?<\/script>/;
const configSlot = index.match(CONFIG_SLOT);
if (!configSlot) throw new Error("index.html has no runtime-config slot");
const configKeys = configSlot[1] ? configSlot[1].split(",") : [];
if (!configKeys.every(key => /^(?:KANEO_[A-Z0-9_]+|OPERON_APEX_URL)$/.test(key))) {
  throw new Error("Invalid runtime-config key list");
}
// Same values the old .js slots received: an unset or empty key keeps its own name (the
// "never substituted" placeholder the client already checks for); Turnstile empties.
const runtimeConfig = Object.fromEntries(configKeys.map(key =>
  [key, env[key] || (key === "KANEO_TURNSTILE_SITE_KEY" ? "" : key)]));
index = index.replace(CONFIG_SLOT, () =>
  `<script id="operon-runtime-config" data-keys="${configSlot[1]}">` +
  `window.__OPERON_RUNTIME_CONFIG__ = ${scriptJson(runtimeConfig)};</script>`);
writes.push([indexPath, index]);

// Validate everything before publishing index.html or the manifests.
let prm = {};
let authorization = {};
if (env.KANEO_API_URL) {
  const api = new URL(env.KANEO_API_URL);
  if (!["http:", "https:"].includes(api.protocol) || api.username || api.password || api.search || api.hash) {
    throw new Error("Invalid API URL");
  }
  const base = api.href.replace(/\/api\/*$/, "").replace(/\/$/, "");
  prm = { resource: `${base}/api/mcp`, authorization_servers: [`${base}/api`] };
  authorization = {
    issuer: `${base}/api`, authorization_endpoint: `${base}/api/mcp/authorize`,
    token_endpoint: `${base}/api/mcp/token`, registration_endpoint: `${base}/api/mcp/register`,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
  };
}
// nginx wraps these JSON documents in a single-quoted return argument.
const nginxJson = value => JSON.stringify(value).replaceAll("'", "\\u0027").replaceAll("\\", "\\\\");
const nginx = fs.readFileSync(configPath, "utf8")
  .replace("MCP_PRM_JSON_PLACEHOLDER", () => nginxJson(prm))
  .replace("MCP_AS_JSON_PLACEHOLDER", () => nginxJson(authorization));
for (const [path, value] of writes) fs.writeFileSync(path, value);
fs.writeFileSync(configPath, nginx);
fs.writeFileSync(`${root}/version.json`, JSON.stringify(identity));
KANEO_RUNTIME_NODE
