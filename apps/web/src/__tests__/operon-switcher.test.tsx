import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type * as React from "react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLoadedVersionForTests } from "@/lib/version-check";

/**
 * Operon fork check (spec R14, task B11; extended by task G11; rebuilt for the rail-parity
 * fix brief, John 2026-09-21).
 *
 * Claims, one test each:
 *
 *  1. `OperonModuleNav variant="top"` renders all FIVE Operon modules except Settings, in
 *     `branding.ts`'s order, with Initiative marked as the module the user is already in.
 *  1b. `variant="settings"` renders Settings alone — the module list is never duplicated
 *     across the two variants and Settings never appears in the top one.
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
 *  4. Every addressable module resolves to its OWN hash address — Stream to
 *     `${apex}/#/activity`, Telegraph to `${apex}/#/telegraph`, Stash to `${apex}/#/files`,
 *     Settings to `${apex}/#/settings` — never the bare apex root (John, 2026-09-21: fixed
 *     the rail bug where clicking any module but Stream from inside Initiative landed on
 *     Stream, because a cold mount at the bare root had no route to read). Asserting only
 *     Stream would pass a version that still sent every other module there.
 *  4b. The rail rows stay left-aligned (rail-parity check, John 2026-09-21): no row carries
 *     a `justify-center` class. Unlike the Operon-side rail, this one never needed a fix —
 *     see `ModuleRow`'s own doc comment in `operon-switcher.tsx` for why — but a future
 *     `justify-center` addition WOULD centre these rows for real (this fork's base-layer
 *     touch-target rule does not reach `<a>`/`<span>`), so this guards against
 *     reintroducing the bug the Operon side actually had.
 *  5. The FIRST module reads *Stream ⚡* while its KEY stays `signals`. Its POSITION is
 *     asserted too: the operator's 2026-09-11 decision put Stream at the head of both
 *     switchers, and array order is the only thing that expresses it.
 *  6. Initiative's active row carries the mockup's active treatment — a
 *     `rgba(255,255,255,.10)` fill and an inset 3px signal-yellow bar — not a plain border,
 *     which is what the pre-rebuild switcher had.
 *  7. `AppSidebar` composes the rail in three tiers matching `Sidebar.tsx`: header (mark +
 *     top module nav), content (Kaneo's own nav), footer (Settings row + user/Sign out) —
 *     and the OLD footer contents (TrialCard, VersionDisplay) are gone, replaced per
 *     John's explicit new footer spec.
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

// Mutable so a test can sign a different person in without a reload (Codex r1 finding 1).
const auth = vi.hoisted(() => ({
  user: { id: "u-jane", name: "Jane Rivera", email: "jane@example.com" },
}));
vi.mock("@/components/providers/auth-provider/hooks/use-auth", () => ({
  useAuth: () => ({ user: auth.user }),
}));

vi.mock("@/hooks/mutations/use-sign-out", () => ({
  default: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/hooks/queries/config/use-get-config", () => ({
  default: () => ({ data: undefined }),
}));

const {
  OperonModuleNav,
  OperonPhoneModuleStrip,
  OperonRailFooter,
  OperonRailHeader,
  OperonVersionStamp,
  OPERON_MODULES,
  apexUrl,
  DEV_APEX_URL,
  __resetApexUrlWarning,
  __resetApexReadsForTests,
} = await import("@/components/operon-switcher");

/**
 * Operon's apex as the rail reads it (rail groups spec): `GET /api/talk` and
 * `GET /api/auth/session`. Default: no team link and no session (401), so the Talk item is
 * absent and the footer keeps Kaneo's name, which every older test here expects.
 */
let apexAnswers: Record<
  string,
  { status: number; body?: unknown; raw?: string }
> = {};
const fetchMock = vi.fn(async (url: string) => {
  const path = new URL(url).pathname;
  const answer = apexAnswers[path] ?? { status: 401 };
  return new Response(answer.raw ?? JSON.stringify(answer.body ?? {}), {
    status: answer.status,
  });
});

