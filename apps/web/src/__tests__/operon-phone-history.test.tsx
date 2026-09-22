import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { phoneNavOpenForPath } from "@/store/phone-nav";

/**
 * Codex round 1 #2, #8 and #11: the phone shell's route/history contract on the fork side.
 *
 * `phoneNavOpenForPath` is the whole of "which screen does a cold mount open", so it is
 * tested directly rather than through a mounted router: the router needs an auth session,
 * a query client and a real network to reach the point where a route is even resolved,
 * and none of that is what this claim is about. Every case below is an address a person
 * can actually arrive at — a pasted link, a notification, Operon's cross-origin hop.
 */
describe("which phone screen a cold mount opens (Codex r1 #2)", () => {
  it("opens Navigate on the workspace landing, where the list is the point", () => {
    expect(phoneNavOpenForPath("/dashboard/workspace/ws-1")).toBe(true);
    expect(phoneNavOpenForPath("/dashboard/workspace/ws-1/")).toBe(true);
  });

  it("opens WORK for a deep link, so the address is not hidden behind Navigate", () => {
    // This is the bug: every one of these used to paint the Navigate list over the exact
    // screen the link had asked for.
    expect(phoneNavOpenForPath("/dashboard/workspace/ws-1/project/p-1")).toBe(
      false,
    );
    expect(
      phoneNavOpenForPath("/dashboard/workspace/ws-1/project/p-1/board"),
    ).toBe(false);
    expect(
      phoneNavOpenForPath("/dashboard/workspace/ws-1/project/p-1/task/t-9"),
    ).toBe(false);
  });

  it("falls back to Navigate for an address outside the workspace tree", () => {
    // Settings, onboarding, invitations: no Work screen is being named, so the list is
    // the safe answer — it is always reachable and never traps the reader.
    expect(phoneNavOpenForPath("/dashboard/settings/account")).toBe(true);
    expect(phoneNavOpenForPath("/")).toBe(true);
  });
});

describe("the viewport meta (Codex r1 #8)", () => {
  const INDEX_HTML = readFileSync(join(process.cwd(), "index.html"), "utf8");

  it("declares viewport-fit=cover, or every safe-area inset in the shell is zero on iOS", () => {
    // The phone shell pads for the notch in three places (top bar, pinned Settings tile,
    // footer). Without this attribute iOS reports each `env(safe-area-inset-*)` as 0 and
    // all three silently do nothing on exactly the devices they exist for.
    expect(INDEX_HTML).toMatch(/name="viewport"[^>]*viewport-fit=cover/);
  });

  it("keeps the pre-paint silhouette to phone widths (Codex r1 #13)", () => {
    // Shown at desktop widths it contradicts "desktop loading is unchanged".
    expect(INDEX_HTML).toMatch(/@media \(max-width: 767px\)/);
  });
});

describe("the phone task-detail layout (Codex r1 #10, #15)", () => {
  const TASK_LAYOUT = readFileSync(
    join(process.cwd(), "src/components/common/task-layout.tsx"),
    "utf8",
  );
  const TASK_CONTENT = readFileSync(
    join(process.cwd(), "src/components/task/task-details-content.tsx"),
    "utf8",
  );

  it("puts task content before the properties panel on a phone", () => {
    // The bug: below `lg` the panel was `order-1` and the task itself `order-2`, so a
    // phone showed a block of metadata before the task's own title — the opposite of the
    // Asana reference. Source order now decides below `lg`, so neither block carries a
    // phone-level `order-*`; only the `lg:` split does.
    expect(TASK_LAYOUT).not.toMatch(/className="order-1[^"]*lg:order-2/);
    expect(TASK_LAYOUT).not.toMatch(/className="order-2[^"]*lg:order-1/);
    expect(TASK_LAYOUT).toContain("lg:order-1");
    expect(TASK_LAYOUT).toContain("lg:order-2");
  });

  // Codex verify #4: the sizing/scroll claim moved to `operon-phone-task-scroll.test.tsx`,
  // which MOUNTS the column and measures it. Asserting class strings here proved a class
  // had been written, not that the last property row was reachable — precisely the kind of
  // test that stays green while the layout is broken.

  it("states the tablet behaviour the code actually has", () => {
    // The compact assignee/due row is `md:hidden`, so it cannot be showing at 768-1023px
    // alongside the panel — the old comment claimed it was.
    expect(TASK_CONTENT).toContain("flex md:hidden");
    expect(TASK_CONTENT).not.toContain("accepted redundancy");
  });
});
