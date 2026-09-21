import type * as React from "react";

import { NavMain } from "@/components/nav-main";
import { NavProjects } from "@/components/nav-projects";
import { OperonSwitcher } from "@/components/operon-switcher";
import { TrialCard } from "@/components/trial-card";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  useSidebar,
} from "@/components/ui/sidebar";
import { VersionDisplay } from "@/components/version-display";
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
      className="border-none pt-1.5"
      {...props}
    >
      {/*
        Operon chrome (spec R14, task B11). `OperonSwitcher` stands where
        `WorkspaceSwitcher` stood: the header slot is unchanged and the sidebar below it is
        not restructured, so every upstream surface underneath is untouched (R35). The
        workspace dropdown is gone because Initiative has exactly one workspace by design
        (decision 49); the notification bell, the user avatar and the user-scoped WebSocket
        that dropdown also owned are re-mounted inside `OperonSwitcher` rather than lost.
      */}
      <SidebarHeader className="pt-1 pb-1.5">
        <OperonSwitcher />
      </SidebarHeader>
      <SidebarContent className="overflow-hidden gap-1 py-1">
        <Search />
        <NavMain />
        <NavProjects />
      </SidebarContent>
      <SidebarFooter>
        <TrialCard />
        {/*
          Operon mode (Codex round-1 finding 11, manager ruling): NO independent theme
          control here. `ThemeToggleDropdown` used to update `useUserPreferencesStore`
          on its own, diverging from whatever Operon's Settings -> Theme switch had just
          set the `operon_theme` cookie to — Operon Settings is the single control, and
          the cookie handoff (GUI pass task 4b, `providers/theme-provider/index.tsx`) is
          deliberately one-way, read once on arrival, not synced back from here.
        */}
        <div className="flex items-center justify-end">
          <VersionDisplay />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
