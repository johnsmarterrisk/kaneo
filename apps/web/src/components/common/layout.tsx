import { useLocation } from "@tanstack/react-router";
import type React from "react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppSidebar } from "@/components/app-sidebar";
import OperonPhoneNavigate from "@/components/common/operon-phone-navigate";
import { DemoAlert } from "@/components/demo-alert";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { isDemoMode } from "@/constants/urls";
import { useIsMobile } from "@/hooks/use-mobile";
import { useUserPreferencesEffects } from "@/hooks/use-user-preferences-effects";
import { cn } from "@/lib/cn";
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

type PhoneNavContextValue = {
  /** Returns to the fork's Navigate screen (Piece B) — called by the Work screens' back
      arrow (`workspace-layout.tsx`/`project-layout.tsx`/`task-layout.tsx`, phone width
      only). `null` outside a phone-width render, so a caller must check `isMobile` itself
      before using it rather than relying on this ever being non-null on desktop/tablet. */
  openPhoneNav: () => void;
};

const PhoneNavContext = createContext<PhoneNavContextValue | null>(null);

/** See `PhoneNavContextValue`'s own doc comment. */
export function usePhoneNav(): PhoneNavContextValue | null {
  return useContext(PhoneNavContext);
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
        "max-md:h-14 max-md:min-h-0 max-md:border-0 max-md:bg-sidebar max-md:text-sidebar-foreground max-md:px-2 max-md:py-0",
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
  const isMobile = useIsMobile();
  const location = useLocation();

  useUserPreferencesEffects();

  // Piece B's two-screen model has no route of its own — Navigate is a SCREEN STATE, not
  // a URL, because every Work screen underneath it (project list, board, task detail) is
  // already a real Kaneo route with its own data fetching. Landing state is Navigate
  // (`true`); a route change while on a Work screen means a Navigate-panel row was tapped
  // (`NavMain`/`NavProjects` both `navigate()` internally, see their own files) and never
  // needs a second signal to close Navigate — watching `location.pathname` catches every
  // caller at once instead of threading an `onNavigate` callback through both. The FIRST
  // pathname seen is the mount itself, not a navigation, so the ref guards against closing
  // Navigate on initial load.
  const [showPhoneNav, setShowPhoneNav] = useState(true);
  const previousPathnameRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isMobile) return;
    if (
      previousPathnameRef.current !== null &&
      previousPathnameRef.current !== location.pathname
    ) {
      setShowPhoneNav(false);
    }
    previousPathnameRef.current = location.pathname;
  }, [isMobile, location.pathname]);

  const phoneNavValue = useMemo<PhoneNavContextValue>(
    () => ({ openPhoneNav: () => setShowPhoneNav(true) }),
    [],
  );

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
        <PhoneNavContext.Provider value={phoneNavValue}>
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
              {showPhoneNav ? (
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
        </PhoneNavContext.Provider>
      </SidebarProvider>
    </div>
  );
}

Layout.Header = LayoutHeader;
Layout.Content = LayoutContent;

export default Layout;
