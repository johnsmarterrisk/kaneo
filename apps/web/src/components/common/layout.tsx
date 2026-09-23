import { useLocation, useNavigate } from "@tanstack/react-router";
import type React from "react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Toaster } from "sonner";
import { AppSidebar } from "@/components/app-sidebar";
import OperonPhoneNavigate from "@/components/common/operon-phone-navigate";
import { DemoAlert } from "@/components/demo-alert";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { isDemoMode } from "@/constants/urls";
import { useUserPreferencesEffects } from "@/hooks/use-user-preferences-effects";
import { cn } from "@/lib/cn";
import { useVersionCheck } from "@/lib/version-check";
import { phoneBackTarget, phoneScreenForPath } from "@/store/phone-nav";
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

/** The phone back arrow and every X (Piece B): one step up the ROUTE, via the router.
    There is deliberately no store, no history entry and no `popstate` listener behind
    this — the screen is derived from the URL (`store/phone-nav.ts`) so a navigation can
    never desync from it, and `Layout` being re-instantiated on every route change (the
    router swaps `WorkspaceLayout`/`ProjectLayout`/`TaskLayout`, each with its own
    `<Layout>`) is harmless because nothing here has to survive that remount. */
export function usePhoneNav(): { goBack: () => void } {
  const navigate = useNavigate();
  const location = useLocation();
  /**
   * The back arrow, and every X, is ONE STEP UP THE ROUTE — a plain router navigation.
   *
   * It used to be `history.back()` paired with a `popstate` listener and seeded entries.
   * On a real iPhone that could loop and hang Safari hard enough to need force-quitting
   * (John, 2026-09-22); headless WebKit never reproduced it. Navigating to the parent
   * route needs no interception at all, and Safari's own Back button then just follows the
   * router's history like it does on any other page.
   */
  const goBack = useCallback(() => {
    const target = phoneBackTarget(location.pathname);
    if ("apex" in target) {
      // The switcher is also statically reachable through Navigate/AppSidebar, so this
      // import is not a bundle split; it only defers resolving the back handler's helper.
      void import("@/components/operon-switcher").then(({ apexUrl }) => {
        window.location.assign(apexUrl());
      });
      return;
    }
    navigate({ to: target.to });
  }, [navigate, location.pathname]);

  return { goBack };
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
      {/* iPhone pass 1, defect 2 (John, real iPhone 2026-09-23): the version stamp used to
          render here, top-right of the phone Work top bar, `absolute`-positioned (the
          `max-md:relative` this header used to carry existed only to host it). It no
          longer renders anywhere on the Work screen — see
          `operon-phone-navigate.tsx`'s own footer for where it lives now. */}
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

  useUserPreferencesEffects();
  // Task 0.6: `Layout` is the highest DECLARED mount point available to this task
  // (`docs/fork-discipline.md` row 2's Stabilization Stage 1 note names `layout.tsx` and
  // `operon-phone-navigate.tsx` only). It is not a true singleton — the router swaps
  // `WorkspaceLayout`/`ProjectLayout`/`TaskLayout`, each with its OWN `<Layout>`, so most
  // navigations remount it and re-arm the check (a fresh `sessionStorage`-bound attempt
  // count survives that, since it lives outside the component; a live "deferred" toast
  // does not, and can repeat on the next navigation while still protected — a UX
  // nit, not a correctness gap).
  useVersionCheck();

  /**
   * THE SCREEN IS THE ROUTE. No store, no history entries, no `popstate` listener, no
   * `traversing` flag — all of which existed only to keep a second copy of this fact in
   * sync with the URL, and which together could loop on real iOS Safari (see
   * `store/phone-nav.ts`). A URL already says which screen belongs on it.
   */
  const isPhoneNavOpen = phoneScreenForPath(location.pathname) === "navigate";

  return (
    <div className="flex w-full bg-background">
      <Toaster position="top-center" />
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
