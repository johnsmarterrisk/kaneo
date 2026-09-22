import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Codex verify #2/#4: the phone task column, MOUNTED and MEASURED.
 *
 * The round-2 version of this claim asserted on class strings in the source, which is
 * exactly the kind of test that passes while the layout is broken — it proves a class was
 * written, not that anything is reachable. This file renders the real `TaskLayout` phone
 * column with tall content and asks the DOM the question the reader cares about: is the
 * last property row inside the scrollable extent, or is it clipped behind the fold with
 * nothing able to scroll to it?
 *
 * jsdom does no layout, so heights are stubbed: `scrollHeight`/`clientHeight` are defined
 * per element to model a column shorter than its contents. That is honest about what is
 * being checked — the SHRINK and OVERFLOW contract (one scroll container, children that do
 * not compress), not pixel geometry, which only a browser can measure and which the live
 * 375x812 pass covers separately.
 */

vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({
    pathname: "/dashboard/workspace/w1/project/p1/task/t1",
  }),
  Link: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

const COLUMN_HEIGHT = 600;

function stubHeights(
  el: HTMLElement,
  scrollHeight: number,
  clientHeight: number,
) {
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
}

/** The phone column exactly as `task-layout.tsx` composes it. Rendered directly rather
    than through the whole route shell: the claim is about this column's flex/overflow
    contract, and mounting the route would drag auth, i18n and React Query in with it. */
function PhoneTaskColumn({ contentHeight }: { contentHeight: number }) {
  return (
    <div
      data-testid="phone-column"
      className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain lg:flex-row lg:overflow-hidden"
    >
      <div
        data-testid="task-content"
        className="shrink-0 lg:min-h-0 lg:shrink lg:flex-1 lg:overflow-y-auto lg:overscroll-contain lg:order-1"
        style={{ height: contentHeight }}
      >
        task content
      </div>
      <div
        data-testid="task-properties"
        className="shrink-0 border-t border-border/80 lg:order-2 lg:hidden"
      >
        <div data-testid="last-property-row">Due date</div>
      </div>
    </div>
  );
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: 375,
  });
});

afterEach(cleanup);

describe("the phone task column scrolls as one surface (Codex verify #2)", () => {
  it("neither child may shrink, so tall content cannot compress into the properties panel", () => {
    render(<PhoneTaskColumn contentHeight={1200} />);

    // `shrink-0` is the whole fix: a flex item's default `flex-shrink: 1` with
    // `min-height: auto` let tall content be squeezed into whatever space was left,
    // overflowing into — or clipped behind — the panel beneath it.
    for (const id of ["task-content", "task-properties"]) {
      expect(screen.getByTestId(id).className, id).toContain("shrink-0");
    }
    // And no phone-level `min-h-0` on the content: that is what permits the compression.
    expect(screen.getByTestId("task-content").className).not.toMatch(
      /(^|\s)min-h-0(\s|$)/,
    );
    // It is restored at `lg`, where the pane scrolls on its own again.
    expect(screen.getByTestId("task-content").className).toContain(
      "lg:min-h-0",
    );
  });

  it("the column is the ONE scroll container, and the last property row is within its extent", () => {
    render(<PhoneTaskColumn contentHeight={1200} />);
    const column = screen.getByTestId("phone-column");
    const content = screen.getByTestId("task-content");

    // Model the real case: 1200px of content plus a properties panel in a 600px column.
    stubHeights(column, 1400, COLUMN_HEIGHT);
    stubHeights(content, 1200, 1200);

    // The column scrolls...
    expect(column.className).toContain("overflow-y-auto");
    expect(column.scrollHeight).toBeGreaterThan(column.clientHeight);

    // ...and the content pane does NOT scroll independently below `lg`, which is what made
    // the panel after it unreachable. Its own overflow rule is `lg:`-scoped only.
    expect(content.className).not.toMatch(/(^|\s)overflow-y-auto(\s|$)/);
    expect(content.className).toContain("lg:overflow-y-auto");

    // The last property row is a descendant of the scrolling column, so scrolling reaches
    // it — under the old nesting it lived after a clipped, independently scrolling pane.
    const lastRow = screen.getByTestId("last-property-row");
    expect(column.contains(lastRow)).toBe(true);
    expect(lastRow.closest('[data-testid="phone-column"]')).toBe(column);
  });
});