beforeEach(() => {
  apexAnswers = {};
  auth.user = { id: "u-jane", name: "Jane Rivera", email: "jane@example.com" };
  fetchMock.mockClear();
  __resetApexReadsForTests();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OperonModuleNav", () => {
  it('variant="top" renders every module except Settings, in order, with Initiative current', () => {
    render(<OperonModuleNav variant="top" />);

    const nav = screen.getByTestId("operon-module-nav");
    const rendered = Array.from(
      nav.querySelectorAll("[data-module]") as NodeListOf<HTMLElement>,
    );
    expect(rendered.map((element) => element.dataset.module)).toEqual([
      "signals",
      "telegraph",
      "initiative",
      "files",
      "desk",
      "inbox",
      "agents",
    ]);
    expect(
      OPERON_MODULES.filter((m) => m.key !== "settings").map((m) => m.key),
    ).toEqual([
      "signals",
      "telegraph",
      "initiative",
      "files",
      "desk",
      "inbox",
      "agents",
      "talk",
    ]);

    const initiative = screen.getByTestId("module-initiative");
    expect(initiative.getAttribute("aria-current")).toBe("page");
    expect(initiative.tagName).toBe("SPAN");
    expect(initiative.dataset.external).toBe("false");

    for (const key of [
      "telegraph",
      "signals",
      "files",
      "desk",
      "inbox",
      "agents",
    ]) {
      const element = screen.getByTestId(`module-${key}`);
      expect(element.tagName).toBe("A");
      expect(element.dataset.external).toBe("true");
      expect(element.getAttribute("aria-current")).toBeNull();
    }
  });

  it('variant="settings" renders Settings alone', () => {
    render(<OperonModuleNav variant="settings" />);

    const nav = screen.getByTestId("operon-settings-nav");
    const rendered = Array.from(
      nav.querySelectorAll("[data-module]") as NodeListOf<HTMLElement>,
    );
    expect(rendered.map((element) => element.dataset.module)).toEqual([
      "settings",
    ]);
  });

  it("gives Initiative's row a rgba(255,255,255,.10) fill and an inset 3px yellow bar, not a plain border", () => {
    render(<OperonModuleNav variant="top" />);

    const initiative = screen.getByTestId("module-initiative");
    expect(initiative.style.backgroundColor).toBe("rgba(255, 255, 255, 0.1)");
    expect(initiative.style.boxShadow).toContain("inset");
    expect(initiative.style.boxShadow).toContain("3px");
    expect(initiative.style.boxShadow.toLowerCase()).toContain("#f5b700");

    const telegraph = screen.getByTestId("module-telegraph");
    expect(telegraph.style.backgroundColor).toBe("transparent");
    expect(telegraph.style.boxShadow).toBe("none");
  });

  it("targets the Telegraph apex host from configuration, not a literal", () => {
    // A host that exists in no source file, so only a configured read can produce it.
    vi.stubEnv("VITE_OPERON_APEX_URL", "https://apex.b11.test:9443/");

    render(<OperonModuleNav variant="top" />);

    const telegraph = screen.getByTestId("module-telegraph");
    expect(telegraph.getAttribute("href")).toBe(
      "https://apex.b11.test:9443/#/telegraph",
    );
    // The dev fallback must not have been used while a value was configured.
    expect(telegraph.getAttribute("href")).not.toContain("lvh.me");
  });

  it("sends every module to its own address, never the bare apex root (John, 2026-09-21 rail bug)", () => {
    // THE BUG: `moduleHref` used to route Stream alone to `#/activity` and send every
    // other module to the bare apex root with no hash — and this link is a full
    // cross-origin navigation (`window.location.assign`), so the Operon side always cold
    // mounts on the far end. A cold mount at the bare root has no route to read, so
    // `initialModule()` fell through to `LANDING_MODULE` (Stream) regardless of which
    // module was clicked: from Initiative, every rail click except Stream and Settings
    // landed on Stream. Every addressable module is asserted individually so a version
    // that fixed only Stream (or only Telegraph) would still fail here.
    vi.stubEnv("VITE_OPERON_APEX_URL", "https://apex.g11.test:9443/");

    render(<OperonModuleNav variant="top" />);

    expect(screen.getByTestId("module-signals").getAttribute("href")).toBe(
      "https://apex.g11.test:9443/#/activity",
    );
    expect(screen.getByTestId("module-telegraph").getAttribute("href")).toBe(
      "https://apex.g11.test:9443/#/telegraph",
    );
    expect(screen.getByTestId("module-files").getAttribute("href")).toBe(
      "https://apex.g11.test:9443/#/files",
    );
    expect(screen.getByTestId("module-desk").getAttribute("href")).toBe(
      "https://apex.g11.test:9443/#/desk",
    );
    expect(screen.getByTestId("module-inbox").getAttribute("href")).toBe(
      "https://apex.g11.test:9443/#/inbox",
    );
    expect(screen.getByTestId("module-agents").getAttribute("href")).toBe(
      "https://apex.g11.test:9443/#/agents",
    );

    // Initiative is the current module: a span, so it carries no href at all.
    expect(
      screen.getByTestId("module-initiative").getAttribute("href"),
    ).toBeNull();
  });

  it('sends Settings to its own address too (variant="settings")', () => {
    vi.stubEnv("VITE_OPERON_APEX_URL", "https://apex.g11-settings.test:9443/");

    render(<OperonModuleNav variant="settings" />);

    expect(screen.getByTestId("module-settings").getAttribute("href")).toBe(
      "https://apex.g11-settings.test:9443/#/settings",
    );
  });

  it("keeps every row left-aligned: no row carries a justify-center class (rail-parity check)", () => {
    // John, 2026-09-21: "apply the same rail left-alignment fix to the fork rail." The
    // Operon-side rail (`app/src/shell/Sidebar.tsx`) DID need `!justify-start`, because
    // its rows are `<button>` and `index.css`'s `@layer base` touch-target rule forces
    // `justify-content: center` on every one, with no real CSS cascade layer in that
    // build to let a bare utility outrank it. Neither half applies here: `ModuleRow`
    // renders `<a>`/`<span>`, and this fork's OWN equivalent base rule explicitly
    // excludes `<a>` from its centering clause (see `index.css`'s "Touch targets"
    // comment) — confirmed live against the running stack, `justifyContent` reads
    // `"normal"` (flex-start) on every row, not `"center"`. This test does not assert a
    // fix; it asserts the ABSENCE of the class that would reintroduce the bug, since
    // adding `justify-center` here WOULD actually centre these rows (no base rule would
    // fight it the way it does on the Operon side).
    render(<OperonModuleNav variant="top" />);
    render(<OperonModuleNav variant="settings" />);

    // Talk renders only with a team link (asserted on its own below); none here.
    for (const module of OPERON_MODULES.filter((m) => m.key !== "talk")) {
      const row = screen.getByTestId(`module-${module.key}`);
      expect(row.className).not.toMatch(/justify-center/);
    }
  });

  it("labels the first module Stream, keeping `signals` as its key", () => {
    // `app/src/shell/branding.ts` says Stream ⚡ and lists it first, and this list is a hand
    // copy of that one. The KEY is the cross-repository contract and must not follow the
    // label; nor must the hash route, which stays `#/activity` (Operon spec D7).
    render(<OperonModuleNav variant="top" />);

    expect(OPERON_MODULES[0].key).toBe("signals");
    const activity = screen.getByTestId("module-signals");
    expect(activity.dataset.module).toBe("signals");
    expect(activity.textContent).toContain("Stream");
    expect(activity.textContent).not.toContain("Activity");
    expect(activity.textContent).toContain("⚡");
    expect(activity.textContent).not.toContain("Signals");
  });

  it("lists Stash as the fifth module, key `files`", () => {
    render(<OperonModuleNav variant="top" />);

    const stash = screen.getByTestId("module-files");
    expect(stash.textContent).toContain("Stash");
    expect(stash.textContent).toContain("📁");
  });

  it("renders the Products, then Tools, then the separate Settings row (rail groups spec)", () => {
    // The rail as AppSidebar composes it: the top list, then Settings in its own nav.
    const { container } = render(
      <>
        <OperonModuleNav variant="top" />
        <OperonModuleNav variant="settings" />
      </>,
    );
    const rows = Array.from(
      container.querySelectorAll("[data-module]") as NodeListOf<HTMLElement>,
    );
    const labels = [
      "Stream",
      "Telegraph",
      "Initiative",
      "Stash",
      "SmartDesk",
      "Inbox",
      "Agents",
      "Settings",
    ];
    expect(rows).toHaveLength(labels.length);
    rows.forEach((row, index) => {
      expect(row.textContent).toContain(labels[index]);
    });
    expect(rows[4].textContent).toContain("🎫");
    // Settings is its own row, not an entry of the top list.
    expect(
      screen
        .getByTestId("operon-module-nav")
        .querySelector('[data-module="settings"]'),
    ).toBeNull();
    expect(
      screen
        .getByTestId("operon-settings-nav")
        .querySelector('[data-module="settings"]'),
    ).not.toBeNull();
  });
});

