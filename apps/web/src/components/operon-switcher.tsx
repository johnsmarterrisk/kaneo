import NotificationDropdown from "@/components/notification/notification-dropdown";
import { useAuth } from "@/components/providers/auth-provider/hooks/use-auth";
import { UserAvatar } from "@/components/user-avatar";
import useSignOut from "@/hooks/mutations/use-sign-out";
import useGetConfig from "@/hooks/queries/config/use-get-config";
import { useUserWebSocket } from "@/hooks/use-user-websocket";

/**
 * operon-switcher.tsx — the Operon rail chrome injected into the Initiative fork (spec
 * R14, task B11; rebuilt per the fix brief's rail-parity ask, John 2026-09-21: "the
 * Initiative sidebar must be the OPERON RAIL, not Kaneo's sidebar with a switcher block").
 *
 * The original B11 switcher was a small bordered box inside Kaneo's OWN sidebar header,
 * with the module list wrapping onto a second row. John's ask replaces that shape
 * entirely: the top of this rail — mark, product name, module list — IS the shell's own
 * `Sidebar.tsx` rail, reproduced row for row (height, font, spacing, the active module's
 * `rgba(255,255,255,.10)` fill + inset 3px yellow bar), not a switcher living inside a
 * visually distinct Kaneo chrome. Three pieces are exported and composed by
 * `app-sidebar.tsx`, because the shell's OWN rail also has three tiers — the module nav at
 * the top, the per-module list in the middle (Kaneo's own nav, here), and a Settings row +
 * user footer at the bottom (`Sidebar.tsx`'s own `<nav aria-label="Settings">` and
 * `p-3 border-t` footer) — and Settings has to land in the BOTTOM tier, not inside the top
 * module list, to match:
 *
 *  - `OperonRailHeader` — the mark + "Operon" + the notification bell/avatar (see the note
 *    on WHY THOSE TWO STILL LIVE HERE, below).
 *  - `OperonModuleNav` — the vertical module list, filtered by `variant` so the same
 *    row-rendering code produces BOTH the top nav (every module except Settings) and the
 *    bottom Settings-only row, exactly as `Sidebar.tsx`'s own `renderModule` is reused for
 *    both of ITS `<nav>`s.
 *  - `OperonRailFooter` — user name + Sign out, matching `Sidebar.tsx`'s own footer
 *    markup (a plain name span and a button, not a menu).
 *
 * ── WHY THE TOKENS AND THE MODULE LIST ARE COPIED, NOT IMPORTED ──────────────────────
 * The source of truth is Operon's `app/src/shell/branding.ts` — `BRANDING_COLORS` and
 * `MODULES`. This fork is a different repository with its own Tailwind build and its own
 * palette, so neither a shared class name nor a shared import is available: a class name
 * would resolve to a different colour on each side, and an import would cross a repository
 * boundary that `docs/fork-discipline.md` exists to keep closed. The values below are
 * therefore REPLICATED, deliberately, as hex. **If a module or a colour changes there, it
 * changes here in the same commit.** Nothing enforces that but this comment.
 *
 * ── WHY THE HEADER STILL CARRIES NOTIFICATIONS AND THE USER AVATAR ───────────────────
 * `Sidebar.tsx`'s own header row is JUST the mark, the name and a relay-status dot — no
 * notification bell, no avatar — because Operon has no equivalent chrome anywhere else in
 * the shell for them either. But `useUserWebSocket()` (the user-scoped socket that
 * delivers NOTIFICATION_CREATED), `NotificationDropdown` and `UserAvatar` came from
 * `WorkspaceSwitcher`, the component this file originally replaced, and R35 says Kaneo's
 * feature set stays intact: hiding the workspace dropdown must not silently delete
 * notifications or the account menu with it. There is no slot in the new three-tier design
 * that is a closer match than the header row, so they stay here, compact, trailing the
 * wordmark — an intentional, minimal departure from `Sidebar.tsx`'s own header, not an
 * oversight.
 */

