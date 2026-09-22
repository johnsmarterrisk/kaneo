import { useIsMutating } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * version-check.ts — the fork's half of the Operon stabilization plan's freshness
 * contract (tasks 0.5/0.6, decision D4; `docs/fork-discipline.md` row 2, Stabilization
 * Stage 1 note). Mirrors `app/src/shell/version.ts` + `useVersionCheck.ts` on the Operon
 * side, folded into ONE file because `docs/fork-discipline.md` declares a single new path
 * here rather than two.
 *
 * WHY THE APP'S "OWN" VERSION IS A FETCH, NOT SOMETHING BAKED INTO THE BUNDLE. This
 * container's config (`KANEO_API_URL`, `KANEO_CLIENT_URL`, `OPERON_APEX_URL`) is
 * substituted into the ALREADY-BUILT bundle by `env.sh` at container start — there is no
 * build-time moment on this side to bake a version into `import.meta.env` the way Vite
 * does on the Operon side. `version.json` (also written by `env.sh`) is therefore the
 * single source of truth on both counts: what this document displays, and what it
 * compares itself against. `getLoadedVersion()` fetches it exactly once per document
 * lifetime and caches the result — a reload is the only thing that resets it, which is
 * exactly the boundary the freshness contract cares about.
 */

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

/**
 * Fetches `/version.json` fresh — `nginx.kaneo.conf`'s `location /` sends
 * `Cache-Control: no-cache` on it (task 0.4), so this always revalidates. Returns `null`
 * on any network failure, a non-200, or a malformed body; callers treat `null` as "cannot
 * tell right now," never as "no update."
 */
export async function fetchVersionJson(): Promise<VersionInfo | null> {
  try {
    const res = await fetch("/version.json", { cache: "no-store" });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isVersionInfo(body) ? body : null;
  } catch {
    return null;
  }
}

let loadedVersionPromise: Promise<VersionInfo | null> | null = null;

/** The version THIS document loaded with — fetched exactly once per document lifetime and
    cached. `resetLoadedVersionForTests()` is the only way to clear it. */
export function getLoadedVersion(): Promise<VersionInfo | null> {
  if (!loadedVersionPromise) {
    loadedVersionPromise = fetchVersionJson();
  }
  return loadedVersionPromise;
}

/** Test-only reset of the module-level cache. */
export function resetLoadedVersionForTests(): void {
  loadedVersionPromise = null;
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

// ─── useVersionCheck — the fork's half of task 0.6's forced-reload hook ──────────────

export const CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const DRAIN_POLL_MS = 5000;
export const MAX_RELOAD_ATTEMPTS_PER_VERSION = 2;
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

interface StoredAttempts {
  key: string;
  count: number;
}

function readAttempts(): StoredAttempts | null {
  try {
    const raw = sessionStorage.getItem(RELOAD_ATTEMPTS_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as StoredAttempts).key === "string" &&
      typeof (parsed as StoredAttempts).count === "number"
    ) {
      return parsed as StoredAttempts;
    }
    return null;
  } catch {
    return null;
  }
}

function writeAttempts(entry: StoredAttempts): void {
  try {
    sessionStorage.setItem(RELOAD_ATTEMPTS_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Best-effort bookkeeping — must never block the reload it is trying to bound.
  }
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
 * PROTECTED STATE, FORK SIDE (plan row 0.6): "an open task/comment editor with unsaved
 * text OR an upload in flight." `useIsMutating()` (TanStack Query, already the fork's data
 * layer for every write — uploads included) is read with NO additional wiring: it is
 * non-zero for exactly as long as any mutation, upload or otherwise, is in flight. THE
 * "OPEN EDITOR WITH UNSAVED TEXT" HALF IS NOT WIRED — that would mean touching
 * `comment-input.tsx`, `task-title.tsx` and the task detail editors, none of which
 * `docs/fork-discipline.md` row 2's Stabilization Stage 1 note declares for this task, and
 * fork-discipline treats an undeclared path as a defect. Filed as an open item rather than
 * guessed at; a caller can still cover it by passing its own signal into a future version
 * of this hook without changing the contract here.
 */
export function useVersionCheck(options: UseVersionCheckOptions = {}): void {
  const mutationCount = useIsMutating();
  const mutationCountRef = useRef(mutationCount);
  mutationCountRef.current = mutationCount;

  const reloader = options.reloader ?? defaultReloader;
  const reloaderRef = useRef(reloader);
  reloaderRef.current = reloader;

  useEffect(() => {
    let cancelled = false;
    let drainTimer: ReturnType<typeof setInterval> | null = null;
    let hasReloaded = false;
    let notifiedForTargetKey: string | null = null;

    const isProtected = () => mutationCountRef.current > 0;

    function clearDrainTimer() {
      if (drainTimer !== null) {
        clearInterval(drainTimer);
        drainTimer = null;
      }
    }

    function attemptReload(targetKey: string) {
      if (hasReloaded || cancelled) return;
      if (isProtected()) return; // still protected — the drain poller will retry

      const attempts = readAttempts();
      const alreadyTried =
        attempts && attempts.key === targetKey ? attempts.count : 0;
      if (alreadyTried >= MAX_RELOAD_ATTEMPTS_PER_VERSION) {
        reloadScheduled = false;
        clearDrainTimer();
        return;
      }

      writeAttempts({ key: targetKey, count: alreadyTried + 1 });
      hasReloaded = true;
      reloadScheduled = false;
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
      if (!latest || cancelled) return;

      const targetKey = versionKey(latest);
      if (targetKey === versionKey(loaded)) return;

      if (isProtected()) {
        reloadScheduled = true;
        if (notifiedForTargetKey !== targetKey) {
          notifiedForTargetKey = targetKey;
          toast.info(
            "A new version is available. It will load once nothing here is in progress.",
          );
        }
        if (drainTimer === null) {
          drainTimer = setInterval(() => {
            if (!isProtected()) attemptReload(targetKey);
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
    };
    // Read through refs so this effect installs its listeners exactly once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
