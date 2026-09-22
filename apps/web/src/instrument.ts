import * as Sentry from "@sentry/react";

const dsn = import.meta.env.VITE_SENTRY_DSN;

/**
 * Stage 1 task 0.7's diagnostic catalogue — the SAME allowlist
 * `platform-service/src/client-errors/catalogue.js` keeps on the Operon side (repository
 * `Operon`, not this one), duplicated by hand rather than imported: these are two separate
 * repositories with no shared package, and `docs/fork-discipline.md` row 2's Stabilization
 * Stage 1 note declares only this file for task 0.7, not a new shared module. A message
 * NOT in this set is replaced by a short, still-groupable tag before it ever reaches
 * Sentry's cloud — Sentry is a third-party destination outside this stack, so the same
 * "never raw user content leaves this stack unredacted" contract that applies to
 * platform-service's own logs applies here too.
 */
export const DIAGNOSTIC_CATALOGUE = new Set([
  "Failed to fetch",
  "Load failed",
  "NetworkError when attempting to fetch resource.",
  "The network connection was lost.",
  "A network error occurred.",
  "Network request failed",
  "ChunkLoadError",
  "Failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "The user aborted a request.",
  "AbortError: The operation was aborted.",
  "cancelled",
]);

/** sha1, hex, first 8 characters — byte-for-byte the same "redacted:<sha1-8>" shape the
    Operon side's `redact.js#sha1Hash8` produces, so a human correlating the two systems by
    eye sees the same tag format on both. `crypto.subtle` (Web Crypto) rather than a hand
    -rolled hash: it is already a browser global, needs no dependency, and is async, which
    Sentry's `beforeSend` already supports returning a `Promise` from. */
export async function sha1Hash8(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

/** Mirrors `platform-service/src/client-errors/index.js`'s `KNOWN_ERROR_NAMES` — `Error`'s
    `name`/`type` is a writable, arbitrary string, so only a fixed set of names the
    platform/spec itself produces is forwarded verbatim; anything else becomes the generic
    `'Error'` tag rather than passing arbitrary text through unvalidated (finding 2: an
    unlisted type survived the old code untouched). */
const KNOWN_ERROR_TYPES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  "DOMException",
  "AbortError",
  "ChunkLoadError",
  "NetworkError",
  "NotAllowedError",
  "QuotaExceededError",
  "TimeoutError",
]);

async function redactMessage(value: string): Promise<string> {
  if (DIAGNOSTIC_CATALOGUE.has(value)) return value;
  return `redacted:${await sha1Hash8(value)}`;
}

function normalizeType(type: string | undefined): string | undefined {
  if (typeof type !== "string") return undefined;
  return KNOWN_ERROR_TYPES.has(type) ? type : "Error";
}

/** Strips a query string/fragment off a stack-frame filename or a request URL — the same
    leak channel `platform-service`'s `FRAME_RE`/`sanitizePath` close server-side (a token
    or other page-specific content can ride along as `?token=...`). The path itself is kept
    (not hashed) because it is needed for release-specific symbolication (finding 17) and a
    bundle/source path is not user content. */
