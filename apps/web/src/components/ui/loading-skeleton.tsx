import { PhoneNavySkeleton } from "@/components/common/route-pending";
import { cn } from "@/lib/cn";

/** Same synchronous read as `common/layout.tsx`'s `useSyncedIsMobile` and
    `common/route-pending.tsx`, and for the same reason: this component's whole job is to
    be correct on its FIRST paint, so it cannot use a hook that reports "not mobile" until
    an effect has run. No resize listener — a loading state lives for a few hundred
    milliseconds. */
const PHONE_BREAKPOINT_PX = 768;

type LoadingSkeletonProps = {
  className?: string;
};

export function LoadingSkeleton({ className }: LoadingSkeletonProps) {
  // PHONE: this skeleton is a hard-coded DESKTOP shape — a `w-64` rail beside a `bg-card`
  // panel — and `AuthProvider` renders it while the session resolves, ABOVE the router.
  // That put a full-width WHITE card on screen for ~750ms of every phone hop into
  // Initiative, measured on Slow 3G, and no `defaultPendingComponent` could cover it
  // because it renders above the router entirely. Below 768px the navy silhouette from
  // `route-pending.tsx` is drawn instead — the same one the pre-paint and the router's
  // pending state use, so the whole hop is one continuous navy shape. Desktop falls
  // through to exactly the markup it has always rendered.
  if (
    typeof window !== "undefined" &&
    window.innerWidth < PHONE_BREAKPOINT_PX
  ) {
    return <PhoneNavySkeleton />;
  }

  // Rail-column bars use `bg-sidebar-accent`, not `bg-muted` (fix brief row 11, "the hop",
  // `docs/specs/operon-gui-pass-fix-brief.md`): this column sits directly on `bg-sidebar`
  // (the ground in navy mode, `#081a33`), and `--sidebar-accent` is `rgba(255,255,255,.10)`
  // in navy — exactly the bar color the brief names. `bg-muted` (a grey meant for a WHITE
  // card) would paint grey blotches on the navy ground, which is the same "another app"
  // flash John rejected, just before any real content has loaded. The right-hand panel's
  // bars stay `bg-muted` — that column sits on `bg-card` (white), where grey is correct.
  return (
    <div className={cn("flex w-full h-svh bg-sidebar", className)}>
      <div className="w-64 bg-sidebar border-r border-sidebar-border flex flex-col">
        <div className="p-3 border-b border-sidebar-border">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-sidebar-accent rounded animate-pulse" />
            <div className="flex-1">
              <div className="w-20 h-4 bg-sidebar-accent rounded animate-pulse" />
            </div>
          </div>
        </div>

        <div className="flex-1 p-3 space-y-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 bg-sidebar-accent rounded-full animate-pulse" />
              <div className="flex-1">
                <div className="w-16 h-3 bg-sidebar-accent rounded animate-pulse" />
              </div>
            </div>
          </div>

          <div className="space-y-1">
            {["dashboard", "projects", "settings"].map((item) => (
              <div
                key={`nav-item-${item}`}
                className="flex items-center gap-2 p-2 rounded"
              >
                <div className="w-4 h-4 bg-sidebar-accent rounded animate-pulse" />
                <div className="w-20 h-3 bg-sidebar-accent rounded animate-pulse" />
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-sidebar-accent rounded animate-pulse" />
              <div className="w-16 h-3 bg-sidebar-accent rounded animate-pulse" />
            </div>
            <div className="ml-4 space-y-1">
              {["issues", "projects", "views", "settings"].map((item) => (
                <div
                  key={`workspace-item-${item}`}
                  className="flex items-center gap-2 p-1"
                >
                  <div className="w-4 h-4 bg-sidebar-accent rounded animate-pulse" />
                  <div className="w-16 h-3 bg-sidebar-accent rounded animate-pulse" />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="p-3 border-t border-sidebar-border">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-sidebar-accent rounded-full animate-pulse" />
            <div className="flex-1">
              <div className="w-20 h-3 bg-sidebar-accent rounded animate-pulse" />
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col bg-card border border-border rounded-md m-2">
        <div className="h-12 border-b border-border flex items-center px-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-muted rounded animate-pulse" />
            <div className="w-32 h-4 bg-muted rounded animate-pulse" />
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-4">
            <div className="w-16 h-16 bg-muted rounded-lg animate-pulse mx-auto" />
            <div className="space-y-2">
              <div className="w-48 h-4 bg-muted rounded animate-pulse mx-auto" />
              <div className="w-64 h-3 bg-muted rounded animate-pulse mx-auto" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
