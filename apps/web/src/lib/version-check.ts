import { useIsMutating } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { i18n } from "@/lib/i18n";

/** Vite emits a fixed-width runtime slot. env.sh fills it at container start;
    JSON.parse in the define prevents constant folding into surrounding strings. */
declare const __KANEO_LOADED_VERSION_JSON__: string;

/** The loaded identity belongs to these bundle bytes. Only the target is fetched:
    fetching both from /version.json would make a cached document compare the newest
    manifest to itself and miss every update. Keep the config hash in the comparison
    because the same build can be deployed with different runtime URLs. */
export interface VersionInfo {
  release: string;
  operon_sha: string;
  fork_sha: string;
  config_hash: string;
  built_at: string;
}

function isVersionInfo(value: unknown): value is VersionInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.release === "string" &&
    typeof v.operon_sha === "string" &&
    typeof v.fork_sha === "string" &&
    typeof v.config_hash === "string" &&
    typeof v.built_at === "string"
  );
}

/** Stage 1 finding 13: a hung `/version.json` request had no timeout — the periodic check
    would wait on it indefinitely. 8s mirrors `app/src/shell/version.ts`'s own bound on the
    Operon side. */
const FETCH_TIMEOUT_MS = 8000;

let inFlightVersionFetch: Promise<VersionInfo | null> | null = null;

/**
 * Fetches `/version.json` fresh — `nginx.kaneo.conf`'s `location /` sends
 * `Cache-Control: no-cache` on it (task 0.4), so this always revalidates. Returns `null`
 * on any network failure, a non-200, a timeout, or a malformed body; callers treat `null`
 * as "cannot tell right now," never as "no update."
 *
 * SINGLE-FLIGHT (Stage 1 finding 13). `visibilitychange`, `pageshow` and `focus` can fire
 * within the same tick of each other; a caller that arrives while one fetch is already in
 * flight is handed that SAME promise rather than starting a second concurrent request for
 * the identical resource. The slot clears the moment it settles, so the next call (once
 * nothing is in flight) always fetches fresh.
 */
