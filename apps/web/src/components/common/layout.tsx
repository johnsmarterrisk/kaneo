import { useLocation } from "@tanstack/react-router";
import type React from "react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppSidebar } from "@/components/app-sidebar";
import OperonPhoneNavigate from "@/components/common/operon-phone-navigate";
import { DemoAlert } from "@/components/demo-alert";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { isDemoMode } from "@/constants/urls";
import { useUserPreferencesEffects } from "@/hooks/use-user-preferences-effects";
import { cn } from "@/lib/cn";
import { phoneNavOpenForPath, usePhoneNavStore } from "@/store/phone-nav";
import { useUserPreferencesStore } from "@/store/user-preferences";

type LayoutProps = {
  children: ReactNode;
  className?: string;
};

type HeaderProps = {
  children: ReactNode;
  className?: string;
};

type ContentProps = {
  children: ReactNode;
  className?: string;
};

/**
 * A phone/desktop read for `Layout`'s OWN branch decision only — deliberately NOT
 * `@/hooks/use-mobile`'s `useIsMobile()` (manager catch, live-container repro: the shared
 * hook's `useState<boolean | undefined>(undefined)` coerces to `false` for the first
 * render, and only becomes accurate once its own `useEffect` runs a tick later — on a
 * genuinely narrow viewport that one render painted the full DESKTOP chrome, `AppSidebar` +
 * `SidebarInset`'s white card, before flipping to the phone branch, which is exactly the
 * "white frame on the hop" the brief's own success criterion forbids). This hook instead
 * lazy-initialises from `window.innerWidth` — synchronous, correct on the very first
 * render — and only defers to a `matchMedia` listener for LIVE breakpoint crossings
 * afterward. `use-mobile.ts` itself is untouched: every other consumer (`ui/sidebar.tsx`'s
 * own `SidebarProvider`) keeps its existing behaviour, and this is scoped to the one call
 * site that renders two visually unrelated trees off the same flag.
 */
function useSyncedIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 768,
  );

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const onChange = () => setIsMobile(window.innerWidth < 768);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}

/** Returns to the fork's Navigate screen (Piece B) — called by the Work screens' back
    arrow (`workspace-layout.tsx`/`project-layout.tsx`/`task-layout.tsx`, phone width
    only). Backed by `usePhoneNavStore` (a module-level Zustand store, not component
    state or React Context) because `Layout` itself is re-instantiated on every route
    change — the router swaps `WorkspaceLayout`/`ProjectLayout`/`TaskLayout`, each
    wrapping its own `<Layout>` — so state that must survive a navigation cannot live on
    `Layout`'s own instance. See `store/phone-nav.ts`'s own doc comment for the repro. */
export function usePhoneNav(): { openPhoneNav: () => void } {
  /**
   * Codex r2 #1: THE BACK ARROW TRAVERSES HISTORY, it does not push.
   *
   * The round-1 version pushed a Navigate entry ON TOP of the Work entry, which inverted
   * the stack: Navigate then sat above the route it was covering, so the browser's own Back
   * walked into router entries underneath and could close Navigate again or leave the app
   * from what looked like the first screen. Work is the PUSHED state and Navigate is what
   * lies beneath it — the same model `AppShell.tsx` uses on the Operon side — so the arrow
   * is exactly `history.back()` and the `popstate` listener in `Layout` is the only thing
   * that moves the screen. One mechanism, so the arrow, the browser button and the OS
   * gesture cannot disagree.
   */
  const openPhoneNav = useCallback(() => {
    window.history.back();
  }, []);
  return { openPhoneNav };
}

function LayoutHeader({ children, className }: HeaderProps) {
  return (
    <header
      className={cn(
        "flex min-h-16 shrink-0 items-center gap-2 border-b border-border bg-card text-card-foreground px-4 py-2",
        // Phone Work top bar (Piece B, Round 2 mobile-nav brief): 56px, navy ground,
        // no border — the brief's "the bar is the only chrome" bar. `max-md:` overlays
        // rather than replaces the desktop declaration above, so nothing here has to
        // move or be duplicated for md and up; it simply loses to the base rule at
        // 768px and wider, Tailwind's normal cascade order.
        // Codex r1 #9: 56px of CONTENT plus the inset, not 56px including it. Under
        // border-box sizing `h-14` with the inset as padding made the notch eat into the
        // bar, compressing the 44px controls inside it. The inset is now `pt-` ADDED to a
        // fixed-height row, the same correction `MobileWork.tsx` carries on the Operon side.
        "max-md:h-auto max-md:min-h-0 max-md:border-0 max-md:bg-sidebar max-md:text-sidebar-foreground max-md:px-2 max-md:py-0 max-md:pt-[env(safe-area-inset-top)] max-md:[&>*]:h-14",
        className,
      )}
    >
      {children}
    </header>
  );
}

