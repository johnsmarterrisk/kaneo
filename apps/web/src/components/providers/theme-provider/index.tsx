import { useEffect, useLayoutEffect } from "react";
import { useUserPreferencesStore } from "@/store/user-preferences";

/**
 * Operon mode (spec: GUI pass task 4b, widened by fix brief row 8
 * `docs/specs/operon-gui-pass-fix-brief.md`; docs/fork-discipline.md row 13): Initiative
 * follows Operon's theme instead of keeping its own.
 *
 * Operon writes the `operon_theme` cookie, on the widest domain it shares with this
 * origin, every time its OWN theme changes (`app/src/theme/ThemeProvider.tsx` ->
 * `writeThemeCookie`, GUI pass task 1) — exactly one of three values: `navy`, `light`,
 * `dark`. `navy` now maps to Kaneo's OWN first-class `.navy` class (`index.css`), not
 * `dark` — the original GUI pass shipped `navy` -> `dark` because Kaneo had no navy mode
 * of its own yet; John's round-2 rejection ("Initiative flashes, it feels like another
 * app") is what that mapping cost: `.dark` is navy-600 CARDS on a navy-700 ground, while
 * Operon's own shell renders WHITE panels on the navy ground under the same theme name.
 * `light` and `dark` still map onto themselves.
 *
 * Read ONCE, on first mount, not subscribed to cookie changes: a person can still
 * override it from Initiative's own theme control afterwards without this effect
 * fighting back on every render. Changing it FROM Operon is the intended path going
 * forward — the same way the injected switcher (B11) is the intended path back to
 * Telegraph — so this is a one-time handoff at arrival, not a permanent lock.
 */
const OPERON_THEME_COOKIE = "operon_theme";

const OPERON_TO_KANEO_THEME: Record<string, "light" | "dark" | "navy"> = {
  navy: "navy",
  light: "light",
  dark: "dark",
};

function readOperonThemeCookie(): "light" | "dark" | "navy" | null {
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${OPERON_THEME_COOKIE}=([^;]*)`),
  );
  if (!match) return null;
  // Guarded (Codex round-1 finding 21): a cookie value this reader cannot decode must not
  // throw out of the effect — the theme handoff is cosmetic and never worth breaking
  // Initiative's own mount over, the same reasoning Operon's own cookie writer/reader give.
  try {
    const value = decodeURIComponent(match[1]);
    return OPERON_TO_KANEO_THEME[value] ?? null;
  } catch {
    return null;
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useUserPreferencesStore();

  // `useLayoutEffect`, not `useEffect` (Codex round-1 finding 12): the pre-paint script in
  // `index.html` already stamped the correct class before React mounted, but a PLAIN
  // `useEffect` here would only correct the STORE after the browser had already painted
  // one frame at the store's persisted (pre-cookie) theme via the effect below — a second,
  // React-caused flash the pre-paint script cannot prevent on its own. A layout effect
  // runs synchronously after DOM mutations but before the browser paints, so `setTheme`
  // here (when it fires) triggers React's synchronous re-render-before-paint path: the
  // paint effect below only ever runs once, already reading the corrected value.
  //
  // Reads `useUserPreferencesStore.getState()` fresh rather than the render-scope
  // `theme`/`setTheme` above, so this effect closes over no reactive value at all and a
  // `[]` dependency array is exactly correct — not a suppressed lint. That is also what
  // makes it run genuinely ONCE, on mount, per the file doc comment: no destructured
  // value from this render can be stale here because none is read.
  useLayoutEffect(() => {
    const mapped = readOperonThemeCookie();
    if (!mapped) return;
    const store = useUserPreferencesStore.getState();
    if (mapped !== store.theme) {
      store.setTheme(mapped);
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    // "navy" is included in the remove list (fix brief row 8) so this effect can strip a
    // pre-paint-script-applied `.navy` class before repainting from the store's own
    // light/dark/system choice — the same reason `light`/`dark` were already here. `system`
    // never resolves to `navy` (theme-proposal.md §4a.4: no OS exposes a navy preference).
    root.classList.remove("light", "dark", "navy");

    if (theme === "system") {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light";
      root.classList.add(systemTheme);
    } else {
      root.classList.add(theme);
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      if (theme === "system") {
        root.classList.remove("light", "dark", "navy");
        root.classList.add(e.matches ? "dark" : "light");
      }
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  return <>{children}</>;
}