export function fetchVersionJson(): Promise<VersionInfo | null> {
  if (inFlightVersionFetch) return inFlightVersionFetch;

  inFlightVersionFetch = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch("/version.json", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body: unknown = await res.json();
      return isVersionInfo(body) ? body : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();

  void inFlightVersionFetch.finally(() => {
    inFlightVersionFetch = null;
  });

  return inFlightVersionFetch;
}

/** Test-only: clears the single-flight slot without waiting for it to settle. */
export function resetInFlightVersionFetchForTests(): void {
  inFlightVersionFetch = null;
}

let cachedLoadedVersion: VersionInfo | null | undefined;

/** Parses the build-time/container-start-embedded `__KANEO_LOADED_VERSION_JSON__`
    constant. `undefined` (the define never ran — a non-Vite test environment), the raw,
    never-substituted placeholder text (a dev build with no `env.sh` run, e.g. `vite dev`),
    and a malformed/unparseable payload all become `null` — the same "cannot tell" contract
    `fetchVersionJson()` uses for a network failure. */
function parseEmbeddedVersion(): VersionInfo | null {
  try {
    const raw =
      typeof __KANEO_LOADED_VERSION_JSON__ === "string"
        ? __KANEO_LOADED_VERSION_JSON__
        : "";
    if (!raw || raw === "KANEO_LOADED_VERSION_JSON_PLACEHOLDER") return null;
    const body: unknown = JSON.parse(raw);
    return isVersionInfo(body) ? body : null;
  } catch {
    return null;
  }
}

/** The version THIS document loaded with — read from the embedded constant exactly once
    per document lifetime and cached. `resetLoadedVersionForTests()` is the only way to
    clear it; a real browser document never needs it (a reload is a fresh module graph and
    a fresh embedded constant). */
export function getLoadedVersion(): Promise<VersionInfo | null> {
  if (cachedLoadedVersion === undefined) {
    cachedLoadedVersion = parseEmbeddedVersion();
  }
  return Promise.resolve(cachedLoadedVersion);
}

/** Test-only reset of the module-level cache. */
export function resetLoadedVersionForTests(): void {
  cachedLoadedVersion = undefined;
}

/** First 7 characters of a commit sha — 'unknown' and anything shorter pass through
    unshortened. */
export function sha7(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/** The plan's own compare key: a config-only change (env.sh substituting a different
    value) bumps `config_hash` without a new `release`. */
export function versionKey(info: VersionInfo): string {
  return `${info.release}::${info.config_hash}`;
}

/** `v<release> · <sha7>/<sha7>` — the same literal shape `app/src/shell/VersionStamp.tsx`
    renders on the Operon side. `null` renders as an em dash. */
export function formatStamp(info: VersionInfo | null): string {
  if (!info) return "—";
  return `v${info.release} · ${sha7(info.operon_sha)}/${sha7(info.fork_sha)}`;
}

/**
 * Shared by the three chrome surfaces that render the stamp (`OperonRailHeader`,
 * `OperonPhoneNavigate`, `layout.tsx`'s `LayoutHeader`) so the "fetch once, format the
 * same way" logic exists in exactly one place rather than three copies of the same
 * `useEffect`/`useState` pair — the equivalent of `app/src/shell/VersionStamp.tsx` on the
 * Operon side, which is a full component there because Operon has one render target for
 * the mark; this fork has three, each already carrying its own layout, so only the DATA
 * is shared here and each caller renders its own markup around `formatStamp(info)`.
 */
export function useVersionStampText(): string {
  const [info, setInfo] = useState<VersionInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getLoadedVersion().then((loaded) => {
      if (!cancelled) setInfo(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return formatStamp(info);
}

// Editor predicates bridge the debounce window and remain true after a failed save.
// useIsMutating and the fetch wrapper protect requests already in flight.
type DirtyCheck = () => boolean;

const dirtyEditors = new Map<string, DirtyCheck>();
let nextDirtyId = 0;

/** Registers `check` under a fresh id (two open comment boxes never collide) and returns
    the unregister function — call it on unmount. */
export function registerDirtyEditor(check: DirtyCheck): () => void {
  nextDirtyId += 1;
  const id = `dirty:${nextDirtyId}`;
  dirtyEditors.set(id, check);
  return () => {
    if (dirtyEditors.get(id) === check) dirtyEditors.delete(id);
  };
}

/** True when ANY registered editor currently has unsaved text. A predicate that throws
    counts as false, the same fail-safe `protectedState.ts#hasProtectedState` uses. */
function hasDirtyEditor(): boolean {
  for (const check of dirtyEditors.values()) {
    try {
      if (check()) return true;
    } catch {
      // Deliberately swallowed — one misbehaving predicate must not break every other
      // registered check, or the reload gate itself.
    }
  }
  return false;
}

/** Test-only reset — a real document never needs this (a reload clears the module graph). */
export function resetDirtyEditorsForTests(): void {
  dirtyEditors.clear();
  nextDirtyId = 0;
}

// ─── useVersionCheck — the fork's half of task 0.6's forced-reload hook ──────────────

export const CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const DRAIN_POLL_MS = 5000;
export const MAX_RELOAD_ATTEMPTS_PER_VERSION = 2;
/** Stage 1 finding 11: the episode-wide bound across every distinct target this session
    has seen — mirrors `app/src/shell/useVersionCheck.ts`'s own constant of the same name
    and value on the Operon side. */
export const MAX_TOTAL_RELOAD_ATTEMPTS_PER_SESSION = 4;
export const RELOAD_ATTEMPTS_STORAGE_KEY =
  "operon.version-check.reload-attempts";

let reloadScheduled = false;
export function isReloadScheduled(): boolean {
  return reloadScheduled;
}
/** Test-only. */
export function resetReloadScheduledForTests(): void {
  reloadScheduled = false;
}

// Install once for the document; route changes must not open a write-admission gap.
let originalFetch: typeof fetch | null = null;
let inFlightWrites = 0;
function installMutationAdmission(): void {
  if (originalFetch) return;
  originalFetch = window.fetch;
  const captured = originalFetch;
  window.fetch = async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const writing = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    if (writing && isReloadScheduled()) {
      const message = i18n.t("common:versionUpdate.writeRefused");
      toast.info(message);
      throw new Error(message);
    }
    if (writing) inFlightWrites += 1;
    try {
      return await captured.call(window, input, init);
    } finally {
      if (writing) inFlightWrites -= 1;
    }
  };
}

export function resetMutationAdmissionForTests(): void {
  if (originalFetch) window.fetch = originalFetch;
  originalFetch = null;
  inFlightWrites = 0;
}

/** A MAP of every target key this session has attempted (Stage 1 finding 11) — not the
    single `{ key, count }` pair the original shape overwrote on every write, which reset
    the effective count for whichever key was not the LAST one written, so alternating
    between two flapping targets never hit the per-target cap. */
interface StoredAttempts {
  perTarget: Record<string, number>;
}

/** `null` means the ledger could not be read — the caller must treat that as "cannot
    prove this is bounded," never as "zero attempts so far" (finding 11: the original code
    defaulted to zero on a broken ledger, so a persistently unreadable `sessionStorage`
    reloaded with no memory across reloads at all). */
function readAttempts(): StoredAttempts | null {
  try {
    const raw = sessionStorage.getItem(RELOAD_ATTEMPTS_STORAGE_KEY);
    if (!raw) return { perTarget: {} };
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as StoredAttempts).perTarget === "object" &&
      (parsed as StoredAttempts).perTarget !== null &&
      !Array.isArray((parsed as StoredAttempts).perTarget)
    ) {
      const clean: Record<string, number> = Object.create(null);
      for (const [key, value] of Object.entries(
        (parsed as StoredAttempts).perTarget,
      )) {
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < 0
        )
          return null;
        clean[key] = value;
      }
      return { perTarget: clean };
    }
    return null;
  } catch {
    return null;
  }
}

/** Returns whether the write actually succeeded — the caller must not proceed with a
    reload it could not account for. */
function writeAttempts(entry: StoredAttempts): boolean {
  try {
    sessionStorage.setItem(RELOAD_ATTEMPTS_STORAGE_KEY, JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

function totalAttempts(attempts: StoredAttempts): number {
  return Object.values(attempts.perTarget).reduce((sum, n) => sum + n, 0);
}

export type Reloader = () => void;
const defaultReloader: Reloader = () => window.location.reload();

export interface UseVersionCheckOptions {
  /** Test seam only — production always uses `defaultReloader`. */
  reloader?: Reloader;
}

/**
 * Compares this document's loaded version against a fresh `/version.json` fetch on
 * `visibilitychange`→visible, `pageshow`, focus, and every five minutes; reloads once on a
 * `release + config_hash` mismatch unless something protected would be lost.
 *
 * Dirty title/description predicates clear only after their latest revision saves;
 * comments stay protected while nonempty. Query mutations and direct fetch uploads
 * are also protected. Once scheduled, the fetch wrapper refuses new writes.
 */
export function useVersionCheck(options: UseVersionCheckOptions = {}): void {
  const mutationCount = useIsMutating();
  const mutationCountRef = useRef(mutationCount);
  mutationCountRef.current = mutationCount;

  const reloader = options.reloader ?? defaultReloader;
  const reloaderRef = useRef(reloader);
  reloaderRef.current = reloader;

  useEffect(() => {
    installMutationAdmission();
    let cancelled = false;
    let drainTimer: ReturnType<typeof setInterval> | null = null;
    let hasReloaded = false;
    let notifiedForTargetKey: string | null = null;

    const isProtected = () =>
      mutationCountRef.current > 0 || inFlightWrites > 0 || hasDirtyEditor();

    function clearDrainTimer() {
      if (drainTimer !== null) {
        clearInterval(drainTimer);
        drainTimer = null;
      }
    }

    function showRecovery() {
      reloadScheduled = true;
      toast.info(i18n.t("common:versionUpdate.pending"), {
        id: "version-update",
        duration: Number.POSITIVE_INFINITY,
        dismissible: false,
        action: {
          label: i18n.t("common:versionUpdate.discardAndReload"),
          onClick: () => {
            if (cancelled || hasReloaded || navigator.onLine === false) return;
            hasReloaded = true;
            clearDrainTimer();
            reloaderRef.current();
          },
        },
      });
    }

    function requireManualRecovery() {
      showRecovery();
      clearDrainTimer();
    }

    function attemptReload(targetKey: string) {
      if (hasReloaded || cancelled) return;
      if (isProtected()) return; // still protected — the drain poller will retry

      const attempts = readAttempts();
      if (attempts === null) {
        // Finding 11: the ledger is unreadable — cannot prove this is bounded, refuse.
        requireManualRecovery();
        return;
      }

      const alreadyTried = attempts.perTarget[targetKey] ?? 0;
      if (
        alreadyTried >= MAX_RELOAD_ATTEMPTS_PER_VERSION ||
        totalAttempts(attempts) >= MAX_TOTAL_RELOAD_ATTEMPTS_PER_SESSION
      ) {
        requireManualRecovery();
        return;
      }

      const wrote = writeAttempts({
        perTarget: { ...attempts.perTarget, [targetKey]: alreadyTried + 1 },
      });
      if (!wrote) {
        // Finding 11: could not persist the bumped count — refuse rather than reload blind.
        requireManualRecovery();
        return;
      }

      hasReloaded = true;
      // Keep admission closed until navigation replaces this document.
      reloadScheduled = true;
      clearDrainTimer();
      reloaderRef.current();
    }

    async function check() {
      if (cancelled || hasReloaded) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false)
        return;

      const loaded = await getLoadedVersion();
      if (!loaded || cancelled) return;

      const latest = await fetchVersionJson();
      if (!latest || cancelled || hasReloaded || navigator.onLine === false)
        return;

      const targetKey = versionKey(latest);
      if (targetKey === versionKey(loaded)) {
        writeAttempts({ perTarget: {} });
        toast.dismiss("version-update");
        // Finding 12: "withdrawn updates" — the server reverted to the version this
        // document already has. Cancel any previously deferred reload rather than leave
        // stale deferred state/drain timer live for a mismatch that no longer exists.
        reloadScheduled = false;
        clearDrainTimer();
        notifiedForTargetKey = null;
        return;
      }

      if (isProtected()) {
        reloadScheduled = true;
        if (notifiedForTargetKey !== targetKey) {
          notifiedForTargetKey = targetKey;
          showRecovery();
        }
        if (drainTimer === null) {
          // Finding 12: re-run the FULL check (fresh fetch) on drain rather than blindly
          // reloading a captured, possibly-stale target — this re-applies the offline
          // guard above and replaces an obsolete target with whatever is current now.
          drainTimer = setInterval(() => {
            void check();
          }, DRAIN_POLL_MS);
        }
        return;
      }

      attemptReload(targetKey);
    }

    void check();

    const onVisibility = () => {
      if (document.visibilityState === "visible") void check();
    };
    const onPageShow = () => void check();
    const onFocus = () => void check();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onFocus);
    const pollInterval = setInterval(() => void check(), CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onFocus);
      clearInterval(pollInterval);
      clearDrainTimer();
      toast.dismiss("version-update");
    };
    // Read through refs so this effect installs its listeners exactly once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
