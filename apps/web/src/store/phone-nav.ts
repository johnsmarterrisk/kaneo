import { create } from "zustand";

/**
 * The fork's phone Navigate/Work screen state (Piece B, Round 2 mobile-nav brief).
 *
 * MUST be a module-level store, not component state. The two-screen split lives in
 * `common/layout.tsx`, but `Layout` is re-instantiated on every route change — the router
 * swaps `WorkspaceLayout`/`ProjectLayout`/`TaskLayout`, each of which wraps its OWN
 * `<Layout>`, so a `useState` inside `Layout` resets to its initial value on every
 * navigation instead of surviving it (caught live: tapping a project from Navigate landed
 * on the project's Work screen's URL while still SHOWING Navigate, because the fresh
 * `Layout` mount re-initialised to "Navigate open"). A Zustand store is the same
 * module-singleton pattern `store/project.ts`/`store/bulk-selection.ts` already use for
 * state that must outlive a single route component's lifetime.
 */
type PhoneNavStore = {
  isPhoneNavOpen: boolean;
  openPhoneNav: () => void;
  closePhoneNav: () => void;
  /** The last `location.pathname` `Layout`'s route-change effect has seen, so it can tell
      a genuine navigation (close Navigate) from its own first mount at a URL it has never
      seen before (do nothing) — `null` means "not seen one yet". Lives here rather than a
      `useRef` in `Layout` for the exact same reason `isPhoneNavOpen` does: `useRef` is
      also per-component-instance state, and would reset to `null` on every remount just
      as the old `useState` did. */
  lastSeenPathname: string | null;
  setLastSeenPathname: (pathname: string) => void;
};

/**
 * Which screen a COLD mount opens, from the route alone (Codex r1 #2).
 *
 * Initialising unconditionally to Navigate meant every deep link hid the thing it pointed
 * at: opening a project or task URL — from a notification, a pasted link, or Operon's own
 * cross-origin hop — painted the Navigate list over the Work screen the address had just
 * asked for, and the reader had to find their way back to it by hand. Route DEPTH answers
 * this without a route table: the workspace landing is where Navigate belongs, and
 * anything deeper (a project, a board, a task) is a Work screen the address named
 * explicitly. `/dashboard/workspace/<id>` is the landing; `/dashboard/workspace/<id>/...`
 * is not.
 */
export function phoneNavOpenForPath(pathname: string): boolean {
  const workspace = pathname.match(/^\/dashboard\/workspace\/[^/]+(\/.*)?$/);
  if (!workspace) return true;
  const rest = workspace[1];
  return rest === undefined || rest === "" || rest === "/";
}

export const usePhoneNavStore = create<PhoneNavStore>((set) => ({
  // Codex r1 #2: from the route, not a constant — a deep link must open its own Work
  // screen. Read once, at store creation, which is the cold mount.
  isPhoneNavOpen:
    typeof window === "undefined"
      ? true
      : phoneNavOpenForPath(window.location.pathname),
  openPhoneNav: () => set({ isPhoneNavOpen: true }),
  closePhoneNav: () => set({ isPhoneNavOpen: false }),
  lastSeenPathname: null,
  setLastSeenPathname: (pathname) => set({ lastSeenPathname: pathname }),
}));
