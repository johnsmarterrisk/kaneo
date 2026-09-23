import type * as React from "react";

import { NavMain } from "@/components/nav-main";
import { NavProjects } from "@/components/nav-projects";
import {
  OperonModuleNav,
  OperonRailFooter,
  OperonRailHeader,
  OperonVersionStamp,
} from "@/components/operon-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  useSidebar,
} from "@/components/ui/sidebar";
import { shortcuts } from "@/constants/shortcuts";
import { useRegisterShortcuts } from "@/hooks/use-keyboard-shortcuts";
import Search from "./search";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { toggleSidebar } = useSidebar();

  useRegisterShortcuts({
    modifierShortcuts: {
      [shortcuts.sidebar.prefix]: {
        [shortcuts.sidebar.toggle]: toggleSidebar,
      },
    },
  });

  return (
    <Sidebar
      collapsible="offcanvas"
      variant="inset"
      className="border-none p-0"
      {...props}
    >
      {/*
        Operon rail (spec R14, task B11; rebuilt John 2026-09-21 — this whole rail IS the
        Operon shell's `Sidebar.tsx`, not a switcher living inside Kaneo's own chrome).
        `SidebarHeader`/`SidebarContent`/`SidebarFooter` are the three fixed slots the
        upstream `Sidebar` primitive already offers (header and footer do not scroll,
        content does), which map onto the shell's own three tiers one for one: mark + module
        nav (fixed top), Kaneo's own per-module list (scrollable middle, RESTYLED to match
        Telegraph's channel-list section but not restructured — see `nav-main.tsx` and
        `nav-projects.tsx`), Settings + user footer (fixed bottom). `p-0` on `Sidebar`
        itself (was `pt-1.5`): the ground has no gutter of its own in the shell either.
      */}
      <SidebarHeader className="gap-0 p-0">
        <OperonRailHeader />
        <OperonModuleNav variant="top" />
      </SidebarHeader>
      <SidebarContent className="overflow-hidden gap-1 py-1">
        <Search />
        <NavMain />
        <NavProjects />
      </SidebarContent>
      <SidebarFooter className="gap-0 p-0">
        {/* iPhone pass 1, defect 4: the version stamp, directly above Settings — see
            `operon-switcher.tsx`'s own doc comment on `OperonVersionStamp`. */}
        <div className="px-4 pb-1.5">
          <OperonVersionStamp />
        </div>
        <OperonModuleNav variant="settings" />
        <OperonRailFooter />
      </SidebarFooter>
    </Sidebar>
  );
}
