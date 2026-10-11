import { useLocation, useNavigate } from "@tanstack/react-router";
import type React from "react";
import { apexUrl } from "@/components/operon-switcher";
import { cn } from "@/lib/cn";
import {
  type BottomTab,
  bottomTabForPath,
  requestTablesAnchor,
  TABLES_ANCHOR_ID,
  takeTablesAnchor,
  workspaceIdForPath,
} from "@/store/phone-nav";

/**
 * Operon fork addition (Tables task 15, spec 7.11, John's ruling Q2 and R-I; closes Operon
 * open-items 53; docs/fork-discipline.md row 18): the phone bottom tab bar. ONE navigation
 * model across Operon and Initiative — the same four labels, in the same order and the same
 * place, as Operon's `app/src/shell/BottomTabBar.tsx`, so a person moving between Telegraph
 * and Initiative sees one bar.
 *
 * Targets: Telegraph → Operon's Telegraph Navigate list; Initiative → this workspace's
 * project list; Tables → that list at its Tables section; More → Operon's Navigate screen
 * (the module strip). More and Telegraph share an address on purpose: Operon's Navigate
 * screen seeds on Telegraph's list, and a bare apex lands on Stream's Work screen instead —
 * there is no other address for "Navigate" that a cold phone load honours.
 *
 * Mounted by `layout.tsx`'s phone branch below both screens, never inside one; it carries
 * the home-indicator inset because it is the frame's bottom-most element.
 */
export const OPERON_BOTTOM_TABS: ReadonlyArray<{
  key: BottomTab;
  label: string;
  icon: string;
}> = [
  { key: "telegraph", label: "Telegraph", icon: "💬" },
  { key: "initiative", label: "Initiative", icon: "📋" },
  { key: "tables", label: "Tables", icon: "▦" },
  { key: "more", label: "More", icon: "⋯" },
];

function scrollToTables(): boolean {
  const section = document.getElementById(TABLES_ANCHOR_ID);
  if (!section) return false;
  section.scrollIntoView({ block: "start" });
  return true;
}

export default function OperonBottomTabs() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = bottomTabForPath(pathname);
  const workspaceId = workspaceIdForPath(pathname);
  const apex = apexUrl();
  const listPath = workspaceId
    ? `/dashboard/workspace/${workspaceId}`
    : "/dashboard";

  const hrefFor = (key: BottomTab) => {
    switch (key) {
      case "telegraph":
      case "more":
        return `${apex}/#/telegraph`;
      case "initiative":
        return listPath;
      case "tables":
        return `${listPath}#${TABLES_ANCHOR_ID}`;
    }
  };

  const onInternal = (key: BottomTab) => (event: React.MouseEvent) => {
    event.preventDefault();
    if (key === "tables") {
      requestTablesAnchor();
      // Already on the list: the section is mounted, so scroll now rather than wait for a
      // remount that a same-route navigation never causes.
      if (pathname.replace(/\/$/, "") === listPath && scrollToTables()) {
        takeTablesAnchor();
      }
    }
    const hash = key === "tables" ? TABLES_ANCHOR_ID : undefined;
    if (workspaceId) {
      navigate({
        to: "/dashboard/workspace/$workspaceId",
        params: { workspaceId },
        hash,
      });
    } else {
      navigate({ to: "/dashboard", hash });
    }
  };

  return (
    <nav
      aria-label="Tabs"
      data-testid="operon-bottom-tabs"
      className="flex shrink-0 border-t border-sidebar-border/10 bg-sidebar text-sidebar-foreground pb-[env(safe-area-inset-bottom)]"
    >
      {OPERON_BOTTOM_TABS.map((tab) => {
        // Telegraph and More live on the apex; Initiative's screens mark Initiative or Tables.
        const isActive = tab.key === active;
        const internal = tab.key === "initiative" || tab.key === "tables";
        return (
          <a
            key={tab.key}
            href={hrefFor(tab.key)}
            data-testid={`bottom-tab-${tab.key}`}
            aria-current={isActive ? "page" : undefined}
            onClick={internal ? onInternal(tab.key) : undefined}
            className={cn(
              "flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[11px] no-underline",
              isActive
                ? "font-semibold text-sidebar-foreground"
                : "text-sidebar-foreground/60",
            )}
          >
            <span aria-hidden="true" className="text-base leading-none">
              {tab.icon}
            </span>
            <span className="truncate">{tab.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
