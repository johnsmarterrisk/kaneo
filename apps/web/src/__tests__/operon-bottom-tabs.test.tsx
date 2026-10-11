import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Operon fork check (Tables task 15, spec 7.11, John's ruling Q2 and R-I; closes Operon
 * open-items 53; docs/fork-discipline.md row 18): the phone bottom tab bar. At 375px both
 * phone screens (Navigate and Work) carry ONE bar — "Telegraph" · "Initiative" · "Tables" ·
 * "More", the labels Operon's `app/src/shell/BottomTabBar.tsx` draws — each tab reaches its
 * target, and desktop renders none. `Layout`'s other dependencies are markers, as in
 * `operon-phone-shell.test.tsx`; the bar itself is real.
 */

const router = vi.hoisted(() => ({
  pathname: "/dashboard/workspace/w1",
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: router.pathname }),
  useNavigate: () => router.navigate,
}));
vi.mock("@/components/operon-switcher", () => ({
  apexUrl: () => "https://operon.example.test",
}));
vi.mock("@/store/user-preferences", () => ({
  useUserPreferencesStore: () => ({ sidebarDefaultOpen: true }),
}));
vi.mock("@/hooks/use-user-preferences-effects", () => ({
  useUserPreferencesEffects: vi.fn(),
}));
vi.mock("@/constants/urls", () => ({ isDemoMode: false }));
vi.mock("@/components/demo-alert", () => ({ DemoAlert: () => null }));
vi.mock("@/components/app-sidebar", () => ({
  AppSidebar: () => <div data-testid="app-sidebar-marker" />,
}));
vi.mock("@/components/common/operon-phone-navigate", () => ({
  default: () => <div data-testid="phone-navigate-marker" />,
}));
type Slot = { children?: React.ReactNode };
vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: Slot) => <div>{children}</div>,
  SidebarInset: ({ children }: Slot) => <div>{children}</div>,
}));
vi.mock("@/lib/version-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/version-check")>();
  return { ...actual, useVersionCheck: () => {} };
});

const { default: Layout } = await import("@/components/common/layout");
const phoneNav = await import("@/store/phone-nav");

const LABELS = ["Telegraph", "Initiative", "Tables", "More"];

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
}

function renderShell() {
  return render(
    <Layout>
      <div data-testid="work-content">Work</div>
    </Layout>,
  );
}

function tabs() {
  const bar = screen.getByRole("navigation", { name: "Tabs" });
  return within(bar).getAllByRole("link");
}

beforeEach(() => {
  router.pathname = "/dashboard/workspace/w1";
  router.navigate.mockClear();
  phoneNav.takeTablesAnchor();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  setViewportWidth(375);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setViewportWidth(1024);
});

describe("Bottom tab bar at 375px", () => {
  it("is on the Navigate screen with the four labels in order and 44px targets", () => {
    renderShell();
    expect(screen.getByTestId("phone-navigate-marker")).toBeTruthy();
    expect(tabs().map((t) => t.textContent?.replace(/[^A-Za-z]/g, ""))).toEqual(
      LABELS,
    );
    for (const tab of tabs()) expect(tab.className).toContain("min-h-[44px]");
    // The bar is the frame's bottom-most element, so it takes the home-indicator inset.
    expect(screen.getByTestId("operon-bottom-tabs").className).toContain(
      "env(safe-area-inset-bottom)",
    );
  });

  it("is on a Work screen too, the same four labels, Initiative marked", () => {
    router.pathname = "/dashboard/workspace/w1/project/p1/board";
    renderShell();
    expect(screen.getByTestId("work-content")).toBeTruthy();
    expect(tabs().map((t) => t.textContent?.replace(/[^A-Za-z]/g, ""))).toEqual(
      LABELS,
    );
    expect(
      screen.getByTestId("bottom-tab-initiative").getAttribute("aria-current"),
    ).toBe("page");
  });

  it("marks Tables on a table's own screen", () => {
    router.pathname = "/dashboard/workspace/w1/project/p1/table";
    renderShell();
    expect(
      screen.getByTestId("bottom-tab-tables").getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByTestId("bottom-tab-initiative").getAttribute("aria-current"),
    ).toBeNull();
  });

  it("each tab's target: Telegraph and More reach Operon's Navigate, Initiative and Tables this workspace's list", () => {
    renderShell();
    const href = (key: string) =>
      screen.getByTestId(`bottom-tab-${key}`).getAttribute("href");
    expect(href("telegraph")).toBe("https://operon.example.test/#/telegraph");
    // "More" opens Operon's Navigate screen — the module strip, the two-screen model.
    expect(href("more")).toBe("https://operon.example.test/#/telegraph");
    expect(href("initiative")).toBe("/dashboard/workspace/w1");
    expect(href("tables")).toBe("/dashboard/workspace/w1#tables");
  });

  it("Initiative navigates in-app to the workspace list", () => {
    router.pathname = "/dashboard/workspace/w1/project/p1/board";
    renderShell();
    fireEvent.click(screen.getByTestId("bottom-tab-initiative"));
    expect(router.navigate).toHaveBeenCalledWith({
      to: "/dashboard/workspace/$workspaceId",
      params: { workspaceId: "w1" },
      hash: undefined,
    });
    expect(phoneNav.takeTablesAnchor()).toBe(false);
  });

  it("Tables navigates to the list's Tables section and asks for the scroll", () => {
    router.pathname = "/dashboard/workspace/w1/project/p1/board";
    renderShell();
    fireEvent.click(screen.getByTestId("bottom-tab-tables"));
    expect(router.navigate).toHaveBeenCalledWith({
      to: "/dashboard/workspace/$workspaceId",
      params: { workspaceId: "w1" },
      hash: "tables",
    });
    expect(phoneNav.takeTablesAnchor()).toBe(true);
  });

  it("Tables on the list itself scrolls to the section at once", () => {
    const section = document.createElement("section");
    section.id = "tables";
    const scrollIntoView = vi.fn();
    section.scrollIntoView = scrollIntoView;
    document.body.appendChild(section);
    try {
      renderShell();
      fireEvent.click(screen.getByTestId("bottom-tab-tables"));
      expect(scrollIntoView).toHaveBeenCalled();
      // Consumed by the immediate scroll, so the section does not scroll again on load.
      expect(phoneNav.takeTablesAnchor()).toBe(false);
    } finally {
      section.remove();
    }
  });

  it("desktop renders no bar", () => {
    setViewportWidth(1024);
    renderShell();
    expect(screen.queryByTestId("operon-bottom-tabs")).toBeNull();
  });
});

describe("The Tables anchor across Initiative's redirects", () => {
  it("is captured from Operon's /#tables before the router runs, once", () => {
    phoneNav.captureTablesAnchor("#tables");
    expect(phoneNav.takeTablesAnchor()).toBe(true);
    expect(phoneNav.takeTablesAnchor()).toBe(false);
    phoneNav.captureTablesAnchor("#other");
    expect(phoneNav.takeTablesAnchor()).toBe(false);
  });

  it("names the tab for each path", () => {
    expect(
      phoneNav.bottomTabForPath("/dashboard/workspace/w1/project/p1/table"),
    ).toBe("tables");
    expect(phoneNav.bottomTabForPath("/dashboard/workspace/w1")).toBe(
      "initiative",
    );
    expect(phoneNav.workspaceIdForPath("/dashboard/settings")).toBeNull();
  });
});
