#!/bin/sh
set -e

# Node is already in the bundled image; the standalone web image installs it too.
# Keep runtime values in fixed-width JS literal slots emitted by vite.config.ts.
# Padding OUTSIDE the closing quote preserves every following source-map column,
# without altering the value. Only these slots are substituted, never source text.
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

function substitute(source) {
  return source.replace(/(["'`])((?:KANEO_[A-Z0-9_]+|OPERON_APEX_URL) +)\1/g, (slot, quote, paddedKey) => {
    const key = paddedKey.trimEnd();
    const value = key === "KANEO_LOADED_VERSION_JSON_PLACEHOLDER" ? JSON.stringify(identity)
      : env[key] || (key === "KANEO_TURNSTILE_SITE_KEY" ? "" : key);
    // ASCII escapes keep byte offsets, UTF-16 columns and line counts identical,
    // including for quotes, backslashes, controls and non-ASCII configuration.
    const literal = JSON.stringify(JSON.stringify(value)).replace(/[\u007f-\uffff]/g,
      char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
    if (literal.length > slot.length) throw new Error("Runtime configuration exceeds reserved slot");
    return literal.padEnd(slot.length);
  });
}

const writes = [];
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) visit(path);
    else if (entry.name.endsWith(".js")) {
      const source = fs.readFileSync(path, "utf8");
      const replaced = substitute(source);
      if (replaced !== source) writes.push([path, replaced]);
    }
  }
}
visit(root);

// Validate everything before publishing any changed bundle or manifest.
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
