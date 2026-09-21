import NotificationDropdown from "@/components/notification/notification-dropdown";
import { UserAvatar } from "@/components/user-avatar";
import { useUserWebSocket } from "@/hooks/use-user-websocket";

/**
 * OperonSwitcher — the Operon chrome injected into the Initiative fork (spec R14, task B11).
 *
 * Initiative is one of Operon's four modules, served from a sibling origin
 * (`initiative.operon.<tld>`) rather than from inside the Operon SPA. Without this bar a
 * person who reaches Initiative has no way back to Telegraph except the browser's history,
 * and Initiative looks like a separate product rather than a module of one.
 *
 * ── WHY THE TOKENS AND THE MODULE LIST ARE COPIED, NOT IMPORTED ──────────────────────
 * The source of truth is Operon's `app/src/shell/branding.ts` — `BRANDING_COLORS` and
 * `MODULES`. This fork is a different repository with its own Tailwind build and its own
 * palette, so neither a shared class name nor a shared import is available: a class name
 * would resolve to a different colour on each side, and an import would cross a repository
 * boundary that `docs/fork-discipline.md` exists to keep closed. The values below are
 * therefore REPLICATED, deliberately, as hex — which is exactly the reason `branding.ts`
 * states its colours as hex in the first place. **If a module or a colour changes there,
 * it changes here in the same commit.** Nothing enforces that but this comment.
 *
 * ── WHY THIS COMPONENT ALSO CARRIES NOTIFICATIONS AND THE USER AVATAR ────────────────
 * It replaces `WorkspaceSwitcher` in `app-sidebar.tsx`'s header, and that component was
 * carrying three things besides the workspace dropdown: `useUserWebSocket()` (the
 * user-scoped socket that delivers NOTIFICATION_CREATED), `NotificationDropdown` and
 * `UserAvatar`. R35 says Kaneo's feature set is untouched, so hiding the dropdown must not
 * silently delete notifications or the account menu with it. They are re-mounted here.
 * What is intentionally NOT re-mounted is the workspace dropdown itself, the "add
 * workspace" item and the workspace keyboard shortcuts: per decision 49 Initiative has
 * exactly ONE workspace, created by the first admin's login, so there is nothing to switch
 * between and a second workspace is not a state this deployment should be able to reach.
 */

/**
 * Operon's chrome colours, replicated from `app/src/shell/branding.ts` (`BRANDING_COLORS`).
 * Applied as inline styles rather than Tailwind classes for the reason given above.
 *
 * Re-tinted at the Codex round-1 gate (finding 2): these five values had never moved off
 * the pre-GUI-pass slate hex (`#1e293b`/`#334155`/`#f1f5f9`/`#94a3b8`) while `BRANDING_COLORS`
 * itself was re-tinted to navy/signal-yellow in GUI pass task 2 — so the injected bar kept
 * rendering the OLD chrome regardless of which theme Operon was actually in. Values below
 * are `BRANDING_COLORS`'s CURRENT navy values, copied verbatim (`background`/`surface` are
 * the same hex in navy mode, so one `surface` constant still covers both).
 */
export const OPERON_COLORS = {
  surface: "#081a33",
  surfaceActive: "#f5b700",
  border: "rgba(255, 255, 255, 0.1)",
  textPrimary: "#ffffff",
  textMuted: "rgba(255, 255, 255, 0.7)",
} as const;

export type OperonModuleKey =
  | "telegraph"
  | "initiative"
  | "signals"
  | "settings";

export type OperonModule = {
  key: OperonModuleKey;
  label: string;
  icon: string;
};

/**
 * The four modules, in order, replicated from `MODULES` in `app/src/shell/branding.ts`.
 * Order and labels are part of the contract: the switcher inside Telegraph and this one
 * must offer the same four things in the same sequence, or the shell reads as two products.
 */
