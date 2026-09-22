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

/** Redacts every exception value's `message` (Sentry's `event.exception.values[].value`)
    IN PLACE against `DIAGNOSTIC_CATALOGUE`, mirroring `redact.js#classifyMessage` on the
    Operon side. Applied to every event now, not only ones tagged `area: "auth.session"` —
    see the note below on why that tag no longer decides drop-or-keep. */
export async function redactEvent(
  event: Sentry.ErrorEvent,
): Promise<Sentry.ErrorEvent> {
  const values = event.exception?.values;
  if (!values) return event;
  for (const value of values) {
    if (
      typeof value.value === "string" &&
      !DIAGNOSTIC_CATALOGUE.has(value.value)
    ) {
      value.value = `redacted:${await sha1Hash8(value.value)}`;
    }
  }
  return event;
}

// skip init if env.sh never replaced the "KANEO_SENTRY_DSN" placeholder
if (dsn && !dsn.startsWith("KANEO_")) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: __APP_VERSION__,
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
    integrations: [
      Sentry.browserTracingIntegration(),
      // Stage 1 task 0.7: session replay OFF. A replay is a recording of what the reader
      // actually saw — draft message text, task titles, everything task 0.7's own
      // allowlist exists to keep OUT of a third-party destination — and no `beforeSend`
      // hook can redact a video. Dropping the integration is the only way to make that
      // guarantee; `replaysSessionSampleRate`/`replaysOnErrorSampleRate` are removed with
      // it below, since both are meaningless with no replay integration installed.
    ],
    tracesSampleRate: 0.1,
  });
}