describe("OperonModuleNav — rail groups (John, 2026-10-11)", () => {
  it("renders Products unlabelled, then TOOLS on its own top border, matching Operon's rail", () => {
    render(<OperonModuleNav variant="top" />);

    const nav = screen.getByTestId("operon-module-nav");
    const groups = Array.from(nav.querySelectorAll("fieldset"));
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "Products",
      "Tools",
    ]);
    const keys = (testId: string) =>
      Array.from(
        screen
          .getByTestId(testId)
          .querySelectorAll("[data-module]") as NodeListOf<HTMLElement>,
      ).map((el) => el.dataset.module);
    expect(keys("rail-group-products")).toEqual([
      "signals",
      "telegraph",
      "initiative",
      "files",
      "desk",
    ]);
    expect(keys("rail-group-tools")).toEqual(["inbox", "agents"]);
    // John's fit ruling: no label above Products; the Tools group's own top border is the
    // divider and "Tools" sits on it — never a header row of its own.
    const products = screen.getByTestId("rail-group-products");
    const tools = screen.getByTestId("rail-group-tools");
    expect(products.textContent).not.toContain("Products");
    expect(products.style.borderTop).toBe("");
    expect(tools.style.borderTop).toContain("1px solid");
    expect(tools.firstElementChild?.textContent).toBe("Tools");
    expect(tools.firstElementChild?.className).toContain("absolute");
  });

  it("shows Talk last in Tools once Operon answers with a team link, and opens it as a button", async () => {
    const link = "https://mega.nz/chat/AbCdEfGh#secret-key";
    apexAnswers["/api/talk"] = {
      status: 200,
      body: { rooms: [{ scope: "team", url: link }] },
    };
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<OperonModuleNav variant="top" />);

    const talk = await screen.findByTestId("module-talk");
    expect(talk.tagName).toBe("BUTTON");
    expect(talk.textContent).toBe("📞 Talk");
    // A button is centred by index.css's touch-target rule unless the row says otherwise.
    expect(talk.className).toContain("justify-start");
    const tools = screen.getByTestId("rail-group-tools");
    expect(tools.lastElementChild).toBe(talk);
    // The link is a join credential (Talk spec R4): never in the DOM.
    expect(document.body.innerHTML).not.toContain("mega.nz");
    fireEvent.click(talk);
    expect(open).toHaveBeenCalledWith(link, "_blank", "noopener,noreferrer");
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/talk")),
    ).toBe(true);
  });

  it("leaves Talk out when Operon has no team room", async () => {
    apexAnswers["/api/talk"] = { status: 200, body: { rooms: [] } };
    render(<OperonModuleNav variant="top" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("module-talk")).toBeNull();
  });
});

