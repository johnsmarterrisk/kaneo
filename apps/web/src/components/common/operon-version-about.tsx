/**
 * OperonVersionAbout — the read-only "About" block on the account/information settings
 * page (Versioning v1, Operon repo's `docs/specs/versioning-v1-mini-spec.md`, task 8).
 *
 * `OperonVersionStamp`'s rail/footer badge (`operon-switcher.tsx`) shows only `v<release>`
 * now, with the full Operon/Initiative SHAs moved to a hover `title` tooltip — fine for a
 * quick glance, useless the moment a support ticket needs an exact commit pasted from a
 * phone, where nothing hovers. This block is that second, always-visible place: it reads
 * the SAME cached identity `OperonVersionStamp` does (`useLoadedVersionInfo()` — no
 * separate fetch, so the two can never disagree) and renders the release plus both full
 * SHAs as plain, selectable text. Mirrors Operon's own `app/src/settings/AboutVersion.tsx`.
 *
 * Plain English text, not run through `i18n` — the same precedent `OperonVersionStamp`
 * itself already sets (a build identifier is not user-facing copy the localization bundles
 * exist to translate).
 */
import { formatStamp, useLoadedVersionInfo } from "@/lib/version-check";

/** Renders a SHA as-is when it is a real value, or a legible fallback when it is
    empty/unset/`unknown` — never a blank line, which would read as "still loading" rather
    than "not available." Mirrors Operon's own `AboutVersion.tsx#formatSha`. */
function formatSha(sha: string | undefined): string {
  const trimmed = (sha ?? "").trim();
  return trimmed === "" || trimmed.toLowerCase() === "unknown"
    ? "unknown"
    : trimmed;
}

export default function OperonVersionAbout() {
  const info = useLoadedVersionInfo();

  return (
    <div className="space-y-4 border border-border rounded-md p-4 bg-sidebar">
      {/* text-base/text-sidebar-foreground: this card is bg-sidebar (navy) — the title
          had no color class, inheriting body text-foreground (dark navy in light theme,
          invisible on this always-dark-navy card, WALK finding F6, 1.27:1). One step up
          the type scale too (John, 2026-09-28, O2). */}
      <p className="text-base font-medium text-sidebar-foreground">About</p>
      {/* Codex round 1 finding 10: a full 40-character SHA is unbreakable monospace text —
          `flex justify-between` alone let it push past a 375px viewport's right edge rather
          than wrap. Each row now stacks label-over-value below `sm` (a `min-w-0` flex child
          so it CAN shrink at all, `break-all` so a run with no spaces wraps mid-string
          instead of overflowing) and returns to a single inline row at `sm` and up, where
          the value has room beside its label. Mirrors Operon's own `AboutVersion.tsx`. */}
      {/* text-base (John, 2026-09-28, O2: one step up the type scale on every navy
          card); dt/dd below carry text-sidebar-foreground explicitly — the global
          text-muted-foreground token only reaches 2.2:1 (light) / 2.96:1 (navy) against
          this card's bg-sidebar, and dd had no color class at all (same F6 fault as the
          title, on the SHA values). */}
      <dl className="text-base space-y-2" data-testid="about-version">
        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <dt className="text-sidebar-foreground shrink-0">Version</dt>
          <dd
            className="font-mono min-w-0 break-all sm:text-right text-sidebar-foreground"
            data-testid="about-version-release"
          >
            {formatStamp(info)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <dt className="text-sidebar-foreground shrink-0">Operon</dt>
          <dd
            className="font-mono min-w-0 break-all sm:text-right text-sidebar-foreground"
            data-testid="about-version-operon-sha"
          >
            {formatSha(info?.operon_sha)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <dt className="text-sidebar-foreground shrink-0">Initiative</dt>
          <dd
            className="font-mono min-w-0 break-all sm:text-right text-sidebar-foreground"
            data-testid="about-version-fork-sha"
          >
            {formatSha(info?.fork_sha)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
