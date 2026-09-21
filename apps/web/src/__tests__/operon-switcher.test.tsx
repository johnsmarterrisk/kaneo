import { cleanup, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Operon fork check (spec R14, task B11; extended by task G11).
 *
 * Five claims, one test each, and each one can fail:
 *
 *  1. The injected switcher renders all four Operon modules, in `branding.ts`'s order,
 *     with Initiative marked as the module the user is already inside.
 *  2. Its Telegraph link points at the apex host taken from CONFIGURATION. The test sets a
 *     host that appears nowhere in the source, so a hard-coded literal — including the
 *     dev fallback — fails it.
 *  2b. `apexUrl` accepts a configured value by PARSING it. The same claim against the
 *     COMPILED bundle, with `env.sh`'s substitution actually applied, lives in
 *     `operon-apex-bundle.test.ts` — esbuild cannot run under jsdom, and that is the
 *     only place the sentinel-comparison bug was visible.
 *  3. `WorkspaceSwitcher` is not rendered by `AppSidebar`. The real module is replaced by a
 *     marker component, so re-adding it anywhere in that tree turns this test red rather
 *     than passing quietly.
 *  4. **G11:** Stream resolves to `${apex}/#/activity` and every other apex module still
 *     resolves to the apex root — both halves, since asserting only the first would pass a
 *     version that sent every module to `#/activity`.
 *  5. **G11:** the FIRST module reads *Stream ⚡* while its KEY stays `signals`, which is
 *     what both switchers dispatch on. Its POSITION is asserted too: the operator's
 *     2026-09-11 decision put Stream at the head of both switchers, and array order is the
 *     only thing that expresses it.
 *
 * See `docs/fork-discipline.md` in the Operon repository for why this check lives in the
 * fork rather than in Operon.
 */

vi.mock("@/components/notification/notification-dropdown", () => ({
  default: () => <div data-testid="notification-dropdown" />,
}));

vi.mock("@/components/user-avatar", () => ({
  UserAvatar: () => <div data-testid="user-avatar" />,
}));

vi.mock("@/hooks/use-user-websocket", () => ({
  useUserWebSocket: vi.fn(),
}));

const {
  OperonSwitcher,
  OPERON_MODULES,
  apexUrl,
  DEV_APEX_URL,
  __resetApexUrlWarning,
} = await import("@/components/operon-switcher");

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("OperonSwitcher", () => {
  it("renders the four Operon modules in order with Initiative as the current one", () => {
    render(<OperonSwitcher />);

    expect(screen.getByTestId("operon-switcher")).toBeTruthy();

    const rendered = Array.from(
      screen
        .getByTestId("operon-switcher")
        .querySelectorAll("[data-module]") as NodeListOf<HTMLElement>,
    );
    expect(rendered.map((element) => element.dataset.module)).toEqual([
      "signals",
      "telegraph",
      "initiative",
      "settings",
    ]);
    expect(rendered.map((element) => element.dataset.module)).toEqual(
      OPERON_MODULES.map((module) => module.key),
    );

    // Initiative is where the user already is: current, not a link, not "external".
    const initiative = screen.getByTestId("module-initiative");
    expect(initiative.getAttribute("aria-current")).toBe("page");
    expect(initiative.tagName).toBe("SPAN");
    expect(initiative.dataset.external).toBe("false");

    // ...and every other module leaves this origin.
    for (const key of ["telegraph", "signals", "settings"]) {
      const element = screen.getByTestId(`module-${key}`);
      expect(element.tagName).toBe("A");
      expect(element.dataset.external).toBe("true");
      expect(element.getAttribute("aria-current")).toBeNull();
    }
  });

  it("targets the Telegraph apex host from configuration, not a literal", () => {
    // A host that exists in no source file, so only a configured read can produce it.
    vi.stubEnv("VITE_OPERON_APEX_URL", "https://apex.b11.test:9443/");

    render(<OperonSwitcher />);

    const telegraph = screen.getByTestId("module-telegraph");
    expect(telegraph.getAttribute("href")).toBe("https://apex.b11.test:9443/");
    // The dev fallback must not have been used while a value was configured.
    expect(telegraph.getAttribute("href")).not.toContain("lvh.me");
  });

  it("sends Stream to its own address and every other module to the apex root", () => {
    // The whole of task G11: before it, `moduleHref` ignored the key, so a member clicking
    // Stream inside Initiative landed on whatever the apex root opens. Both halves are
    // asserted, because a version that sent EVERY module to `#/activity` would pass an
    // assertion about Stream alone.
    vi.stubEnv("VITE_OPERON_APEX_URL", "https://apex.g11.test:9443/");

    render(<OperonSwitcher />);

    expect(screen.getByTestId("module-signals").getAttribute("href")).toBe(
      "https://apex.g11.test:9443/#/activity",
    );

    for (const key of ["telegraph", "settings"]) {
      expect(screen.getByTestId(`module-${key}`).getAttribute("href")).toBe(
        "https://apex.g11.test:9443/",
      );
    }

    // Initiative is the current module: a span, so it carries no href at all.
    expect(
      screen.getByTestId("module-initiative").getAttribute("href"),
    ).toBeNull();
  });

  it("labels the first module Stream, keeping `signals` as its key", () => {
    // `app/src/shell/branding.ts` says Stream ⚡ and lists it first, and this list is a hand
    // copy of that one. The KEY is the cross-repository contract and must not follow the
    // label; nor must the hash route, which stays `#/activity` (Operon spec D7).
    render(<OperonSwitcher />);

    expect(OPERON_MODULES[0].key).toBe("signals");
    const activity = screen.getByTestId("module-signals");
    expect(activity.dataset.module).toBe("signals");
    expect(activity.textContent).toContain("Stream");
    expect(activity.textContent).not.toContain("Activity");
    expect(activity.textContent).toContain("⚡");
    expect(activity.textContent).not.toContain("Signals");
  });
});

describe("apexUrl", () => {
  beforeEach(() => {
    __resetApexUrlWarning();
  });

  it("uses a configured absolute url and strips its trailing slashes", () => {
    vi.stubEnv("VITE_OPERON_APEX_URL", "https://apex.b11.test:9443//");
    expect(apexUrl()).toBe("https://apex.b11.test:9443");
  });

  it("falls back when the placeholder token was never substituted", () => {
    // The literal `apps/web/.env.production` bakes in. It is not a URL, which is now
    // the whole test: nothing compares it against a copy of itself.
    vi.stubEnv("VITE_OPERON_APEX_URL", "OPERON_APEX_URL");
    expect(apexUrl()).toBe(DEV_APEX_URL);
  });

  it("falls back on an empty value", () => {
    vi.stubEnv("VITE_OPERON_APEX_URL", "   ");
    expect(apexUrl()).toBe(DEV_APEX_URL);
  });

  it("refuses a non-http scheme rather than rendering it into an href", () => {
    // `apexUrl()`'s return value is interpolated straight into `<a href>`.
    vi.stubEnv("VITE_OPERON_APEX_URL", "javascript:alert(1)");
    expect(apexUrl()).toBe(DEV_APEX_URL);
  });
});

describe("AppSidebar", () => {
  beforeEach(() => {
    vi.resetModules();

    // The workspace dropdown, replaced by a marker: if it comes back, test 3 fails.
    vi.doMock("@/components/workspace-switcher", () => ({
      WorkspaceSwitcher: () => <div data-testid="workspace-switcher" />,
    }));

    // Everything else in the sidebar is upstream's and is out of scope here.
    vi.doMock("@/components/nav-main", () => ({
      NavMain: () => <div data-testid="nav-main" />,
    }));
    vi.doMock("@/components/nav-projects", () => ({
      NavProjects: () => <div data-testid="nav-projects" />,
    }));
    vi.doMock("@/components/search", () => ({
      default: () => <div data-testid="search" />,
    }));
    vi.doMock("@/components/trial-card", () => ({
      TrialCard: () => <div data-testid="trial-card" />,
    }));
    vi.doMock("@/components/version-display", () => ({
      VersionDisplay: () => <div data-testid="version-display" />,
    }));
    vi.doMock("@/components/theme-toggle-dropdown", () => ({
      ThemeToggleDropdown: () => <div data-testid="theme-toggle" />,
    }));
    vi.doMock("@/hooks/use-keyboard-shortcuts", () => ({
      useRegisterShortcuts: vi.fn(),
      // `constants/shortcuts.ts` calls this at module scope, so the mock must carry it.
      getModifierKeyText: () => "Ctrl",
    }));

    type Slot = { children?: React.ReactNode };
    const slot =
      (testId: string) =>
      ({ children }: Slot) => <div data-testid={testId}>{children}</div>;
    vi.doMock("@/components/ui/sidebar", () => ({
      Sidebar: slot("sidebar"),
      SidebarContent: slot("sidebar-content"),
      SidebarFooter: slot("sidebar-footer"),
      SidebarHeader: slot("sidebar-header"),
      useSidebar: () => ({ toggleSidebar: vi.fn() }),
    }));
  });

  afterEach(() => {
    vi.doUnmock("@/components/workspace-switcher");
    vi.resetModules();
  });

  it("renders the Operon switcher in the header and no WorkspaceSwitcher at all", async () => {
    const { AppSidebar } = await import("@/components/app-sidebar");

    render(<AppSidebar />);

    expect(screen.getByTestId("operon-switcher")).toBeTruthy();
    expect(screen.queryByTestId("workspace-switcher")).toBeNull();
    // It replaced the dropdown in the header slot rather than being added elsewhere.
    expect(
      screen
        .getByTestId("sidebar-header")
        .querySelector('[data-testid="operon-switcher"]'),
    ).not.toBeNull();
  });

  it("renders no independent theme control (Codex round-2 finding 5; GUI pass finding 11)", async () => {
    const { AppSidebar } = await import("@/components/app-sidebar");

    render(<AppSidebar />);

    // The mock above (`theme-toggle-dropdown`) is left in place deliberately: if
    // `app-sidebar.tsx` ever re-imports `ThemeToggleDropdown`, this mock intercepts it and
    // renders `theme-toggle`, which is exactly what this assertion would then catch. Operon
    // Settings is the one theme control; the footer keeps only the version display.
    expect(screen.queryByTestId("theme-toggle")).toBeNull();
    expect(screen.getByTestId("version-display")).toBeTruthy();
  });
});
