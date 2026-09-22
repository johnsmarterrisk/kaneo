/**
 * RoutePending — what the router paints while a route's `beforeLoad`/loader is in flight
 * (Piece B, Round 2 mobile-nav brief: "a throttled (Slow 3G) hop shows no frame that is
 * white or grey").
 *
 * WHY THIS EXISTS AT ALL. The fork had NO `defaultPendingComponent`, so a pending route
 * painted whatever the tree happened to render underneath it. On a cold load into
 * Initiative — which is every hop from Operon, because that hop is a real cross-origin
 * `window.location.assign` — the only thing covering the gap was `index.html`'s navy
 * pre-paint, and that is torn down the moment React mounts. Anything the app rendered
 * between mount and the route settling was therefore uncovered, and on a phone that was
 * the DESKTOP chrome: the navy rail beside `SidebarInset`'s large white card. This
 * component closes that window explicitly instead of relying on how fast a loader happens
 * to resolve.
 *
 * WHY THE VIEWPORT IS READ SYNCHRONOUSLY, AND NOT THROUGH `useIsMobile`. Same reason
 * `common/layout.tsx` carries its own `useSyncedIsMobile`: the shared
 * `@/hooks/use-mobile` hook starts at `undefined` and only becomes accurate after its own
 * effect runs, so its FIRST render reports "not mobile" on every device. A pending
 * component whose whole job is to be correct on its first paint cannot use a hook that is
 * wrong on its first paint. This reads `window.innerWidth` in the initialiser, and does
 * not listen for resizes at all — a pending state lives for a few hundred milliseconds
 * and a breakpoint crossing during it is not a case worth the subscription.
 *
 * DESKTOP IS DELIBERATELY UNCHANGED. At 768px and wider this renders `null`, which is
 * exactly what the router did before this component existed — the desktop shape's loading
 * behaviour is not touched, only the phone's.
 */

const PHONE_BREAKPOINT_PX = 768;

/** The skeleton `index.html` paints before any script, redrawn as markup so the SAME navy
    silhouette survives the hand-off from pre-paint to React instead of blinking out of
    existence at mount. Colours are the literal values the pre-paint uses, not tokens: this
    must be identical to a file that cannot import from the Tailwind theme. */
export function PhoneNavySkeleton() {
  return (
    <div
      data-testid="route-pending-phone"
      aria-hidden="true"
      className="fixed inset-0 flex"
      style={{ background: "#081a33" }}
    >
      <div className="flex w-16 shrink-0 flex-col items-center gap-2 px-2 py-3">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-12 w-12 rounded-2xl"
            style={{ background: "rgba(255,255,255,.10)" }}
          />
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-2.5 px-3 py-4">
        <div
          className="h-4 w-28 rounded"
          style={{ background: "rgba(255,255,255,.10)" }}
        />
        <div
          className="h-10 w-full rounded-lg"
          style={{ background: "rgba(255,255,255,.10)" }}
        />
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-9 w-full rounded-md"
            style={{ background: "rgba(255,255,255,.10)" }}
          />
        ))}
      </div>
    </div>
  );
}

export default function RoutePending() {
  const isPhone =
    typeof window !== "undefined" && window.innerWidth < PHONE_BREAKPOINT_PX;

  if (!isPhone) return null;
  return <PhoneNavySkeleton />;
}