export const OPERON_MODULES: readonly OperonModule[] = [
  // STREAM IS FIRST, AND THE POSITION IS THE CONTRACT. Operator decision 2026-09-11 made the
  // activity feed the leading tab; both switchers render their module array in order, so slot
  // one here is the whole of the mirror for `MODULES` in Operon's `app/src/shell/branding.ts`.
  //
  // THE KEY STAYS `signals` AND MUST NOT BE RENAMED — only the label moved (Operon spec R20,
  // D7; task G10 relabelled `MODULES` in `app/src/shell/branding.ts`, G11 mirrors it here).
  // The key is what BOTH switchers dispatch on and what the e2e page objects read as
  // `data-testid="module-signals"`, and the hash route stays `#/activity`, so renaming either
  // would be a cross-repository breaking change bought for nothing: the reader only ever sees
  // the label, and Stream is a relabel rather than a fifth module.
  { key: "signals", label: "Stream", icon: "⚡" },
  { key: "telegraph", label: "Telegraph", icon: "💬" },
  { key: "initiative", label: "Initiative", icon: "📋" },
  { key: "settings", label: "Settings", icon: "⚙️" },
] as const;

/** The module this bar is rendered inside. Everything else lives on the apex. */
const CURRENT_MODULE: OperonModuleKey = "initiative";

/**
 * The dev default, matching `DEV_INITIATIVE_URL`'s sibling in `app/src/shell/branding.ts`:
 * the apex on the local TLS domain family, carrying the `:8443` an unprivileged
 * `OPERON_HTTPS_PORT` needs. Only ever reached when the container was started without
 * `OPERON_APEX_URL`.
 */
export const DEV_APEX_URL = "https://operon.lvh.me:8443";

let apexUrlFallbackWarned = false;

/**
 * The Operon apex origin, read from configuration and never derived (spec R5/R14).
 *
 * WHY IT IS NOT DERIVED FROM `window.location`
 * Stripping the `initiative.` label off the page host would encode the local domain shape
 * into the bundle. In production the pair is `operon.smarterrisk.app` and
 * `initiative.operon.smarterrisk.app`; nothing guarantees that relationship in every
 * environment, and a wrong guess sends a signed-in user to a host that does not exist.
 * `apps/web/.env.production` bakes a placeholder token at image build time and
 * `apps/web/env.sh` replaces it at container start, exactly as `KANEO_API_URL` and
 * `KANEO_CLIENT_URL` are replaced, so the value is runtime-configurable without a rebuild.
 *
 * ── THE CHECK IS A URL PARSE, AND IT HAS TO BE ───────────────────────────────────────
 *
 * The first revision asked "is this string still equal to the placeholder token?" — and
 * that question can never be answered yes after substitution, because `env.sh` runs a
 * global `sed` over every `.js` file in the bundle: it replaces the token in the baked
 * VALUE and in the compiled COMPARISON CONSTANT, in the same pass. Both sides moved
 * together, the strings stayed equal, and a fully configured production deployment took
 * the dev fallback — sending the switcher and every Telegraph link to `lvh.me`. Verified
 * by compiling this module and substituting `https://operon.example.org`, which still
 * returned the local default.
 *
 * A parse has no such twin. An unsubstituted token is not an absolute URL and throws; any
 * value `env.sh` actually wrote is one and does not. The protocol is checked too, so a
 * `javascript:` or `data:` value configured by mistake is refused rather than rendered
 * into an `<a href>`.
 *
 * A missing or unusable value is said out loud rather than swallowed: once, on the
 * console, with the dev default. The message deliberately does not contain the
 * placeholder token — `env.sh`'s `sed` would rewrite that too, and a diagnostic that
 * rewrites itself is worse than none.
 */
export function apexUrl(): string {
  // Read through a widened type: `apps/web/src/vite-env.d.ts` is not on the fork's touch
  // list, so this variable is not declared on `ImportMetaEnv` and must not be added there.
  const configured = (import.meta.env as Record<string, string | undefined>)
    .VITE_OPERON_APEX_URL;
  const trimmed = typeof configured === "string" ? configured.trim() : "";

  if (trimmed !== "") {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return trimmed.replace(/\/+$/, "");
      }
    } catch {
      // Not an absolute URL — the unsubstituted placeholder is the ordinary case.
    }
  }

  if (!apexUrlFallbackWarned) {
    apexUrlFallbackWarned = true;
    console.warn(
      JSON.stringify({
        evt: "operon.apex_url_unset",
        reason:
          "the configured apex is not an absolute http(s) url; it was probably never substituted into the bundle",
        fallback: DEV_APEX_URL,
      }),
    );
  }
  return DEV_APEX_URL;
}