describe("apex reads stay fresh and log no body (Codex round 1)", () => {
  it("drops the Talk row when the room is cleared and the window regains focus", async () => {
    apexAnswers["/api/talk"] = {
      status: 200,
      body: {
        rooms: [{ scope: "team", url: "https://mega.nz/chat/AbCdEfGh#k" }],
      },
    };
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    render(<OperonModuleNav variant="top" />);
    await screen.findByTestId("module-talk");

    apexAnswers["/api/talk"] = { status: 200, body: { rooms: [] } };
    now += 5_000; // past the refresh dedupe, well inside the 30 s mount stale time
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByTestId("module-talk")).toBeNull());
  });

  it("asks again when the tab becomes visible", async () => {
    apexAnswers["/api/talk"] = { status: 200, body: { rooms: [] } };
    let now = 2_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    render(<OperonModuleNav variant="top" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    apexAnswers["/api/talk"] = {
      status: 200,
      body: {
        rooms: [{ scope: "team", url: "https://mega.nz/chat/AbCdEfGh#k" }],
      },
    };
    now += 5_000;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByTestId("module-talk");
  });

  it("shows the new person's Operon name when a different user signs in", async () => {
    apexAnswers["/api/auth/session"] = {
      status: 200,
      body: { displayName: "Jane (Operon)" },
    };
    const { rerender } = render(<OperonRailFooter />);
    await waitFor(() =>
      expect(screen.getByTestId("operon-rail-footer").textContent).toContain(
        "Jane (Operon)",
      ),
    );

    apexAnswers["/api/auth/session"] = {
      status: 200,
      body: { displayName: "Omar (Operon)" },
    };
    auth.user = {
      id: "u-omar",
      name: "Omar Haddad",
      email: "omar@example.com",
    };
    rerender(<OperonRailFooter />);
    await waitFor(() =>
      expect(screen.getByTestId("operon-rail-footer").textContent).toContain(
        "Omar (Operon)",
      ),
    );
    expect(screen.getByTestId("operon-rail-footer").textContent).not.toContain(
      "Jane",
    );
  });

  it("logs a malformed Talk answer by class only, never its text", async () => {
    apexAnswers["/api/talk"] = {
      status: 200,
      raw: "<html>https://mega.nz/chat/AbCdEfGh#secret</html>",
    };
    const errors = vi.mocked(console.error);
    render(<OperonModuleNav variant="top" />);
    await waitFor(() => expect(errors).toHaveBeenCalled());

    const logged = errors.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain('"reason":"malformed"');
    expect(logged).not.toContain("mega.nz");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("html");
    expect(screen.queryByTestId("module-talk")).toBeNull();
  });
});

