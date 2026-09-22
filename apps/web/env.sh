#!/bin/sh
set -e

echo "Starting environment variable replacement..."

# Process KANEO_API_URL first (with special handling)
if [ ! -z "$KANEO_API_URL" ]; then
  echo "Found KANEO_API_URL: $KANEO_API_URL"

  # First, replace the exact string "KANEO_API_URL" in all JavaScript files
  # Use grep -l to only process files that contain the string
  find /usr/share/nginx/html -type f -name "*.js" -exec grep -l "KANEO_API_URL" {} \; | xargs -r sed -i "s#KANEO_API_URL#$KANEO_API_URL#g"

  # Also check for the escaped version which might appear in some files
  find /usr/share/nginx/html -type f -name "*.js" -exec grep -l "\"KANEO_API_URL\"" {} \; | xargs -r sed -i "s#\"KANEO_API_URL\"#\"$KANEO_API_URL\"#g"

  # Build MCP OAuth discovery JSON for nginx to serve at /.well-known
  BASE_URL=$(echo "$KANEO_API_URL" | sed 's#/api/*$##')
  PRM_JSON="{\"resource\":\"${BASE_URL}/api/mcp\",\"authorization_servers\":[\"${BASE_URL}/api\"]}"
  AS_JSON="{\"issuer\":\"${BASE_URL}/api\",\"authorization_endpoint\":\"${BASE_URL}/api/mcp/authorize\",\"token_endpoint\":\"${BASE_URL}/api/mcp/token\",\"registration_endpoint\":\"${BASE_URL}/api/mcp/register\",\"response_types_supported\":[\"code\"],\"grant_types_supported\":[\"authorization_code\"],\"code_challenge_methods_supported\":[\"S256\"],\"token_endpoint_auth_methods_supported\":[\"none\"]}"
  sed -i "s#MCP_PRM_JSON_PLACEHOLDER#$PRM_JSON#g" /etc/nginx/conf.d/default.conf
  sed -i "s#MCP_AS_JSON_PLACEHOLDER#$AS_JSON#g" /etc/nginx/conf.d/default.conf

  echo "✅ Replaced KANEO_API_URL with $KANEO_API_URL"
else
  echo "WARNING: KANEO_API_URL environment variable is not set. API calls may fail."
  # No API URL — remove MCP placeholders so nginx doesn't serve broken JSON
  sed -i "s#MCP_PRM_JSON_PLACEHOLDER#{}#g" /etc/nginx/conf.d/default.conf
  sed -i "s#MCP_AS_JSON_PLACEHOLDER#{}#g" /etc/nginx/conf.d/default.conf
fi

# Process KANEO_CLIENT_URL efficiently
if [ ! -z "$KANEO_CLIENT_URL" ]; then
  echo "Found KANEO_CLIENT_URL: $KANEO_CLIENT_URL"
  
  # Only process files that actually contain the string
  find /usr/share/nginx/html -type f -name "*.js" -exec grep -l "KANEO_CLIENT_URL" {} \; | xargs -r sed -i "s#KANEO_CLIENT_URL#$KANEO_CLIENT_URL#g"
  find /usr/share/nginx/html -type f -name "*.js" -exec grep -l "\"KANEO_CLIENT_URL\"" {} \; | xargs -r sed -i "s#\"KANEO_CLIENT_URL\"#\"$KANEO_CLIENT_URL\"#g"
  
  echo "✅ Replaced KANEO_CLIENT_URL with $KANEO_CLIENT_URL"
fi

# Process OPERON_APEX_URL (Operon fork, task B11)
#
# The injected Operon switcher needs the apex origin to link back to, and it must be a
# RUNTIME value for the same reason KANEO_CLIENT_URL is: one image is built and then
# pointed at a domain family by compose, so a build arg would force a rebuild per
# environment. `apps/web/.env.production` bakes the literal `OPERON_APEX_URL` into the
# bundle and this block substitutes it here. Left unset, the literal survives and
# `operon-switcher.tsx` recognises it as unconfigured, warns once and falls back — it is
# never navigated to.
#
# NOTE: it is handled explicitly rather than by the generic loop below, which matches
# `KANEO_`-prefixed names only.
if [ ! -z "$OPERON_APEX_URL" ]; then
  echo "Found OPERON_APEX_URL: $OPERON_APEX_URL"

  find /usr/share/nginx/html -type f -name "*.js" -exec grep -l "OPERON_APEX_URL" {} \; | xargs -r sed -i "s#OPERON_APEX_URL#$OPERON_APEX_URL#g"
  find /usr/share/nginx/html -type f -name "*.js" -exec grep -l "\"OPERON_APEX_URL\"" {} \; | xargs -r sed -i "s#\"OPERON_APEX_URL\"#\"$OPERON_APEX_URL\"#g"

  echo "✅ Replaced OPERON_APEX_URL with $OPERON_APEX_URL"
