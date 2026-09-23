import NotificationDropdown from "@/components/notification/notification-dropdown";
import { useAuth } from "@/components/providers/auth-provider/hooks/use-auth";
import { UserAvatar } from "@/components/user-avatar";
import useSignOut from "@/hooks/mutations/use-sign-out";
import useGetConfig from "@/hooks/queries/config/use-get-config";
import { useUserWebSocket } from "@/hooks/use-user-websocket";
import { useVersionStampText } from "@/lib/version-check";

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
  /** The phone module strip's ACTIVE tile fill (`MobileNavigate.tsx`'s own
      `bg-sidebar-accent/20`, Operon repo, Piece B) — twice `groundAccent10` because a
      tile's icon glyph needs more separation from the ground than a text row's inset bar
      already gives it. */
  groundAccent20: "rgba(255, 255, 255, 0.20)",
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
 * is only addressable once the shell registers a hash route for it.
 *
 * FIXED (John, 2026-09-21 — the rail bug): this used to route Stream alone to `#/activity`
 * and send every OTHER module to the bare apex root with no hash at all, reasoning "the
 * shell recognises no `#/telegraph`/`#/settings`/`#/files` hash, so the root is the only
 * address they have." That reasoning was already half wrong (`#/settings` bare has been
 * recognised since GUI pass task 4a) and it produced the actual defect this fixes: this
 * link is a FULL cross-origin navigation (`window.location.assign` in `AppShell.tsx`'s
 * `activateInitiative`, not an in-SPA click), so every hop away from Initiative is a cold
 * mount on the Operon side — and a cold mount at the bare apex root has no route to read,
 * so `initialModule()` fell through to `LANDING_MODULE` (Stream) regardless of which module
 * was clicked. `app/src/shell/AppShell.tsx`'s `initialModule()` now recognises bare
 * `#/telegraph` and `#/files` for exactly this caller (see its own doc comment), so every
 * module this switcher can link to now has a real address to send it to.
 */
function moduleHref(apex: string, key: OperonModuleKey): string {
  switch (key) {
    case "signals":
      return `${apex}/#/activity`;
    case "telegraph":
      return `${apex}/#/telegraph`;
    case "files":
      return `${apex}/#/files`;
    case "settings":
      return `${apex}/#/settings`;
    default:
      // "initiative" never reaches here: `ModuleRow` renders the current module as a
      // `<span>`, never an `<a>` (see `isCurrent` below), so `moduleHref` is only ever
      // called for the OTHER four keys — this default exists so the switch stays
      // exhaustive if a fifth, still-addressless module ever joins the list.
      return `${apex}/`;
  }
}