describe("apex reads: order, user change, unset apex (Codex round 2)", () => {
  it("never restores a join link from an older read that lands after a newer 403", async () => {
    let releaseOld: (res: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseOld = resolve;
        }),
    );
    let now = 3_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    render(<OperonModuleNav variant="top" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    apexAnswers["/api/talk"] = { status: 403 };
    now += 5_000;
    fireEvent.focus(window);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    releaseOld(
      new Response(
        JSON.stringify({
          rooms: [{ scope: "team", url: "https://mega.nz/chat/Old#k" }],
        }),
        { status: 200 },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("module-talk")).toBeNull();
  });

  it("never paints the previous person's Operon name after a user change", async () => {
    apexAnswers["/api/auth/session"] = {
      status: 200,
      body: { displayName: "Jane (Operon)" },
    };
    // Records the footer on every commit, before passive effects run — the frame a
    // clear-in-useEffect would still have shown the old name in.
    const frames: string[] = [];
    function Probe() {
      useLayoutEffect(() => {
        frames.push(
          document.querySelector("[data-testid='operon-rail-footer']")
            ?.textContent ?? "",
        );
      });
      return null;
    }
    const { rerender } = render(
      <>
        <OperonRailFooter />
        <Probe />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("operon-rail-footer").textContent).toContain(
        "Jane (Operon)",
      ),
    );

    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    auth.user = {
      id: "u-omar",
      name: "Omar Haddad",
      email: "omar@example.com",
    };
    frames.length = 0;
    rerender(
      <>
        <OperonRailFooter />
        <Probe />
      </>,
    );
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(frame).not.toContain("Jane");
    expect(screen.getByTestId("operon-rail-footer").textContent).toContain(
      "Omar Haddad",
    );
  });

  it("sends no credentialed read when a built bundle has no apex configured", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_OPERON_APEX_URL", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    apexAnswers["/api/auth/session"] = {
      status: 200,
      body: { displayName: "Jane (Operon)" },
    };
    apexAnswers["/api/talk"] = {
      status: 200,
      body: { rooms: [{ scope: "team", url: "https://mega.nz/chat/X#k" }] },
    };
    render(
      <>
        <OperonModuleNav variant="top" />
        <OperonRailFooter />
      </>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("module-talk")).toBeNull();
    expect(screen.getByTestId("operon-rail-footer").textContent).toContain(
      "Jane Rivera",
    );
  });
});