function LayoutContent({ children, className }: ContentProps) {
  return (
    <div
      className={cn(
        "flex-1 min-h-0",
        // Phone Work content (Piece B): "one white panel with radius at the top corners
        // only and no side gutters" — the panel `SidebarInset` gives desktop/tablet via
        // its own `m-3 rounded-lg bg-card` (not rendered at phone width; see `Layout`'s
        // phone branch below), reproduced here so the content itself carries it instead.
        "max-md:rounded-t-2xl max-md:bg-card max-md:text-card-foreground max-md:overflow-y-auto",
        className,
      )}
    >
      <div className="h-full">{children}</div>
    </div>
  );
}

function Layout({ children, className }: LayoutProps) {
  const { sidebarDefaultOpen } = useUserPreferencesStore();
  const isMobile = useSyncedIsMobile();
  const location = useLocation();
  const isPhoneNavOpen = usePhoneNavStore((state) => state.isPhoneNavOpen);
  const closePhoneNav = usePhoneNavStore((state) => state.closePhoneNav);
  const openPhoneNav = usePhoneNavStore((state) => state.openPhoneNav);
  const lastSeenPathname = usePhoneNavStore((state) => state.lastSeenPathname);
  const traversing = usePhoneNavStore((state) => state.traversing);
  const setTraversing = usePhoneNavStore((state) => state.setTraversing);
  const setLastSeenPathname = usePhoneNavStore(
    (state) => state.setLastSeenPathname,
  );

  useUserPreferencesEffects();

  // A route change while on a Work screen means a Navigate-panel row was tapped
  // (`NavMain`/`NavProjects` both `navigate()` internally), which closes Navigate. The
  // FIRST pathname seen is the mount itself, not a navigation, so `lastSeenPathname ===
  // null` guards against closing Navigate on initial load.
  useEffect(() => {
    if (!isMobile) return;
    if (traversing) {
      // This pathname change came from Back/Forward, not from tapping a row: the popstate
      // listener has already set the screen from the entry's own state. The flag is
      // cleared only once the NEW pathname has actually arrived — the traversal and the
      // route change are two renders apart, and a remount sits between them, so clearing
      // it on the first render back would hand the fresh instance an unguarded effect and
      // it would undo the traversal it was supposed to honour.
      if (lastSeenPathname !== location.pathname) {
        setTraversing(false);
        setLastSeenPathname(location.pathname);
      }
      return;
    }
    if (lastSeenPathname !== null && lastSeenPathname !== location.pathname) {
      closePhoneNav();
      // Codex r2 #1: stamp the entry the ROUTER just pushed as Work. The router creates
      // the entry (tapping a row is a real navigation), so the screen flag is added to it
      // rather than pushed as an entry of its own — that is what keeps exactly one entry
      // per Work screen and lets Back/Forward restore the right screen on each.
      const current = (window.history.state ?? {}) as Record<string, unknown>;
      if (current.initiativePhoneScreen !== "work") {
        window.history.replaceState(
          { ...current, initiativePhoneScreen: "work" },
          "",
        );
      }
    }
    if (lastSeenPathname !== location.pathname) {
      setLastSeenPathname(location.pathname);
    }
  }, [
    isMobile,
    location.pathname,
    lastSeenPathname,
    closePhoneNav,
    setLastSeenPathname,
    traversing,
    setTraversing,
  ]);

  /**
   * Codex r2 #1: the screen is DERIVED from the entry the browser moved to.
   *
   * `work` shows Work, anything else shows Navigate — including an entry this shell never
   * stamped, which is the safe direction because Navigate is always reachable and never
   * traps the reader.
   */
  useEffect(() => {
    if (!isMobile) return;
    function onPopState(event: PopStateEvent) {
      // A traversal also changes `location.pathname`, which the route effect below reads.
      // Without this flag that effect treats Back as "a row was tapped", closes Navigate
      // again and re-stamps the entry it just returned to as Work — so Back moved the URL
      // and left the screen exactly where it was. The traversal owns the screen; the route
      // effect must stand down for the render it triggers.
      setTraversing(true);
      const state = event.state as { initiativePhoneScreen?: string } | null;
      if (state?.initiativePhoneScreen === "work") closePhoneNav();
      else openPhoneNav();
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [isMobile, openPhoneNav, closePhoneNav, setTraversing]);

  /**
   * Codex r2 #1: SEED THE STACK ONCE, at the cold mount, so one Back always reaches
   * Navigate.
   *
   * A workspace landing stamps its own entry as Navigate and stops there. A DEEP LINK — a
   * project or task URL arrived at directly, which is every hop from Operon into a specific
   * screen — has no Navigate entry beneath it at all, so Back would leave the document from
   * what the reader experiences as the first screen. Stamping the current entry Navigate and
   * then pushing a Work entry at the SAME url manufactures that missing step: Back lands on
   * Navigate over the same route, and a second Back leaves to the previous document, which
   * is Operon. The url never changes, because Navigate is a screen over the current route
   * rather than a place of its own.
   */
  const seededHistory = useRef(false);
  useEffect(() => {
    if (!isMobile || seededHistory.current) return;
    seededHistory.current = true;
    const current = (window.history.state ?? {}) as Record<string, unknown>;
    if (current.initiativePhoneScreen) return;
    window.history.replaceState(
      { ...current, initiativePhoneScreen: "navigate" },
      "",
    );
    if (!phoneNavOpenForPath(window.location.pathname)) {
      window.history.pushState(
        { ...current, initiativePhoneScreen: "work" },
        "",
      );
    }
  }, [isMobile]);

  return (
    <div className="flex w-full bg-background">
      <SidebarProvider
        defaultOpen={sidebarDefaultOpen}
        style={
          {
            "--sidebar-width": "calc(var(--spacing) * 60)",
            "--header-height": "calc(var(--spacing) * 12)",
          } as React.CSSProperties
        }
      >
        {isMobile ? (
          // Phone: exactly two screens, never both at once (Piece B) — Navigate
          // (`OperonPhoneNavigate`) OR the routed Work screen (`children`), NEVER
          // `<AppSidebar/>`. `AppSidebar` is what mounts `ui/sidebar.tsx`'s `Sidebar`
          // primitive, whose own `if (isMobile) return <Sheet…>` branch is Kaneo's
          // stock mobile drawer — not rendering `AppSidebar` at this width is what
          // suppresses it; `ui/sidebar.tsx` itself is untouched (fork-discipline.md's
          // own note on why explains the `cn()`/`twMerge` reasoning that makes this
          // possible without editing the shared primitive).
          <div
            data-testid="phone-shell"
            className="flex h-[100dvh] w-full overflow-hidden"
          >
            {isPhoneNavOpen ? (
              <OperonPhoneNavigate />
            ) : (
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                {isDemoMode && <DemoAlert />}
                {children}
              </div>
            )}
          </div>
        ) : (
          <>
            <AppSidebar />
            {/*
              Main content is a panel, not the ground (fix brief row 9,
              `docs/specs/operon-gui-pass-fix-brief.md`): `bg-card`/`rounded-lg` (the panel's own
              16px radius in navy, via `--radius`; stock 10px in light/dark, unchanged), the
              brief's own shadow value replacing the border — theme-proposal.md §4a.1: "the
              ground carries no border token... panels on the ground are separated by gap and
              shadow only." `m-3` gives the 12px gutter from the sidebar and the viewport on
              every side. Previously `bg-background border border-border/80`, i.e. the SAME tone
              as the page behind it with only a hairline outline — the exact "blurs together"
              John rejected, because this pane and the ground it sits on were the same surface.
            */}
            <SidebarInset
              className={cn(
                "m-3 flex flex-1 flex-col overflow-auto rounded-lg bg-card text-card-foreground shadow-[0_18px_44px_-20px_rgba(0,0,0,.55),0_1px_2px_rgba(8,26,51,.40)]",
                className,
              )}
            >
              {isDemoMode && <DemoAlert />}
              {children}
            </SidebarInset>
          </>
        )}
      </SidebarProvider>
    </div>
  );
}

Layout.Header = LayoutHeader;
Layout.Content = LayoutContent;

export default Layout;
