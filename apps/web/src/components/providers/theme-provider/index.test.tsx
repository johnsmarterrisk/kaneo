import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUserPreferencesStore } from "@/store/user-preferences";
import { ThemeProvider } from "./index";

/**
 * Operon mode (spec: GUI pass task 4b, widened by fix brief row 8
 * `docs/specs/operon-gui-pass-fix-brief.md`; docs/fork-discipline.md row 13): Initiative
 * follows Operon's theme via the `operon_theme` cookie, read once on mount.
 *
 * Four claims:
 *  1. `navy` maps to Kaneo's OWN first-class `navy` class (not `dark` — the original GUI
 *     pass mapping, superseded by the fix brief because `.dark` is a different anatomy).
 *  2. `light` and `dark` map onto themselves, unchanged.
 *  3. No cookie at all leaves the store's own theme alone — this provider must not force
 *     a value onto a deployment that never received Operon's handoff.
 *  4. The `dark` class is never present alongside `navy` — Tailwind's `dark:` variant
 *     (`@custom-variant dark (&:is(.dark *))`) must not fire under navy, since navy uses
 *     the light token values on white surfaces, not dark's.
 *
 * `document.documentElement`'s class list is asserted rather than the store's raw `theme`
 * field: the second `useEffect` (pre-existing, untouched by this task) is what actually
 * paints the mode, and a class on `<html>` is the same observable this component's own
 * pre-existing behaviour was already keyed on.
 */
function setOperonThemeCookie(value: string | null): void {
  if (value === null) {
    // biome-ignore lint/suspicious/noDocumentCookie: test harness — jsdom has no Cookie Store
    document.cookie = "operon_theme=; Max-Age=0; Path=/";
    return;
  }
  // biome-ignore lint/suspicious/noDocumentCookie: test harness — jsdom has no Cookie Store
  document.cookie = `operon_theme=${value}; Path=/`;
}

beforeEach(() => {
  setOperonThemeCookie(null);
  useUserPreferencesStore.setState({ theme: "dark" });
  // jsdom implements neither `matchMedia` nor a Cookie Store; ThemeProvider's PRE-EXISTING
  // (untouched by this task) system-theme effect calls it unconditionally on every mount.
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});

afterEach(() => {
  cleanup();
  setOperonThemeCookie(null);
  vi.unstubAllGlobals();
});

describe("ThemeProvider, Operon-mode cookie handoff", () => {
  it("maps navy to Kaneo's own navy class, not dark (fix brief row 8)", () => {
    useUserPreferencesStore.setState({ theme: "light" });
    setOperonThemeCookie("navy");

    render(<ThemeProvider>child</ThemeProvider>);

    expect(document.documentElement.classList.contains("navy")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.classList.contains("light")).toBe(false);
  });

  it("maps light to light", () => {
    useUserPreferencesStore.setState({ theme: "dark" });
    setOperonThemeCookie("light");

    render(<ThemeProvider>child</ThemeProvider>);

    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("maps dark to dark", () => {
    useUserPreferencesStore.setState({ theme: "light" });
    setOperonThemeCookie("dark");

    render(<ThemeProvider>child</ThemeProvider>);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("strips a stale dark class when the store transitions to navy (no dark: leakage, fix brief row 8)", () => {
    // Simulates arriving on a tab that previously rendered `dark` (e.g. a stale
    // pre-navy-support session) and then receiving the navy cookie — the render-effect's
    // remove list must include "navy" alongside "light"/"dark" or a leftover `dark` class
    // would leave Tailwind's `dark:` variant firing on top of navy's own white-surface
    // token values, corrupting the "light tokens on white surfaces" contract (row 8).
    document.documentElement.classList.add("dark");
    useUserPreferencesStore.setState({ theme: "light" });
    setOperonThemeCookie("navy");

    render(<ThemeProvider>child</ThemeProvider>);

    expect(document.documentElement.classList.contains("navy")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("leaves the store's own theme alone when no cookie is present", () => {
    useUserPreferencesStore.setState({ theme: "light" });
    setOperonThemeCookie(null);

    render(<ThemeProvider>child</ThemeProvider>);

    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("does not throw and leaves the store alone on a cookie value decodeURIComponent cannot decode (finding 21)", () => {
    useUserPreferencesStore.setState({ theme: "light" });
    // biome-ignore lint/suspicious/noDocumentCookie: test harness — jsdom has no Cookie Store
    document.cookie = "operon_theme=%; Path=/";

    expect(() => render(<ThemeProvider>child</ThemeProvider>)).not.toThrow();

    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});

it("keeps exactly one theme class through navy, dark, light and system transitions", () => {
  render(<ThemeProvider>child</ThemeProvider>);
  for (const theme of ["navy", "dark", "navy", "light", "system"] as const) {
    act(() => useUserPreferencesStore.getState().setTheme(theme));
    const modes = ["navy", "dark", "light"].filter((mode) =>
      document.documentElement.classList.contains(mode),
    );
    expect(modes).toEqual([theme === "system" ? "light" : theme]);
  }
});