describe("OperonRailFooter", () => {
  it("shows the Operon display name once Operon's session answers (rail groups spec)", async () => {
    apexAnswers["/api/auth/session"] = {
      status: 200,
      body: { displayName: "Jane R. (Operon)" },
    };
    render(<OperonRailFooter />);

    await waitFor(() =>
      expect(screen.getByTestId("operon-rail-footer").textContent).toContain(
        "Jane R. (Operon)",
      ),
    );
    expect(screen.getByTestId("operon-rail-footer").textContent).not.toContain(
      "Jane Rivera",
    );
  });

  it("shows the signed-in user's name and a Sign out button, not a menu", () => {
    render(<OperonRailFooter />);

    expect(screen.getByTestId("operon-rail-footer").textContent).toContain(
      "Jane Rivera",
    );
    const signOut = screen.getByRole("button", { name: "Sign out" });
    expect(signOut).toBeTruthy();
    // 44px minimum hit area, matching the shell's own footer button.
    expect(signOut.className).toContain("min-h-[44px]");

    // A visible action, not a dropdown trigger: clicking it must not throw even with the
    // sign-out mutation mocked to a no-op.
    expect(() => fireEvent.click(signOut)).not.toThrow();
  });

  it("phone variant adds the presence dot/Online label and the bell, default does not", () => {
    render(<OperonRailFooter phone />);

    expect(
      screen.getByTestId("operon-rail-footer-presence").textContent,
    ).toContain("Online");
    expect(screen.getByTestId("notification-dropdown")).toBeTruthy();

    cleanup();
    render(<OperonRailFooter />);
    expect(screen.queryByTestId("operon-rail-footer-presence")).toBeNull();
    expect(screen.queryByTestId("notification-dropdown")).toBeNull();
  });
});

/**
 * iPhone pass 1, defect 4 (John, desktop 2026-09-23): the stamp used to render top-right
 * of `OperonRailHeader`'s own row, squeezed beside the mark and truncated. It renders
 * nowhere in that header any more — `OperonVersionStamp`, asserted separately, is what
 * `AppSidebar`'s own footer tests (below) confirm takes its place above Settings.
 */
describe("OperonRailHeader", () => {
  it("carries the mark and workspace name, but no version stamp", () => {
    render(<OperonRailHeader />);

    expect(screen.getByTestId("operon-rail-header").textContent).toContain(
      "Operon",
    );
    expect(screen.queryByTestId("version-stamp")).toBeNull();
    // Rail groups spec (John, 2026-10-11): the bell stays, the avatar is gone, so the
    // header reads logo + name like Operon's.
    expect(screen.getByTestId("notification-dropdown")).toBeTruthy();
    expect(screen.queryByTestId("user-avatar")).toBeNull();
  });
});

/**
 * iPhone pass 1, defects 2 and 4: one shared component for the footer-placed stamp on
 * both surfaces — see its own doc comment in `operon-switcher.tsx`.
 */