else
  echo "WARNING: OPERON_APEX_URL is not set. The Operon switcher will fall back to its dev default."
fi

# Process any other KANEO_ prefixed environment variables (for future extensibility)
# Exclude the ones we've already processed
for key in $(env | grep '^KANEO_' | grep -v 'KANEO_API_URL\|KANEO_CLIENT_URL' | cut -d= -f1); do
  value=$(printenv "$key")
  
  if [ ! -z "$value" ]; then
    echo "Found $key: $value"
    
    # Only process files that contain this specific key
    find /usr/share/nginx/html -type f \( -name "*.js" -o -name "*.css" \) -exec grep -l "$key" {} \; | xargs -r sed -i "s#$key#$value#g"
    
    echo "✅ Replaced $key with $value"
  fi
done

# Empty the quoted Turnstile placeholder when its env var was left unset.
# Without this, the literal placeholder stays in the bundle and is read by
# the frontend as a truthy string — which broke self-hosted signup when
# KANEO_TURNSTILE_SITE_KEY was left unset (issue #1304).
echo "Stripping unset KANEO_* placeholders..."
find /usr/share/nginx/html -type f \( -name "*.js" -o -name "*.css" \) \
  -exec sed -i -E 's#[`"'"'"']KANEO_TURNSTILE_SITE_KEY[`"'"'"']#""#g' {} +

echo "✅ Environment variable replacement complete"

# ─── version.json (Operon stabilization plan tasks 0.5/0.6, decision D4) ──────────
#
# WRITTEN HERE, AT CONTAINER START, NOT AT BUILD TIME. This container's OWN config is a
# runtime value — everything substituted above (KANEO_API_URL, KANEO_CLIENT_URL,
# OPERON_APEX_URL) is baked into the ALREADY-BUILT bundle by this script, not by
# `pnpm run build`. That is the mirror image of `app/vite.config.ts`'s
# `versionStampPlugin` on the Operon side, which writes Operon's OWN version.json at BUILD
# time because Operon's config IS build-time (task 0.4's row states this contrast
# explicitly). `useVersionCheck.ts`/`version-check.ts` (task 0.6) on both sides compare a
# document against ITS OWN origin's version.json — the two files never need to agree with
# each other, only to describe the container/bundle that is actually running.
#
# `VERSION_RELEASE`/`VERSION_OPERON_SHA`/`VERSION_FORK_SHA` are plain runtime environment
# variables (docker-compose.yml, docker-compose.prod.yml), never substituted into the JS
# bundle — version.json is a fresh static file this script writes, not a placeholder this
# script replaces. Left unset they default to 'unknown', the same "honest unknown rather
# than a guess" contract `docker/web/Dockerfile`'s three new build args use when their
# ARGs are absent — assigning a REAL release id/SHA pair at deploy time is a
# deploy-pipeline follow-up neither side builds today.
echo "Writing version.json..."
VERSION_RELEASE="${VERSION_RELEASE:-unknown}"
VERSION_OPERON_SHA="${VERSION_OPERON_SHA:-unknown}"
VERSION_FORK_SHA="${VERSION_FORK_SHA:-unknown}"

# `config_hash` = sha256 of a CANONICAL ALLOWLIST of every effective substituted
# frontend configuration value (Stage 1 round-1 finding 18) — not just the three named
# URLs. The original computation hashed only `KANEO_API_URL`/`KANEO_CLIENT_URL`/
# `OPERON_APEX_URL`, while the generic loop above (`for key in $(env | grep '^KANEO_'
# ...)`) substitutes ANY other `KANEO_*`-prefixed var into the SAME bundle — a value
# such as `KANEO_TURNSTILE_SITE_KEY` (or any future one) could change, changing the
# bundle's actual bytes, with no corresponding change to this comparison key, which is
# exactly the failure task 0.4 exists to prevent.
#
# `KEY=value` LINES, SORTED BY KEY, not a bare value list: sorting makes the hash
# independent of `env`'s own (unspecified, and not guaranteed stable across shells or
# container runtimes) ordering, and the `KEY=` prefix on each line is what lets an EMPTY
# value differ from an ABSENT one (`KANEO_TURNSTILE_SITE_KEY=` vs no line at all) rather
# than collide the way a bare, unlabelled value list could. `OPERON_APEX_URL` is not
# `KANEO_`-prefixed (it has its own explicit substitution block above, not the generic
# loop), so it is added by hand rather than picked up by the `grep '^KANEO_'` below.
CONFIG_ALLOWLIST_INPUT=$(
  {
    printf 'OPERON_APEX_URL=%s\n' "${OPERON_APEX_URL:-}"
    env | grep '^KANEO_' || true
  } | sort
)
CONFIG_HASH=$(printf '%s' "${CONFIG_ALLOWLIST_INPUT}" | sha256sum | cut -d' ' -f1)
BUILT_AT=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

