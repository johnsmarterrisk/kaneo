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

function assetPath(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const path = new URL(value, "https://redacted.invalid").pathname;
    return /^\/(?:assets\/)?[A-Za-z0-9_-]+\.m?js$/.test(path)
      ? path
      : undefined;
  } catch {
    return undefined;
  }
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
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
      frames: frames
        .flatMap((frame) => {
          const filename = assetPath(frame.filename);
          const lineno = positiveInteger(frame.lineno);
          const colno = positiveInteger(frame.colno);
          return filename && lineno && colno
            ? [{ filename, lineno, colno }]
            : [];
        })
        .slice(-10),
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
    type: undefined,
    event_id:
      typeof event.event_id === "string" &&
      /^[0-9a-f]{32}$/i.test(event.event_id)
        ? event.event_id
        : undefined,
    timestamp:
      typeof event.timestamp === "number" &&
      Number.isFinite(event.timestamp) &&
      event.timestamp > 0
        ? event.timestamp
        : undefined,
    platform: event.platform === "javascript" ? "javascript" : undefined,
    level:
      event.level === "error" ||
      event.level === "fatal" ||
      event.level === "warning"
        ? event.level
        : undefined,
    release:
      typeof event.release === "string" &&
      /^initiative-[0-9a-f]{32}$/.test(event.release) &&
      event.release === releaseIdentity()
        ? event.release
        : undefined,
    environment:
      event.environment === "production" ||
      event.environment === "development" ||
      event.environment === "test"
        ? event.environment
        : undefined,
    tags: {
      ...deploymentTags(),
      ...(event.tags?.area === "auth.session" ? { area: "auth.session" } : {}),
    },
  };

  if (typeof event.message === "string") {
    sanitized.message = await redactMessage(event.message);
  }

  if (event.exception?.values) {
    sanitized.exception = {
      values: await Promise.all(
        event.exception.values.slice(0, 10).map(sanitizeExceptionValue),
      ),
    };
  }

  if (event.request?.url) sanitized.request = { url: "/redacted" };

  return sanitized;
}

declare const __KANEO_SENTRY_RELEASE__: string;
declare const __KANEO_LOADED_VERSION_JSON__: string;

export function releaseIdentity(): string {
  return typeof __KANEO_SENTRY_RELEASE__ === "string" &&
    /^initiative-[0-9a-f]{32}$/.test(__KANEO_SENTRY_RELEASE__)
    ? __KANEO_SENTRY_RELEASE__
    : "unknown";
}

function deploymentTags(): Record<string, string> {
  try {
    const info = JSON.parse(__KANEO_LOADED_VERSION_JSON__);
    const tags: Record<string, string> = {};
    if (
      typeof info.release === "string" &&
      /^(?:\d{4}\.\d{2}\.\d{2}-\d+|dev-[0-9a-f]{7,40})$/.test(info.release)
    )
      tags.deployment_release = info.release;
    for (const key of ["operon_sha", "fork_sha"]) {
      if (typeof info[key] === "string" && /^[0-9a-f]{40}$/i.test(info[key]))
        tags[key] = info[key];
    }
    return tags;
  } catch {
    return {};
  }
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