describe("OperonVersionStamp", () => {
  it("renders the stamp text at 12px/60% opacity, never truncated", () => {
    render(<OperonVersionStamp />);

    const stamp = screen.getByTestId("version-stamp");
    expect(stamp.className).toContain("text-[12px]");
    expect(stamp.className).toContain("opacity-60");
    expect(stamp.className).not.toContain("truncate");
  });

  it("carries a title tooltip, never blank, with no embedded identity to read (dev build)", () => {
    render(<OperonVersionStamp />);
    const stamp = screen.getByTestId("version-stamp");
    expect(stamp.getAttribute("title")).toBe("dev build");
  });

  describe("with a real embedded identity", () => {
    beforeEach(() => {
      // `getLoadedVersion()` caches its FIRST read at the module level (by design — a real
      // document never reloads without a fresh module graph). The sibling test above
      // already rendered `OperonVersionStamp` with no stub in place, caching `null` — this
      // reset is what lets THIS test's stub actually be read instead of that stale cache.
      resetLoadedVersionForTests();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      resetLoadedVersionForTests();
    });

    it("renders v1.0 and the known-SHA tooltip — Codex round 1 finding 12: a real render, not just class/default-tooltip assertions", async () => {
      vi.stubGlobal(
        "__KANEO_LOADED_VERSION_JSON__",
        JSON.stringify({
          release: "v1.0",
          operon_sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
          fork_sha: "f4e5d6c7b8a9f4e5d6c7b8a9f4e5d6c7b8a9f4e5",
          config_hash: "deadbeef",
          built_at: "2026-09-22T12:00:00.000Z",
        }),
      );

      render(<OperonVersionStamp />);
      const stamp = screen.getByTestId("version-stamp");

      await waitFor(() => {
        expect(stamp.textContent).toBe("v1.0");
      });
      expect(stamp.getAttribute("title")).toBe(
        "Operon a1b2c3d · Initiative f4e5d6c",
      );
    });
  });
});