/** Test seam: `apexUrl` warns once per module instance, and suites need that reset. */
export function __resetApexUrlWarning() {
  apexUrlFallbackWarned = false;
}

/**
 * The apex target for a module.
 *
 * The Operon shell keeps the active module in SPA state rather than in the URL, so a module
 * is only addressable once the shell registers a hash route for it. **Stream is the first
 * one that has** — `#/activity` (Operon spec R20/R21/R22, task G10's `app/src/feed/routes.ts`
 * and its narrow `#/activity/...` fallback) — so it is the one case here, and this function
 * stays the single place that changes when the next module gains an address.
 *
 * Every other module still resolves to the apex root, because the shell recognises no
 * `#/telegraph`, `#/settings` or `#/login` hash: the root is the only address they have, and
 * inventing one here would link to a route that does not exist. What the root opens is the
 * shell's own landing decision (G10 makes that Stream), which is deliberately not
 * second-guessed from inside the fork.
 */
function moduleHref(apex: string, key: OperonModuleKey): string {
  if (key === "signals") {
    return `${apex}/#/activity`;
  }
  return `${apex}/`;
}

export function OperonSwitcher() {
  // Re-mounted from `WorkspaceSwitcher`, which no longer renders — see the header comment.
  useUserWebSocket();

  const apex = apexUrl();

  return (
    <div
      data-testid="operon-switcher"
      className="flex w-full flex-col gap-1.5 rounded-md border px-2 py-1.5"
      style={{
        backgroundColor: OPERON_COLORS.surface,
        borderColor: OPERON_COLORS.border,
      }}
    >
      {/*
        TWO ROWS, NOT ONE, AND THAT IS NOT A STYLE PREFERENCE.
        Kaneo's sidebar is 224px wide. Four labelled modules plus the notification bell and
        the avatar on ONE row squeezes every label down to its emoji — observed in the
        browser, not predicted — and a switcher whose labels are invisible is not a
        switcher. The account controls therefore keep the top row, beside the Operon
        wordmark that tells the reader whose chrome this is, and the modules get a
        full-width row of their own that wraps rather than truncates.
      */}
      <div className="flex items-center justify-between gap-2">
        <span
          className="truncate text-xs font-semibold tracking-wide"
          style={{ color: OPERON_COLORS.textPrimary }}
        >
          Operon
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <NotificationDropdown />
          <div className="h-8 w-8 shrink-0">
            <UserAvatar />
          </div>
        </div>
      </div>

      {/*
        `data-module`, `data-external` and `aria-current` are the switcher's contract, copied
        from Operon's own `Sidebar.tsx` so one Playwright page object can read either side.
        `data-external` means "activating this leaves the current origin" — which, inside
        Initiative, is true of every module EXCEPT Initiative itself. That is the mirror
        image of the apex switcher, where Initiative is the only external one.
      */}
      <nav aria-label="Modules" className="flex flex-wrap items-center gap-1">
        {OPERON_MODULES.map((module) => {
          const isCurrent = module.key === CURRENT_MODULE;
          const shared = {
            "data-testid": `module-${module.key}`,
            "data-module": module.key,
            "data-external": isCurrent ? "false" : "true",
            className:
              "whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium no-underline",
          };

          return isCurrent ? (
            <span
              key={module.key}
              {...shared}
              aria-current="page"
              style={{
                backgroundColor: OPERON_COLORS.surfaceActive,
                color: OPERON_COLORS.textPrimary,
              }}
            >
              {module.icon} {module.label}
            </span>
          ) : (
            <a
              key={module.key}
              {...shared}
              href={moduleHref(apex, module.key)}
              // Full white, not `textMuted` (Codex round-2 finding 3): §4a.1 gives the navy
              // ground exactly two ink values — white and signal yellow — and says
              // hierarchy comes from weight and the active module's fill, never dimming.
              // Round 1 already fixed this for Operon's own `Sidebar.tsx` (finding 15); this
              // injected switcher is the mirror of that same rail and had the same bug.
              style={{ color: OPERON_COLORS.textPrimary }}
            >
              {module.icon} {module.label}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