function sanitizeUrlLike(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.split(/[?#]/, 1)[0].slice(0, 500);
}

async function sanitizeExceptionValue(
  value: Sentry.Exception,
): Promise<Sentry.Exception> {
  const sanitized: Sentry.Exception = {
    type: normalizeType(value.type),
  };
  if (typeof value.value === "string") {
    sanitized.value = await redactMessage(value.value);
  }
  const frames = value.stacktrace?.frames;
  if (frames) {
    sanitized.stacktrace = {
      frames: frames.map((frame) => ({
        filename: sanitizeUrlLike(frame.filename),
        function: frame.function,
        lineno: frame.lineno,
        colno: frame.colno,
        in_app: frame.in_app,
      })),
    };
  }
  return sanitized;
}

/**
 * Builds an ALLOWLISTED event — the same "construct the output, never patch the input"
 * shape `platform-service/src/client-errors/index.js`'s `buildLogPayload` uses — instead of
 * redacting `exception.values[].value` in place and letting every other field (top-level
 * `message`, `breadcrumbs`, `request.url`, exception `type`, frame `filename`, `extra`,
 * `contexts`) reach Sentry untouched (Stage 1 finding 2: a read-only probe found synthetic
 * private text and tokenized URLs surviving in exactly those fields).
 *
 * `breadcrumbs`, `extra`, and `contexts` are dropped entirely rather than sanitized: unlike
 * a message or a filename there is no fixed shape to validate them against, so "redact and
 * forward" is not available and "drop" is the only safe default (mirrors platform-service's
 * `buildLogPayload`, which never spreads the client body — it reads named fields only).
 */
export async function redactEvent(
  event: Sentry.ErrorEvent,
): Promise<Sentry.ErrorEvent> {
  const sanitized: Sentry.ErrorEvent = {
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    release: event.release,
    environment: event.environment,
    tags: event.tags?.area ? { area: event.tags.area } : undefined,
  };

  if (typeof event.message === "string") {
    sanitized.message = await redactMessage(event.message);
  }

  if (event.exception?.values) {
    sanitized.exception = {
      values: await Promise.all(
        event.exception.values.map(sanitizeExceptionValue),
      ),
    };
  }

  const url = sanitizeUrlLike(event.request?.url);
  if (url) {
    sanitized.request = { url };
  }

  return sanitized;
}

/** `apps/web/vite.config.ts`'s build-time placeholder, substituted by `env.sh` at
    container start with the SAME identity `version.json` carries — see
    `src/lib/version-check.ts`'s copy of this declaration for the full contract. Declared
    here too rather than imported: this file and that one are declared independently in
    `docs/fork-discipline.md` row 2, and neither currently depends on the other. */
declare const __KANEO_LOADED_VERSION_JSON__: string;

/**
 * Stage 1 round-1 finding 17: `release: __APP_VERSION__` tagged every event with only
 * upstream Kaneo's package version — the same string on every deploy of this fork,
 * regardless of which Operon or fork commit actually produced the running bundle. A
 * captured stack frame could never be matched back to the RIGHT source map for a
 * multi-release history. This reads the SAME runtime-embedded identity
 * `version-check.ts#getLoadedVersion` reads (both deployment SHAs, not just this
 * package's own version), so a release tag on an event uniquely identifies the exact
 * candidate image it came from. Falls back to `__APP_VERSION__` alone when the embedded
 * constant is absent or still the un-substituted placeholder (a local `vite dev` run with
 * no `env.sh`), so Sentry still receives SOME release value rather than `undefined`.
 */
export function releaseIdentity(): string {
  try {
    const raw =
      typeof __KANEO_LOADED_VERSION_JSON__ === "string"
        ? __KANEO_LOADED_VERSION_JSON__
        : "";
    if (raw && raw !== "KANEO_LOADED_VERSION_JSON_PLACEHOLDER") {
      const info = JSON.parse(raw) as {
        release?: string;
        operon_sha?: string;
        fork_sha?: string;
      };
      if (
        typeof info.release === "string" &&
        typeof info.operon_sha === "string" &&
        typeof info.fork_sha === "string"
      ) {
        return `${info.release}+${info.operon_sha.slice(0, 7)}.${info.fork_sha.slice(0, 7)}`;
      }
    }
  } catch {
    // Malformed embedded constant — fall through to the package-version-only value below.
  }
  // `typeof` guard, not a bare reference: `__APP_VERSION__` is a Vite `define` (textual
  // replacement at build time) with no runtime binding at all outside a Vite/Rollup
  // build — a bare reference throws `ReferenceError` in, for one, this file's own test
  // environment, which uses a separate `vitest.config.ts` with no `define` of its own.
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown";
}

// skip init if env.sh never replaced the "KANEO_SENTRY_DSN" placeholder
if (dsn && !dsn.startsWith("KANEO_")) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: releaseIdentity(),
    sendDefaultPii: false,
    ignoreErrors: [
      // Thrown by Safari browser extensions on iOS 18+ injecting content scripts;
      // not caused by kaneo code.
      "Invalid call to runtime.sendMessage()",
      // Thrown by Facebook's in-app browser (Android) navigation performance logger
      // calling postMessage on a destroyed WebView Java bridge; not caused by kaneo code.
      "Error invoking postMessage: Java object is gone",
    ],
    denyUrls: [
      // Errors from third-party affiliate/adware browser extensions that inject
      // scripts fetching from rsc.cdn77.org (e.g. domainList.json); not caused by kaneo code.
      /cdn77\.org/,
    ],
    // Stage 1 task 0.7 (decision D4): "tagged session-fetch errors no longer dropped, same
    // allowlist." `area: "auth.session"` used to make this return `null` and drop the
    // event outright — the query client's own cooldown already rate-limits the network
    // noise, but dropping the event ALSO meant a genuine session-auth regression (not just
    // Safari's noisy "Load failed") produced zero Sentry signal, which is what task 0.7
    // exists to stop being true. Every event now reaches Sentry, redacted the same way any
    // other event is — `auth.session` stays a useful FILTER tag in the Sentry UI, it just
    // no longer decides whether the event exists at all.
    beforeSend(event) {
      return redactEvent(event);
    },
    // Stage 1 finding 2 (round 1 review): `browserTracingIntegration()` ships transaction
    // and span events on its OWN channel, `beforeSendTransaction` — a distinct pipe from
    // `beforeSend`/`redactEvent` above, which only ever ran against error events. A
    // transaction carries its own breadcrumb-shaped `request.url`/span descriptions with no
    // allowlist over them, so leaving tracing on would reopen exactly the leak `redactEvent`
    // closes, through a channel this file's `beforeSend` hook never touches. No integration
    // is added here (task 0.7: session replay OFF, same reasoning — no safe sanitizer
    // exists for either channel), and `tracesSampleRate` is omitted so no transaction is
    // ever created to leak in the first place.
    integrations: [],
  });
}