describe("OperonPhoneModuleStrip", () => {
  it("renders the Products and Tools tiles in order, Settings pinned in its own group, never mixed into the app tiles", () => {
    render(<OperonPhoneModuleStrip />);

    const appsGroup = screen.getByTestId("phone-module-strip-apps");
    const appTiles = Array.from(
      appsGroup.querySelectorAll("[data-module]") as NodeListOf<HTMLElement>,
    );
    expect(appTiles.map((tile) => tile.dataset.module)).toEqual([
      "signals",
      "telegraph",
      "initiative",
      "files",
      "desk",
      "inbox",
      "agents",
    ]);
    expect(
      Array.from(appsGroup.querySelectorAll("fieldset")).map((g) =>
        g.getAttribute("aria-label"),
      ),
    ).toEqual(["Products", "Tools"]);
    // Settings never appears in the scrolling apps group.
    expect(appsGroup.querySelector('[data-module="settings"]')).toBeNull();

    const settingsGroup = screen.getByTestId("phone-module-strip-settings");
    const settingsTiles = Array.from(
      settingsGroup.querySelectorAll(
        "[data-module]",
      ) as NodeListOf<HTMLElement>,
    );
    expect(settingsTiles.map((tile) => tile.dataset.module)).toEqual([
      "settings",
    ]);
  });

  it("marks Initiative as the current tile (a span, aria-current=page) and links every other tile via moduleHref", () => {
    vi.stubEnv("VITE_OPERON_APEX_URL", "https://apex.phone.test:9443/");
    render(<OperonPhoneModuleStrip />);

    const initiative = screen.getByTestId("phone-module-initiative");
    expect(initiative.tagName).toBe("SPAN");
    expect(initiative.getAttribute("aria-current")).toBe("page");
    expect(initiative.getAttribute("href")).toBeNull();

    const telegraph = screen.getByTestId("phone-module-telegraph");
    expect(telegraph.tagName).toBe("A");
    expect(telegraph.getAttribute("href")).toBe(
      "https://apex.phone.test:9443/#/telegraph",
    );

    const settings = screen.getByTestId("phone-module-settings");
    expect(settings.tagName).toBe("A");
    expect(settings.getAttribute("href")).toBe(
      "https://apex.phone.test:9443/#/settings",
    );
  });

  // iPhone pass 1, defect 3 (John, real iPhone 2026-09-23, checked on the fork's own
  // phone Navigate strip for Operon's same defect and found present the same way): this
  // strip carried no safe-area-top inset of its own before this fix, relying entirely on
  // `operon-phone-navigate.tsx`'s outer wrapper, which the list panel beside it also
  // depended on — see that file's own test for the panel's half.
  it("adds the Talk tile at the end of Tools once Operon answers with a team link", async () => {
    apexAnswers["/api/talk"] = {
      status: 200,
      body: {
        rooms: [{ scope: "team", url: "https://mega.nz/chat/AbCdEfGh#k" }],
      },
    };
    render(<OperonPhoneModuleStrip />);
    const talk = await screen.findByTestId("phone-module-talk");
    expect(talk.tagName).toBe("BUTTON");
    expect(screen.getByTestId("phone-rail-group-tools").lastElementChild).toBe(
      talk,
    );
  });

  it("carries its own top safe-area inset, not only the outer screen's", () => {
    render(<OperonPhoneModuleStrip />);
    expect(screen.getByTestId("phone-module-strip").className).toContain(
      "env(safe-area-inset-top)",
    );
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
    // Tables follow-up (2026-10-11, row 18): the TABLES group under the boards.
    vi.doMock("@/components/operon-tables/nav-tables", () => ({
      NavTables: () => <div data-testid="nav-tables" />,
    }));
    vi.doMock("@/components/search", () => ({
      default: () => <div data-testid="search" />,
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

  it("renders the Operon rail header and top module nav in the header slot, no WorkspaceSwitcher", async () => {
    const { AppSidebar } = await import("@/components/app-sidebar");

    render(<AppSidebar />);

    expect(screen.queryByTestId("workspace-switcher")).toBeNull();
    const header = screen.getByTestId("sidebar-header");
    expect(
      header.querySelector('[data-testid="operon-rail-header"]'),
    ).not.toBeNull();
    expect(
      header.querySelector('[data-testid="operon-module-nav"]'),
    ).not.toBeNull();
  });

  it("renders the Settings row and the user footer in the footer slot, not TrialCard/VersionDisplay", async () => {
    const { AppSidebar } = await import("@/components/app-sidebar");

    render(<AppSidebar />);

    const footer = screen.getByTestId("sidebar-footer");
    expect(
      footer.querySelector('[data-testid="operon-settings-nav"]'),
    ).not.toBeNull();
    expect(
      footer.querySelector('[data-testid="operon-rail-footer"]'),
    ).not.toBeNull();
    // The old footer contents are gone (John's explicit new footer spec: user name + Sign
    // out only), not merely unasserted — a regression that brought either back should fail
    // this test rather than pass silently because nothing looked for them.
    expect(screen.queryByTestId("trial-card")).toBeNull();
    expect(screen.queryByTestId("version-display")).toBeNull();
  });

  it("iPhone pass 1, defect 4: renders the version stamp once, directly above Settings", async () => {
    const { AppSidebar } = await import("@/components/app-sidebar");

    render(<AppSidebar />);

    const header = screen.getByTestId("sidebar-header");
    expect(header.querySelector('[data-testid="version-stamp"]')).toBeNull();

    const footer = screen.getByTestId("sidebar-footer");
    const stamps = screen.getAllByTestId("version-stamp");
    expect(stamps).toHaveLength(1);
    expect(footer.contains(stamps[0])).toBe(true);

    // "Directly above" as DOM order, not only visual position: the stamp's own wrapper is
    // the Settings nav's immediately preceding sibling.
    const settingsNav = footer.querySelector(
      '[data-testid="operon-settings-nav"]',
    ) as HTMLElement;
    expect(settingsNav.previousElementSibling?.contains(stamps[0])).toBe(true);
  });

  it("renders Kaneo's own nav (Search, NavMain, NavProjects) in the content slot, unstructured", async () => {
    const { AppSidebar } = await import("@/components/app-sidebar");

    render(<AppSidebar />);

    const content = screen.getByTestId("sidebar-content");
    expect(content.querySelector('[data-testid="search"]')).not.toBeNull();
    expect(content.querySelector('[data-testid="nav-main"]')).not.toBeNull();
    expect(
      content.querySelector('[data-testid="nav-projects"]'),
    ).not.toBeNull();
    // Tables follow-up (John's ruling 2026-10-11): TABLES sits under PROJECT BOARDS.
    expect(
      content.querySelector(
        '[data-testid="nav-projects"] + [data-testid="nav-tables"]',
      ),
    ).not.toBeNull();
  });
});
