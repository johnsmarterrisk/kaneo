import { memo } from "react";
import { NavMain } from "@/components/nav-main";
import { NavProjects } from "@/components/nav-projects";
import {
  OPERON_MODULES,
  OperonPhoneModuleStrip,
  OperonRailFooter,
  OperonVersionStamp,
} from "@/components/operon-switcher";
import Search from "@/components/search";

/**
 * The fork's phone Navigate screen (Piece B, Round 2 mobile-nav brief) — mounted by
 * `layout.tsx` below 768px INSTEAD OF `AppSidebar` (never beside it: `AppSidebar` is what
 * pulls in `ui/sidebar.tsx`'s `Sheet`, which must never mount in Operon mode at phone
 * width — see `layout.tsx`'s own doc comment).
 *
 * Composes existing pieces rather than rewriting them, matching the brief's own
 * instruction: `OperonPhoneModuleStrip` (the 64px tile strip, `operon-switcher.tsx`) beside
 * Kaneo's own `Search`/`NavMain`/`NavProjects` restyled as the list panel — the SAME three
 * components `AppSidebar`'s `SidebarContent` already mounts for the desktop rail's middle
 * tier, unmodified, because they already render correctly on the `bg-sidebar` ground (that
 * restyle predates this file — see their own doc comments, fork-discipline.md row 2's
 * rail-parity note). `OperonRailFooter phone` adds the presence dot and bell the phone
 * footer needs that the desktop rail's footer does not (see that prop's own doc comment).
 *
 * The "Initiative ›" header row is NOT a new hard-coded string: it reads the same
 * `OPERON_MODULES` label this file's module strip and the desktop rail both already use,
 * so a future rename only ever happens in one place.
 */
function OperonPhoneNavigate() {
  const currentModuleLabel =
    OPERON_MODULES.find((module) => module.key === "initiative")?.label ??
    "Initiative";

  return (
    <div
      data-testid="phone-navigate"
      // No top padding of its own any more — see `OperonPhoneModuleStrip`'s and the list
      // panel's OWN `pt-[env(...)]` below (defect 3). Same box-model reasoning either way,
      // just no longer relying on this outer div alone to carry it.
      className="flex h-full w-full overflow-hidden bg-sidebar text-sidebar-foreground"
    >
      <OperonPhoneModuleStrip />

      {/* iPhone pass 1, defect 3 (John, real iPhone 2026-09-23: the Stream tile sits under
          the status bar while the list panel's "Telegraph" header is correctly inset —
          checked here for the same defect, present the same way: this wrapper used to
          rely on the OUTER div's `pt-[env(...)]` alone, exactly like the Operon shell's
          `MobileNavigate.tsx` did before its own fix). `pt-[env(safe-area-inset-top)]`
          directly on this wrapper, matching `OperonPhoneModuleStrip`'s own inset a few
          lines up — neither side depends on the other, or on the outer div, to be
          correctly inset. `cssstyle` (jsdom) drops an unrecognised `env()` value from an
          inline `style`, which is why this is a class, not a style object. */}
      <div className="flex-1 min-w-0 flex flex-col pt-[env(safe-area-inset-top)]">
        <div className="px-3 pt-3 pb-2 flex items-center justify-between shrink-0 gap-2">
          <h1 className="text-[16.5px] font-bold truncate">
            {currentModuleLabel}
          </h1>
          {/* iPhone pass 1, defect 2: the stamp used to render here, beside the chevron —
              floating into the status-bar zone on a notched phone. Only the chevron
              remains; the stamp now renders once, at the very bottom of this screen. */}
          <span
            aria-hidden="true"
            className="text-sidebar-foreground/60 shrink-0"
          >
            ›
          </span>
        </div>

        {/* `!justify-start` on every row in the list panel. `index.css`'s own base rule
            (`button:not([data-touch-compact])`, specificity (0,1,1)) centres EVERY button in
            this app, and it outranks a bare utility class (0,1,0) — so Kaneo's reused
            NavMain/NavProjects/Search rows rendered centred here, which is most of what
            "Initiative is a little jumbled" looked like at 375px. Applied as a scoped
            descendant variant rather than by editing the three Kaneo components, so the
            desktop rail those same components draw is untouched. Operon's own
            `Sidebar.tsx` records this identical trap and the identical fix. */}
        <div className="flex-1 min-h-0 overflow-y-auto [&_button]:!justify-start [&_a]:!justify-start">
          <Search />
          <NavMain />
          <NavProjects />
        </div>

        <OperonRailFooter phone />
        {/* iPhone pass 1, defect 2: the stamp, under the account/footer row, inside the
            safe area — see `operon-switcher.tsx`'s own doc comment on
            `OperonVersionStamp`. `OperonRailFooter` itself carries no bottom inset (its
            desktop use has none to carry), so the inset lives on this wrapper instead. */}
        <div
          data-testid="phone-navigate-version-row"
          className="px-3 pt-1 pb-[calc(0.25rem_+_env(safe-area-inset-bottom))]"
        >
          <OperonVersionStamp />
        </div>
      </div>
    </div>
  );
}

// Avoid parent-only renders while mounted. Router/context updates and route remounts
// still render this subtree; memo does not remove those costs.
export default memo(OperonPhoneNavigate);
