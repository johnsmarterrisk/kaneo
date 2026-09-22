import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Codex round 2 #1 and #3: the phone Navigate/Work HISTORY model, driven for real.
 *
 * The round-1 tests exercised `phoneNavOpenForPath` — a pure helper — and stopped there,
 * so nothing covered the thing that was actually wrong: the back arrow PUSHED a Navigate
 * entry on top of Work, inverting the stack, and browser Back then walked into router
 * entries beneath it. That is a behaviour of a MOUNTED `Layout` reacting to real history
 * traversals, so this file mounts it and dispatches real `popstate` events.
 *
 * `Layout` is mounted with the genuine `phone-nav` store (not the marker mock the branch
 * test uses) because the store's transitions ARE half the contract under test; everything
 * else `layout.tsx` imports is a marker, exactly as in the branch test, so a failure here
 * can only be about screens and history.
 */

let pathname = "/dashboard/workspace/w1";

vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname }),
}));
vi.mock("@/store/user-preferences", () => ({
  useUserPreferencesStore: () => ({ sidebarDefaultOpen: true }),
}));
vi.mock("@/hooks/use-user-preferences-effects", () => ({
  useUserPreferencesEffects: vi.fn(),
}));
vi.mock("@/constants/urls", () => ({ isDemoMode: false }));
vi.mock("@/components/demo-alert", () => ({
  DemoAlert: () => <div data-testid="demo-alert" />,
}));
vi.mock("@/components/app-sidebar", () => ({
  AppSidebar: () => <div data-testid="app-sidebar-marker" />,
}));
vi.mock("@/components/common/operon-phone-navigate", () => ({
  default: () => <div data-testid="phone-navigate-marker" />,
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarInset: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const { default: Layout, usePhoneNav } = await import(
  "@/components/common/layout"
);
const { usePhoneNavStore } = await import("@/store/phone-nav");

const PHONE = 375;

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: () => ({
      matches: width < 768,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

/** What the reader is looking at: the Navigate marker, or the routed Work content. */
function visibleScreen(): "navigate" | "work" {
  return screen.queryByTestId("phone-navigate-marker") ? "navigate" : "work";
}

function traverseTo(state: unknown) {
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
  });
}

beforeEach(() => {
  setViewport(PHONE);
  pathname = "/dashboard/workspace/w1";
  window.history.replaceState(null, "", "/dashboard/workspace/w1");
  usePhoneNavStore.setState({ isPhoneNavOpen: true, lastSeenPathname: null });
});

afterEach(() => {
  cleanup();
  setViewport(1024);
});

describe("the phone back arrow and the browser's own Back are one mechanism", () => {
  it("seeds the landing entry as Navigate and pushes nothing on top of it", () => {
    const pushSpy = vi.spyOn(window.history, "pushState");
    render(
      <Layout>
        <div data-testid="work-content">project</div>
      </Layout>,
    );

    expect(visibleScreen()).toBe("navigate");
    // A workspace landing needs no Work entry beneath or above it.
    expect(pushSpy).not.toHaveBeenCalled();
    expect(
      (window.history.state as { initiativePhoneScreen?: string })
        .initiativePhoneScreen,
    ).toBe("navigate");
    pushSpy.mockRestore();
  });

  it("restores Navigate on a Back onto a Navigate entry, and Work on a Forward onto a Work entry", () => {
    render(
      <Layout>
        <div data-testid="work-content">project</div>
      </Layout>,
    );

    // Forward onto the Work entry: the round-1 listener could not do this at all.
    traverseTo({ initiativePhoneScreen: "work" });
    expect(visibleScreen()).toBe("work");
    expect(screen.getByTestId("work-content")).toBeTruthy();

    // Back onto the Navigate entry beneath it.
    traverseTo({ initiativePhoneScreen: "navigate" });
    expect(visibleScreen()).toBe("navigate");
  });

  it("treats an entry it never stamped as Navigate, never a dead end", () => {
    render(
      <Layout>
        <div data-testid="work-content">project</div>
      </Layout>,
    );
    traverseTo({ initiativePhoneScreen: "work" });
    expect(visibleScreen()).toBe("work");

    // A router entry from before this shell existed, or any foreign entry.
    traverseTo(null);
    expect(visibleScreen()).toBe("navigate");
  });

  it("the back arrow traverses history rather than pushing a new entry", () => {
    // THE round-1 BUG, as a test: the arrow used to push a Navigate entry on TOP of Work,
    // which inverted the stack and let the browser's own Back walk into router entries
    // underneath it. It must move the cursor, never grow the stack.
    const pushSpy = vi.spyOn(window.history, "pushState");
    const backSpy = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => {});

    function BackArrowProbe() {
      const { openPhoneNav } = usePhoneNav();
      return (
        <button type="button" data-testid="probe-back" onClick={openPhoneNav}>
          back
        </button>
      );
    }

    render(
      <Layout>
        <BackArrowProbe />
      </Layout>,
    );
    traverseTo({ initiativePhoneScreen: "work" });
    pushSpy.mockClear();

    act(() => {
      screen.getByTestId("probe-back").click();
    });

    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).not.toHaveBeenCalled();

    backSpy.mockRestore();
    pushSpy.mockRestore();
  });
});

describe("a traversal survives Layout being re-instantiated (Codex r2 #1)", () => {
  it("a Back that also changes the route does not get re-read as a row tap", () => {
    // THE bug this guard exists for, and the reason the flag lives in the STORE. The
    // router swaps WorkspaceLayout/ProjectLayout, each wrapping its own <Layout>, so a
    // Back that changes the pathname REMOUNTS this component. A ref would be born `false`
    // in the new instance, the route effect would treat the traversal as a fresh row tap,
    // close Navigate again and re-stamp the entry it had just returned to as Work — so
    // Back moved the URL and left the screen exactly where it was. Verified against the
    // live container before and after.
    pathname = "/dashboard/workspace/w1/project/p1/board";
    usePhoneNavStore.setState({
      isPhoneNavOpen: false,
      lastSeenPathname: "/dashboard/workspace/w1/project/p1/board",
    });
    const { unmount } = render(
      <Layout>
        <div data-testid="work-content">board</div>
      </Layout>,
    );
    expect(visibleScreen()).toBe("work");

    // Back: popstate lands first, then the router remounts Layout at the new pathname.
    traverseTo({ initiativePhoneScreen: "navigate" });
    expect(usePhoneNavStore.getState().traversing).toBe(true);
    unmount();
    pathname = "/dashboard/workspace/w1";
    render(
      <Layout>
        <div data-testid="work-content">workspace</div>
      </Layout>,
    );

    // The fresh instance must honour the traversal, not undo it.
    expect(visibleScreen()).toBe("navigate");
    expect(usePhoneNavStore.getState().traversing).toBe(false);
  });
});

describe("a deep link cold-mounts on Work with Navigate beneath it (Codex r2 #1)", () => {
  it("seeds a Navigate entry then pushes Work, so one Back reaches Navigate", () => {
    pathname = "/dashboard/workspace/w1/project/p1/board";
    window.history.replaceState(null, "", pathname);
    usePhoneNavStore.setState({
      isPhoneNavOpen: false,
      lastSeenPathname: null,
    });
    const pushSpy = vi.spyOn(window.history, "pushState");

    render(
      <Layout>
        <div data-testid="work-content">board</div>
      </Layout>,
    );

    // The address asked for Work, and Work is what shows.
    expect(visibleScreen()).toBe("work");
    // Exactly one entry was manufactured beneath it — the missing Navigate step.
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy.mock.calls[0][0]).toMatchObject({
      initiativePhoneScreen: "work",
    });
    // And the url never moved: Navigate is a screen over this route, not a place.
    expect(window.location.pathname).toBe(pathname);

    // One Back lands on Navigate rather than leaving the document.
    traverseTo({ initiativePhoneScreen: "navigate" });
    expect(visibleScreen()).toBe("navigate");
    pushSpy.mockRestore();
  });
});