/**
 * One module row — shared by both `OperonModuleNav` variants, exactly as `Sidebar.tsx`'s
 * own `renderModule` closure is reused for its two `<nav>`s. 44px minimum height, `text-sm`
 * (15px, this app's own default body size — the shell's own module row uses the SAME
 * Tailwind `text-sm` key, just repainted to 15px by `app/tailwind.config.js`'s fontSize
 * override; this fork has no such override, so 15px is approximated by the stock `text-sm`
 * this codebase already uses everywhere else, rather than inventing an arbitrary size that
 * would be the only one in the file).
 *
 * NO `!justify-start` NEEDED HERE (John, 2026-09-21 rail-parity check) — investigated
 * because the Operon-side rail (`app/src/shell/Sidebar.tsx`'s `renderModule`) DID need one:
 * there, `index.css`'s `@layer base` touch-target rule forces `justify-content: center` on
 * every `<button>`, and Tailwind 3's `@layer` there is source-order convention only (no real
 * CSS cascade layer), so a bare `.justify-start` utility could not outrank the base rule on
 * plain specificity. NEITHER half of that applies here: (1) this row renders `<a>`
 * (`ModuleRow` below) or `<span>` (the current module), never `<button>` — and this fork's
 * own equivalent rule (`index.css`, `@layer base`, "Touch targets") explicitly EXCLUDES
 * `<a>` from its `justify-content: center` clause (TipTap prose links would break otherwise
 * — see that rule's own comment), so no centering is ever forced here in the first place;
 * (2) `shared.className` below sets `flex` but no `justify-*` utility at all, so
 * `justify-content` is the flexbox INITIAL value, `normal` (behaves as `flex-start`) —
 * confirmed against the running stack: `getComputedStyle(...).justifyContent` reads
 * `"normal"` on every rendered row, not `"center"`. Tailwind 4 also compiles `@layer` to
 * REAL CSS cascade layers (unlike Tailwind 3's Operon build), so even if a base-layer rule
 * DID try to force this, Tailwind's `utilities` layer is declared after `base` and would
 * already win on layer order alone — the `!important` workaround the Operon side needed
 * would not even be the right mechanism here. `operon-switcher.test.tsx`'s own "rows stay
 * left-aligned" test guards this staying true.
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
  const versionStamp = useVersionStampText();

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
      {/* Task 0.5: the version stamp, top-right of the desktop rail — the fork's half of
          "in both desktop rails" (Operon's own copy is `Sidebar.tsx`'s `VersionStamp`).
          Placed before the bell/avatar group rather than after: those two are account
          chrome carried over from `WorkspaceSwitcher` (see the file header's note on why
          they still live here), and the stamp is rail-identity chrome, closer in kind to
          the mark and name beside it. */}
      <span
        data-testid="version-stamp"
        className="shrink-0 truncate text-[9px] opacity-60"
        style={{ color: OPERON_COLORS.textPrimary }}
      >
        {versionStamp}
      </span>
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
 * The phone Navigate screen's 64px module strip (Piece B, Round 2 mobile-nav brief) —
 * Discord IMG_2121's server rail, reproduced to match the Operon shell's own
 * `MobileNavigate.tsx` (`app/src/shell/MobileNavigate.tsx`) shape, spacing and tokens: one
 * 48x48 rounded tile per module, Settings pinned to the bottom in its OWN group so a future
 * sixth module scrolls without carrying Settings off the bottom with it.
 *
 * A NEW export rather than a THIRD `OperonModuleNav` variant, because the two render
 * fundamentally different markup (tiles vs. text rows) — but it still reuses everything
 * `OperonModuleNav`/`ModuleRow` already established rather than re-deriving it: the same
 * `OPERON_MODULES` order, the same `moduleHref`/`apexUrl` addressing, the same
 * current-module-is-a-`<span>`-not-an-`<a>` rule, and `OPERON_COLORS` for every colour.
 */
