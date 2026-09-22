import { NavMain } from "@/components/nav-main";
import { NavProjects } from "@/components/nav-projects";
import {
  OPERON_MODULES,
  OperonPhoneModuleStrip,
  OperonRailFooter,
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
export default function OperonPhoneNavigate() {
  const currentModuleLabel =
    OPERON_MODULES.find((module) => module.key === "initiative")?.label ??
    "Initiative";

  return (
    <div
      data-testid="phone-navigate"
      // `pt-[env(safe-area-inset-top)]` as an arbitrary-value Tailwind class rather than an
      // inline `style` object — same reasoning as the Operon shell's own `MobileNavigate.tsx`:
      // jsdom's `cssstyle` engine silently drops an `env()` value written through `style`,
      // which would make a test asserting the class present but the computed padding absent.
      className="flex h-full w-full overflow-hidden bg-sidebar text-sidebar-foreground pt-[env(safe-area-inset-top)]"
    >
      <OperonPhoneModuleStrip />

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="px-3 pt-3 pb-2 flex items-center justify-between shrink-0">
          <h1 className="text-[16.5px] font-bold truncate">
            {currentModuleLabel}
          </h1>
          <span aria-hidden="true" className="text-sidebar-foreground/60">
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
      </div>
    </div>
  );
}
