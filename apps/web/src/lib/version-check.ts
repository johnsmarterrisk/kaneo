import { useEffect, useState } from "react";

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
