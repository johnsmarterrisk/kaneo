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
      <p className="text-sm font-medium">About</p>
      <dl className="text-sm space-y-1" data-testid="about-version">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Version</dt>
          <dd className="font-mono" data-testid="about-version-release">
            {formatStamp(info)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Operon</dt>
          <dd className="font-mono" data-testid="about-version-operon-sha">
            {formatSha(info?.operon_sha)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Initiative</dt>
          <dd className="font-mono" data-testid="about-version-fork-sha">
            {formatSha(info?.fork_sha)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