export function OperonPhoneModuleStrip() {
  const apex = apexUrl();
  const appModules = OPERON_MODULES.filter(
    (module) => module.key !== "settings",
  );
  const settingsModule = OPERON_MODULES.find(
    (module) => module.key === "settings",
  );

  const renderTile = (module: OperonModule) => {
    const isCurrent = module.key === CURRENT_MODULE;
    const shared = {
      key: module.key,
      "data-testid": `phone-module-${module.key}`,
      "data-module": module.key,
      "data-external": isCurrent ? "false" : "true",
      "aria-current": isCurrent ? ("page" as const) : undefined,
      "aria-label": module.label,
      className:
        "relative w-12 h-12 shrink-0 flex items-center justify-center rounded-2xl",
    };
    const inner = (
      <>
        {/* The active bar sits OUTSIDE the tile's own rounded box (Discord draws it
            against the strip, not inset into the icon) — a sibling, not a border on the
            tile itself, exactly matching `MobileNavigate.tsx`'s own `renderTile`. */}
        {isCurrent && (
          <span
            aria-hidden="true"
            className="absolute -left-2 top-1/2 -translate-y-1/2 w-1 h-6 rounded-r"
            style={{ backgroundColor: OPERON_COLORS.activeBar }}
          />
        )}
        <span
          aria-hidden="true"
          className="w-12 h-12 flex items-center justify-center rounded-2xl text-xl"
          style={{
            backgroundColor: isCurrent
              ? OPERON_COLORS.groundAccent20
              : OPERON_COLORS.groundAccent10,
          }}
        >
          {module.icon}
        </span>
      </>
    );

    return isCurrent ? (
      <span {...shared}>{inner}</span>
    ) : (
      <a {...shared} href={moduleHref(apex, module.key)}>
        {inner}
      </a>
    );
  };

  return (
    <nav
      aria-label="Modules"
      data-testid="phone-module-strip"
      // iPhone pass 1, defect 3 (John, real iPhone 2026-09-23 — checked on the fork's own
      // phone Navigate strip for the same defect Operon's had, and it was present the same
      // way: this strip carried no top inset of its own, only ever the outer div's, which
      // `operon-phone-navigate.tsx` no longer supplies). `pb-3` keeps `py-3`'s bottom half;
      // the top half folds into the `calc()` rather than competing with a second
      // `padding-top` utility of equal specificity — same reasoning as Operon's own
      // `MobileNavigate.tsx` fix.
      className="w-16 shrink-0 flex flex-col items-center pb-3 pt-[calc(0.75rem_+_env(safe-area-inset-top))] h-full"
      style={{ backgroundColor: OPERON_COLORS.ground }}
    >
      {/* `px-2` on the scrolling group only (`MobileNavigate.tsx`'s own reasoning,
          reproduced verbatim): `overflow-y-auto` makes this box a clipping context on
          BOTH axes, and the active tile's yellow bar is drawn at `-left-2`, OUTSIDE the
          48px tile — without the matching 8px padding the group clips the bar away. */}
      <div
        data-testid="phone-module-strip-apps"
        className="px-2 flex flex-col items-center gap-2 min-h-0 overflow-y-auto"
      >
        {appModules.map(renderTile)}
      </div>
      <div
        data-testid="phone-module-strip-settings"
        className="mt-auto pt-2 pb-[env(safe-area-inset-bottom)] flex flex-col items-center"
      >
        {settingsModule && renderTile(settingsModule)}
      </div>
    </nav>
  );
}

/**
 * The rail's bottom: user name + Sign out, matching `Sidebar.tsx`'s own footer markup
 * (`p-3 border-t`, a plain name span and a button — not `UserAvatar`'s dropdown menu, which
 * hides both behind a click and stays in the header row for that reason).
 *
 * `phone` (default `false`, Piece B): the phone Navigate screen's footer additionally
 * carries a presence dot + "Online" and the notification bell (Discord IMG_2121's footer),
 * which the desktop rail footer never has — those live in `OperonRailHeader` there (see
 * this file's own header comment on why). Kaneo has no connection/presence concept to
 * report — unlike Operon's own relay, which can genuinely be connecting or offline, a
 * signed-in fork session has exactly one state — so "Online" is a static label, not a
 * second data source pretending to be live. Gated on a prop rather than always rendering,
 * so the desktop rail's own test (`OperonRailFooter` with no props) stays byte-identical.
 */
export function OperonRailFooter({ phone = false }: { phone?: boolean } = {}) {
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
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="truncate text-xs"
          style={{ color: OPERON_COLORS.textPrimary }}
        >
          {user?.name ?? ""}
        </span>
        {phone && (
          <span
            data-testid="operon-rail-footer-presence"
            className="flex shrink-0 items-center gap-1 text-[10px]"
            style={{ color: OPERON_COLORS.textPrimary }}
          >
            <span
              aria-hidden="true"
              className="w-1.5 h-1.5 rounded-full bg-success"
            />
            Online
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {phone && (
          <span className="min-w-[44px] min-h-[44px] flex items-center justify-center">
            <NotificationDropdown groundContext />
          </span>
        )}
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
    </div>
  );
}
