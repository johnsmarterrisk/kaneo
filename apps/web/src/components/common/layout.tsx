import type React from "react";
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { DemoAlert } from "@/components/demo-alert";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { isDemoMode } from "@/constants/urls";
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

function LayoutHeader({ children, className }: HeaderProps) {
  return (
    <header
      className={cn(
        "flex h-10 shrink-0 gap-2 transition-[width,height] ease-in-out group-has-[[data-collapsible=icon]]/sidebar-wrapper:h-8 border-b border-border bg-card p-2",
        className,
      )}
    >
      {children}
    </header>
  );
}

function LayoutContent({ children, className }: ContentProps) {
  return (
    <div className={cn("flex-1 min-h-0", className)}>
      <div className="h-full">{children}</div>
    </div>
  );
}

function Layout({ children, className }: LayoutProps) {
  const { sidebarDefaultOpen } = useUserPreferencesStore();

  useUserPreferencesEffects();

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
      </SidebarProvider>
    </div>
  );
}

Layout.Header = LayoutHeader;
Layout.Content = LayoutContent;

export default Layout;
