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
 */
export const OPERON_COLORS = {
  surface: "#1e293b",
  surfaceActive: "#334155",
  border: "#334155",
  textPrimary: "#f1f5f9",
  textMuted: "#94a3b8",
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
  { key: "telegraph", label: "Telegraph", icon: "💬" },
  { key: "initiative", label: "Initiative", icon: "📋" },
  { key: "signals", label: "Signals", icon: "📡" },
  { key: "settings", label: "Settings", icon: "⚙️" },
] as const;

/** The module this bar is rendered inside. Everything else lives on the apex. */
const CURRENT_MODULE: OperonModuleKey = "initiative";

/**
 * The literal `apps/web/env.sh` substitutes at container start. It survives in the bundle
 * only when `OPERON_APEX_URL` was left unset, and it is not a URL — so it is treated as
 * "unconfigured" rather than navigated to.
 */
const APEX_URL_PLACEHOLDER = "OPERON_APEX_URL";

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
 * `VITE_OPERON_APEX_URL` is baked as a placeholder at image build time and replaced by
 * `apps/web/env.sh` at container start, exactly as `KANEO_API_URL` and `KANEO_CLIENT_URL`
 * are, so the value is runtime-configurable without a rebuild.
 *
 * A missing value is said out loud rather than swallowed: an unconfigured deployment gets
 * a console warning naming the variable, once, and the dev default.
 */
export function apexUrl(): string {
  // Read through a widened type: `apps/web/src/vite-env.d.ts` is not on the fork's touch
  // list, so this variable is not declared on `ImportMetaEnv` and must not be added there.
  const configured = (import.meta.env as Record<string, string | undefined>)
    .VITE_OPERON_APEX_URL;

  if (
    typeof configured === "string" &&
    configured.trim() !== "" &&
    configured.trim() !== APEX_URL_PLACEHOLDER
  ) {
    return configured.trim().replace(/\/+$/, "");
  }

  if (!apexUrlFallbackWarned) {
    apexUrlFallbackWarned = true;
    console.warn(
      JSON.stringify({
        evt: "operon.apex_url_unset",
        reason: "OPERON_APEX_URL was not substituted into the bundle",
        fallback: DEV_APEX_URL,
      }),
    );
  }
  return DEV_APEX_URL;
}

/**
 * The apex target for a module.
 *
 * The Operon shell keeps the active module in SPA state rather than in the URL — verified
 * in `app/src/shell/AppShell.tsx`, whose only hash routes are `#/login` and
 * `#/telegraph/msg/<event id>` — so there is no per-module address to link to and every
 * apex module resolves to the apex root, which opens on Telegraph. That is honest for
 * Telegraph, which is what R14 requires and what the walk proves; Signals and Settings are
 * one click further once the shell gains addresses for them, and this function is the
 * single place that changes when it does.
 */
function moduleHref(apex: string, _key: OperonModuleKey): string {
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
              style={{ color: OPERON_COLORS.textMuted }}
            >
              {module.icon} {module.label}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
