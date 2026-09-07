import { cleanup, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Operon fork check (spec R14, task B11).
 *
 * Three claims, one test each, and each one can fail:
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
      "telegraph",
      "initiative",
      "signals",
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
});
