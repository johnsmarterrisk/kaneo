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
};

export const usePhoneNavStore = create<PhoneNavStore>((set) => ({
  // Landing state is Navigate (spec: "Where you land after login").
  isPhoneNavOpen: true,
  openPhoneNav: () => set({ isPhoneNavOpen: true }),
  closePhoneNav: () => set({ isPhoneNavOpen: false }),
}));