cat > /usr/share/nginx/html/version.json <<VERSIONJSON
{
  "release": "${VERSION_RELEASE}",
  "operon_sha": "${VERSION_OPERON_SHA}",
  "fork_sha": "${VERSION_FORK_SHA}",
  "config_hash": "${CONFIG_HASH}",
  "built_at": "${BUILT_AT}"
}
VERSIONJSON

echo "✅ version.json written (release=${VERSION_RELEASE}, config_hash=${CONFIG_HASH})"

# ─── Embed the SAME identity into the bundle itself (Stage 1 round-1 finding 4) ───
#
# `src/lib/version-check.ts`'s `getLoadedVersion()` used to answer "what did THIS
# document load with" by fetching `/version.json` above — the exact resource
# `fetchVersionJson()` fetches fresh to find the LATEST version, which let old, cached
# JavaScript fetch the new manifest as its own "loaded" answer and compare equal to
# itself forever. `apps/web/vite.config.ts` bakes a literal placeholder string,
# `KANEO_LOADED_VERSION_JSON_PLACEHOLDER`, into the bundle at BUILD time (the same
# mechanism `KANEO_API_URL` etc. already use); this substitutes the ACTUAL payload —
# byte-for-byte the same object just written to version.json, one minified line — into
# every bundle file carrying that placeholder, at CONTAINER START.
#
# VALIDATED, NOT ESCAPED. The placeholder sits inside a JS string literal already
# (`"KANEO_LOADED_VERSION_JSON_PLACEHOLDER"`, from `JSON.stringify(...)` at build time),
# so a `"` or `\` in the substituted text would break out of it or corrupt the bundle.
# `sed`'s own replacement-text escaping (`\"` and `\\` are NOT passed through as literal
# backslash-quote/backslash-backslash — most `sed` implementations consume the backslash
# and emit only the following character) makes a naive escape-then-substitute pipeline
# actively WRONG here, not just unnecessary — it would emit a bare `"` for every escaped
# quote, corrupting the JSON payload's own structural quotes into the bundle unescaped.
# The four values are each structurally constrained instead (a release id, two hex git
# SHAs, a hex sha256 digest, an ISO-8601 timestamp — `scripts/build/version-stamp.mjs`'s
# own doc comment states the same shapes on the Operon side) and validated against that
# shape; embedding is SKIPPED (not attempted with unsafe text) if any value fails, same
# "fail loud rather than emit something broken" contract the rest of this script uses.
case "${VERSION_RELEASE}${VERSION_OPERON_SHA}${VERSION_FORK_SHA}${CONFIG_HASH}${BUILT_AT}" in
  *[!A-Za-z0-9._:-]*)
    echo "⚠️  Skipped embedding loaded-version identity: a value contained an unexpected character" >&2
    ;;
  *)
    echo "Embedding loaded-version identity into the bundle..."
    LOADED_VERSION_JSON=$(printf '{"release":"%s","operon_sha":"%s","fork_sha":"%s","config_hash":"%s","built_at":"%s"}' \
      "${VERSION_RELEASE}" "${VERSION_OPERON_SHA}" "${VERSION_FORK_SHA}" "${CONFIG_HASH}" "${BUILT_AT}")
    find /usr/share/nginx/html -type f -name "*.js" -exec grep -l "KANEO_LOADED_VERSION_JSON_PLACEHOLDER" {} \; | \
      xargs -r sed -i "s#KANEO_LOADED_VERSION_JSON_PLACEHOLDER#${LOADED_VERSION_JSON}#g"
    echo "✅ Loaded-version identity embedded"
    ;;
esac