/**
 * Operon's chrome colours, replicated from `app/src/shell/branding.ts` (`BRANDING_COLORS`)
 * and `app/src/index.css`'s `.navy` block (the two ground-relative rgba values, which
 * `branding.ts` does not carry because Operon itself expresses them as Tailwind opacity
 * modifiers — `bg-sidebar-accent/10` — not as flat hex).
 */
export const OPERON_COLORS = {
  ground: "#081a33",
  /** The active module's fill — `Sidebar.tsx`'s `hover:bg-sidebar-accent/10` and the
      mockup's own `rgba(255,255,255,.10)` active-row spec (theme-proposal.md, fix brief
      panel-anatomy section) are the SAME value; one constant covers both. */
  groundAccent10: "rgba(255, 255, 255, 0.10)",
  activeBar: "#f5b700",
  border: "rgba(255, 255, 255, 0.1)",
  textPrimary: "#ffffff",
} as const;

export type OperonModuleKey =
  | "telegraph"
  | "initiative"
  | "signals"
  | "settings"
  | "files";

export type OperonModule = {
  key: OperonModuleKey;
  label: string;
  icon: string;
};

/**
 * The five modules, in order, replicated from `MODULES` in `app/src/shell/branding.ts`.
 *
 * Widened to FIVE (John, GUI-pass fix): this list had drifted to four, missing `files`
 * (Stash, `branding.ts` decision 0) entirely — a real staleness this rebuild surfaces and
 * fixes, not something the fix brief asked for by name, but the same "both switchers offer
 * the same modules in the same order" contract this file's own header comment already
 * states demands it. `OperonModuleNav`'s `variant` prop is what keeps Settings out of the
 * top list and in its own bottom row, matching `Sidebar.tsx`'s two separate `<nav>`s.
 */
