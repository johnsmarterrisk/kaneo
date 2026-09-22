import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

/**
 * The "completely dead app" smoke (operator rule, 2026-09-22).
 *
 * WHY THIS FILE EXISTS. Piece B shipped an `index.html` whose navy skeleton lived INSIDE
 * `<div id="root">`. `main.tsx` mounts behind `if (!rootElement.innerHTML)`, so a non-empty
 * `#root` made that guard false and React never called `render()` — the app was completely
 * dead, with ZERO console errors, and every check in this repo stayed green: typecheck,
 * biome and all 233 vitest tests passed against an application that rendered nothing at
 * all. Only loading the real origin in a browser caught it. That is the class of failure
 * this test closes.
 *
 * WHAT IT ACTUALLY EXERCISES, AND WHY NOT A FULL BOOT. Importing `main.tsx` would run the
 * router, the auth provider, i18n and React Query against a network that does not exist in
 * jsdom — a slow, flaky test whose failures would mostly not be about mounting. The real
 * bug was never in a component: it was in the CONTRACT between the shipped `index.html` and
 * `main.tsx`'s mount guard. So this reads the REAL `index.html` off disk, rebuilds its body
 * markup in the test document, applies the exact same guard `main.tsx` applies, and asserts
 * a render actually lands. If anyone puts anything back inside `#root`, this goes red for
 * the same reason the app would go dead.
 */

const INDEX_HTML = readFileSync(join(process.cwd(), "index.html"), "utf8");

/** `main.tsx:104`'s guard, copied verbatim rather than imported — importing it would boot
    the whole application. The duplication is the point: if that line changes shape, the
    comment below is what sends a reader to check this file too. */
function mountLikeMainTsx(rootElement: HTMLElement): boolean {
  if (!rootElement.innerHTML) {
    const root = createRoot(rootElement);
    act(() => {
      root.render(<div data-testid="app-tree">mounted</div>);
    });
    return true;
  }
  return false;
}

describe("the app mounts at all", () => {
  it("index.html ships an EMPTY #root, so main.tsx's mount guard lets React render", () => {
    // The shipped markup, not a hand-written stand-in: this is the file the container
    // serves, so a regression in it is a regression in what users load.
    expect(INDEX_HTML).toContain('<div id="root"></div>');

    document.body.innerHTML = '<div id="root"></div>';
    const rootElement = document.getElementById("root") as HTMLElement;

    const didMount = mountLikeMainTsx(rootElement);

    expect(didMount, "main.tsx's guard refused to mount").toBe(true);
    expect(document.querySelector('[data-testid="app-tree"]')).toBeTruthy();
    expect(rootElement.children.length).toBeGreaterThan(0);
  });

  it("proves the guard is what kills it: anything inside #root and nothing renders", () => {
    // This is the exact shape of the shipped bug, asserted so the mechanism is written
    // down rather than rediscovered the next time someone wants a pre-paint placeholder.
    document.body.innerHTML =
      '<div id="root"><div class="operon-skeleton"></div></div>';
    const rootElement = document.getElementById("root") as HTMLElement;

    const didMount = mountLikeMainTsx(rootElement);

    expect(didMount).toBe(false);
    expect(document.querySelector('[data-testid="app-tree"]')).toBeNull();
  });

  it("keeps the navy skeleton OUTSIDE #root, where it cannot block the mount", () => {
    const rootIndex = INDEX_HTML.indexOf('<div id="root"></div>');
    const skeletonIndex = INDEX_HTML.indexOf('id="operon-skeleton"');

    expect(rootIndex, "#root not found in index.html").toBeGreaterThan(-1);
    expect(skeletonIndex, "the navy skeleton is gone").toBeGreaterThan(-1);
    // Sibling, and BEFORE #root so it paints first — never a child of it.
    expect(skeletonIndex).toBeLessThan(rootIndex);
  });
});
