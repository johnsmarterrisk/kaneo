"use client";

import { SearchIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import SearchCommandMenu from "@/components/search-command-menu";
import { SidebarGroup } from "@/components/ui/sidebar";
import { shortcuts } from "@/constants/shortcuts";
import { useRegisterShortcuts } from "@/hooks/use-keyboard-shortcuts";

export default function Search() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  useRegisterShortcuts({
    shortcuts: {
      [shortcuts.search.prefix]: () => {
        setOpen(true);
      },
    },
  });

  return (
    <SidebarGroup className="pb-1">
      {/*
        Ground-styled, matching the shell (John, fix brief): the button previously used
        `bg-background`/`text-foreground` — the PAGE's tokens, not the RAIL's. Those agree
        with the sidebar's own navy tone only by coincidence in `.navy` (both happen to be
        navy) and visibly disagree in light/dark, where `--background`/`--foreground` are
        paper/ink while the sidebar stays navy (`--sidebar` "-> navy in both themes",
        `index.css`). Swapped to `sidebar-*` tokens throughout, and the fill is a subtle
        `sidebar-accent/10` tint (the same ground-relative "active row" value used
        elsewhere in this rail) rather than a solid box, so it reads as part of the ground
        with a hairline edge, not a page-toned control dropped onto it. `h-11` matches the
        other rows' 44px height.
      */}
      <button
        className="inline-flex h-11 w-full cursor-pointer rounded-md border border-sidebar-border/40 bg-sidebar-accent/10 px-2 py-1.5 text-sidebar-foreground text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-sidebar-ring focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50"
        onClick={() => setOpen(true)}
        type="button"
      >
        <span className="flex grow items-center">
          <SearchIcon
            aria-hidden="true"
            className="-ms-1 me-3 text-sidebar-foreground/80"
            size={16}
          />
          <span className="font-normal text-sidebar-foreground/70">
            {t("navigation:commandPalette.search")}
          </span>
        </span>
        <kbd className="-me-0.5 ms-6 inline-flex h-4 max-h-full items-center rounded border border-sidebar-border/40 bg-transparent px-1 font-[inherit] font-medium text-[0.625rem] text-sidebar-foreground/60">
          {shortcuts.search.prefix}
        </kbd>
      </button>

      <SearchCommandMenu open={open} setOpen={setOpen} />
    </SidebarGroup>
  );
}