export const OPERON_MODULES: readonly OperonModule[] = [
  { key: "signals", label: "Stream", icon: "⚡" },
  { key: "telegraph", label: "Telegraph", icon: "💬" },
  { key: "initiative", label: "Initiative", icon: "📋" },
  { key: "files", label: "Stash", icon: "📁" },
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
 * `#/telegraph`, `#/settings`, `#/files` or `#/login` hash: the root is the only address
 * they have, and inventing one here would link to a route that does not exist. What the
 * root opens is the shell's own landing decision (G10 makes that Stream), which is
 * deliberately not second-guessed from inside the fork.
 */
function moduleHref(apex: string, key: OperonModuleKey): string {
  if (key === "signals") {
    return `${apex}/#/activity`;
  }
  return `${apex}/`;
}

/**
 * One module row — shared by both `OperonModuleNav` variants, exactly as `Sidebar.tsx`'s
 * own `renderModule` closure is reused for its two `<nav>`s. 44px minimum height, `text-sm`
 * (15px, this app's own default body size — the shell's own module row uses the SAME
 * Tailwind `text-sm` key, just repainted to 15px by `app/tailwind.config.js`'s fontSize
 * override; this fork has no such override, so 15px is approximated by the stock `text-sm`
 * this codebase already uses everywhere else, rather than inventing an arbitrary size that
 * would be the only one in the file).
 */
function ModuleRow({ module, apex }: { module: OperonModule; apex: string }) {
  const isCurrent = module.key === CURRENT_MODULE;
  const shared = {
    "data-testid": `module-${module.key}`,
    "data-module": module.key,
    "data-external": isCurrent ? "false" : "true",
    className:
      "flex min-h-[44px] w-full items-center rounded px-3 py-1.5 text-sm no-underline",
  };
  const style = {
    color: OPERON_COLORS.textPrimary,
    backgroundColor: isCurrent ? OPERON_COLORS.groundAccent10 : "transparent",
    boxShadow: isCurrent
      ? `inset 3px 0 0 0 ${OPERON_COLORS.activeBar}`
      : "none",
    fontWeight: isCurrent ? 600 : 500,
  };

  return isCurrent ? (
    <span key={module.key} {...shared} aria-current="page" style={style}>
      {module.icon} {module.label}
    </span>
  ) : (
    <a
      key={module.key}
      {...shared}
      href={moduleHref(apex, module.key)}
      style={style}
    >
      {module.icon} {module.label}
    </a>
  );
}

/**
 * The rail's top: mark, "Operon", the notification bell and avatar — matching
 * `Sidebar.tsx`'s `h-12 px-4 flex items-center` header row's height and padding. The mark
 * is an inline SVG (navy rounded square, signal-yellow "O") rather than a reference to
 * `public/logo-dark.svg`/`favicon.svg`: those two assets are still the pre-Operon
 * slate/sky "Initiative" mark (never re-tinted — a real staleness, out of scope for this
 * rail rebuild, which only needs the mark's SHAPE to match `app/public/operon.svg`, not to
 * fix every branding asset in the same commit).
 */
export function OperonRailHeader() {
  // Re-mounted from `WorkspaceSwitcher`, which no longer renders — see the file header.
  useUserWebSocket();

  return (
    <div
      data-testid="operon-rail-header"
      className="flex h-12 w-full items-center gap-2 px-3"
      style={{ backgroundColor: OPERON_COLORS.ground }}
    >
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 32 32"
        className="shrink-0"
      >
        <rect width="32" height="32" rx="6" fill="#081a33" />
        <text
          x="50%"
          y="55%"
          dominantBaseline="middle"
          textAnchor="middle"
          fontSize="18"
          fill="#f5b700"
          fontFamily="system-ui"
        >
          O
        </text>
      </svg>
      <h1
        className="flex-1 truncate text-sm font-bold"
        style={{ color: OPERON_COLORS.textPrimary }}
      >
        Operon
      </h1>
      <div className="flex shrink-0 items-center gap-1">
        {/* `groundContext` (John, fix brief): this header sits directly on the navy
            ground, not a white card — the bell was invisible at rest because the ghost
            Button variant's default `text-card-foreground` is navy ink, correct on a
            card, navy-on-navy here. See NotificationDropdownProps' doc comment. */}
        <NotificationDropdown groundContext />
        <div className="h-8 w-8 shrink-0">
          <UserAvatar />
        </div>
      </div>
    </div>
  );
}

/**
 * The module nav — `variant="top"` renders every module except Settings (`Sidebar.tsx`'s
 * `MODULES.filter(m => m.key !== 'settings')`); `variant="settings"` renders only Settings
 * (`Sidebar.tsx`'s second `<nav aria-label="Settings">`, anchored just above the footer).
 */
export function OperonModuleNav({ variant }: { variant: "top" | "settings" }) {
  const apex = apexUrl();
  const modules = OPERON_MODULES.filter((module) =>
    variant === "settings"
      ? module.key === "settings"
      : module.key !== "settings",
  );

  return (
    <nav
      aria-label={variant === "settings" ? "Settings" : "Modules"}
      data-testid={
        variant === "settings" ? "operon-settings-nav" : "operon-module-nav"
      }
      className="flex w-full flex-col gap-1 px-2 py-3"
      style={{ backgroundColor: OPERON_COLORS.ground }}
    >
      {modules.map((module) => (
        <ModuleRow key={module.key} module={module} apex={apex} />
      ))}
    </nav>
  );
}

/**
 * The rail's bottom: user name + Sign out, matching `Sidebar.tsx`'s own footer markup
 * (`p-3 border-t`, a plain name span and a button — not `UserAvatar`'s dropdown menu, which
 * hides both behind a click and stays in the header row for that reason).
 */
export function OperonRailFooter() {
  const { user } = useAuth();
  const { data: config } = useGetConfig();
  const { mutateAsync: signOut } = useSignOut(config?.customOAuthLogoutUrl);

  return (
    <div
      data-testid="operon-rail-footer"
      className="flex w-full items-center justify-between border-t p-3"
      style={{
        backgroundColor: OPERON_COLORS.ground,
        borderColor: OPERON_COLORS.border,
      }}
    >
      <span
        className="truncate text-xs"
        style={{ color: OPERON_COLORS.textPrimary }}
      >
        {user?.name ?? ""}
      </span>
      <button
        type="button"
        onClick={() => {
          void signOut();
        }}
        className="min-h-[44px] rounded px-2 text-xs"
        style={{ color: OPERON_COLORS.textPrimary }}
      >
        Sign out
      </button>
    </div>
  );
}
