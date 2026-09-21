import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUserPreferencesStore } from "@/store/user-preferences";
import { ThemeProvider } from "./index";

/**
 * Operon mode (spec: GUI pass task 4b; docs/fork-discipline.md row 13): Initiative
 * follows Operon's theme via the `operon_theme` cookie, read once on mount.
 *
 * Three claims:
 *  1. `navy` (Operon's default, which Kaneo has no mode of its own for) maps to `dark`.
 *  2. `light` and `dark` map onto themselves, unchanged.
 *  3. No cookie at all leaves the store's own theme alone — this provider must not force
 *     a value onto a deployment that never received Operon's handoff.
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
  it("maps navy (Operon's default) to dark", () => {
    useUserPreferencesStore.setState({ theme: "light" });
    setOperonThemeCookie("navy");

    render(<ThemeProvider>child</ThemeProvider>);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
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

  it("leaves the store's own theme alone when no cookie is present", () => {
    useUserPreferencesStore.setState({ theme: "light" });
    setOperonThemeCookie(null);

    render(<ThemeProvider>child</ThemeProvider>);

    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
