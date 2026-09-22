import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type * as React from "react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Operon phone shell check (Piece B, Round 2 mobile-nav brief, `docs/specs/operon-mobile-nav-brief.md`).
 *
 * Claim: below 768px, `Layout` (`components/common/layout.tsx`) never mounts `AppSidebar`
 * — the one path that pulls in `ui/sidebar.tsx`'s `Sidebar` primitive and its own
 * `if (isMobile) return <Sheet…>` branch, Kaneo's stock mobile drawer. Suppressing the
 * sheet is therefore "don't mount the thing that renders it", not a CSS `hidden` on the
 * Sheet itself — this test locks that in by asserting the marker components stand for
 * `AppSidebar`/`OperonPhoneNavigate` never BOTH render, and that the phone branch renders
 * only the Navigate marker, never the sidebar one.
 *
 * `Layout` reads the viewport itself (`useSyncedIsMobile`, a LOCAL hook — deliberately not
 * `@/hooks/use-mobile`'s shared `useIsMobile`, see that hook's own doc comment for why: the
 * shared one's `undefined`-then-`useEffect` timing painted the DESKTOP chrome for one frame
 * on every phone load, live-container repro), so this test drives it by setting
 * `window.innerWidth` before each render rather than mocking a hook. jsdom implements
 * neither `matchMedia` nor a resizable `innerWidth` (`theme-provider/index.test.tsx`
 * already works around the same `matchMedia` gap for its own untouched effect), so both are
 * stubbed per test.
 *
 * Every other dependency `layout.tsx` pulls in is mocked to a marker or a no-op: this is a
 * unit test of `Layout`'s own branching, not an integration test of the sidebar primitive,
 * i18n, or React Query — those are exercised elsewhere (`operon-switcher.test.tsx`).
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

vi.mock("@/components/demo-alert", () => ({
  DemoAlert: () => <div data-testid="demo-alert" />,
}));

vi.mock("@/components/app-sidebar", () => ({
  AppSidebar: () => <div data-testid="app-sidebar-marker" />,
}));

vi.mock("@/components/common/operon-phone-navigate", () => ({
  default: () => <div data-testid="phone-navigate-marker" />,
}));

type Slot = { children?: React.ReactNode; className?: string };
const slot =
  (testId: string) =>
  ({ children }: Slot) => <div data-testid={testId}>{children}</div>;

vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: slot("sidebar-provider"),
  SidebarInset: slot("sidebar-inset"),
}));

// Task 0.6: `useVersionCheck` reads TanStack Query's `useIsMutating()`, which throws
// without a `QueryClientProvider` — exactly the "mocked to a marker or a no-op" treatment
// this file's own doc comment already gives every dependency outside `Layout`'s own
// branching (React Query is "exercised elsewhere," per that same comment).
// `useVersionStampText` is left REAL: it touches no React Query hook, and this file
// already tolerates its harmless `fetch('/version.json')` going unmocked (a rejection
// `fetchVersionJson` swallows, same as any other dependency this suite doesn't stub).
vi.mock("@/lib/version-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/version-check")>();
  return { ...actual, useVersionCheck: () => {} };
});

const { default: Layout, usePhoneNav } = await import(
  "@/components/common/layout"
);

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
}

beforeEach(() => {
  router.pathname = "/dashboard/workspace/w1";
  router.navigate.mockClear();
  // See this file's own doc comment: jsdom has neither API, and `useSyncedIsMobile`
  // (mount-time initial read) plus the shared `use-mobile.ts` (still used elsewhere in
  // this tree, e.g. `ui/sidebar.tsx`'s own `SidebarProvider`) both call `matchMedia`.
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
  vi.unstubAllGlobals();
});

describe("Layout — Operon-mode sheet suppression (Piece B)", () => {
  beforeEach(() => {
    setViewportWidth(390);
  });

  it("below 768px renders the phone Navigate screen, never AppSidebar (so ui/sidebar.tsx's Sheet never mounts)", () => {
    render(
      <Layout>
        <div data-testid="work-content">Work</div>
      </Layout>,
    );

    expect(screen.getByTestId("phone-navigate-marker")).toBeTruthy();
    expect(screen.queryByTestId("app-sidebar-marker")).toBeNull();
    // Navigate is the landing screen: the routed Work content is not shown underneath it.
    expect(screen.queryByTestId("work-content")).toBeNull();
  });

  it("still wraps in SidebarProvider (so useSidebar() calls inside Search/NavMain/NavProjects don't throw), just never mounts AppSidebar/SidebarInset", () => {
    render(
      <Layout>
        <div data-testid="work-content">Work</div>
      </Layout>,
    );

    expect(screen.getByTestId("sidebar-provider")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-inset")).toBeNull();
  });
});

describe("Layout — desktop/tablet unchanged", () => {
  beforeEach(() => {
    setViewportWidth(1280);
  });

  it("at 768px and above still mounts AppSidebar inside SidebarInset, never the phone Navigate screen", () => {
    render(
      <Layout>
        <div data-testid="work-content">Work</div>
      </Layout>,
    );

    expect(screen.getByTestId("app-sidebar-marker")).toBeTruthy();
    expect(screen.getByTestId("sidebar-inset")).toBeTruthy();
    expect(screen.getByTestId("work-content")).toBeTruthy();
    expect(screen.queryByTestId("phone-navigate-marker")).toBeNull();
  });
});

function PhoneBack() {
  const { goBack } = usePhoneNav();
  return (
    <button type="button" onClick={goBack}>
      Back
    </button>
  );
}

describe("mounted phone route model", () => {
  it("mounts, changes routes, and remounts without navigating from render or effects", () => {
    setViewportWidth(390);
    const tree = () => (
      <StrictMode>
        <Layout>
          <PhoneBack />
        </Layout>
      </StrictMode>
    );
    const view = render(tree());
    expect(screen.getByTestId("phone-navigate-marker")).toBeTruthy();
    for (const path of [
      "/dashboard/workspace/w1/project/p1/board",
      "/dashboard/workspace/w1/project/p1/task/t1",
      "/dashboard/workspace/w1/members",
    ]) {
      router.pathname = path;
      view.rerender(tree());
      expect(screen.queryByTestId("phone-navigate-marker")).toBeNull();
      expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    }
    router.pathname = "/dashboard/workspace/w1";
    view.rerender(tree());
    expect(screen.getByTestId("phone-navigate-marker")).toBeTruthy();
    view.unmount();
    render(tree());
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it.each([
    [
      "/dashboard/workspace/w1/project/p1/task/t1",
      "/dashboard/workspace/w1/project/p1/board",
    ],
    ["/dashboard/workspace/w1/project/p1/board", "/dashboard/workspace/w1"],
    ["/dashboard/workspace/w1/members", "/dashboard/workspace/w1"],
    ["/unknown", "/dashboard"],
  ])("back from %s navigates once, only on click", (path, to) => {
    router.pathname = path;
    render(
      <StrictMode>
        <PhoneBack />
      </StrictMode>,
    );
    expect(router.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith({ to });
  });

  it("loads the apex helper only on a root back click", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    render(<PhoneBack />);
    expect(assign).not.toHaveBeenCalled();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Back" })),
    );
    expect(assign).toHaveBeenCalledExactlyOnceWith(
      "https://operon.example.test",
    );
    expect(router.navigate).not.toHaveBeenCalled();
  });
});
