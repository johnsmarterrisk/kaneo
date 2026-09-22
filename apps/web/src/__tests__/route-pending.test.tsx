import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import RoutePending from "@/components/common/route-pending";

/**
 * The router's pending component (Piece B, Round 2 mobile-nav brief).
 *
 * Claim under test: while a route is loading at phone width, nothing white or grey and
 * nothing desktop-shaped is on screen — the gap is navy. This is the frame the brief's own
 * success criterion is about ("a throttled Slow 3G hop shows no frame that is white or
 * grey"), and it is the one frame no other test in this repo covers: every existing suite
 * renders a SETTLED tree, so a loading state can regress without a single test going red.
 *
 * Desktop is asserted too, in the same file and for the same reason the phone case is: the
 * brief requires the desktop shape's loading behaviour to be unchanged, and "renders
 * nothing above 768px" is exactly what the router did before this component existed.
 *
 * jsdom computes no layout and loads no stylesheet, so this reads the rendered MARKUP —
 * which element exists and what inline background it carries — rather than measuring
 * pixels. The navy is an inline `style` in the component precisely so it does not depend on
 * a stylesheet that jsdom will not load.
 */

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
}

afterEach(() => {
  cleanup();
  setViewportWidth(1024);
});

describe("RoutePending", () => {
  it("paints a navy skeleton at phone width, with no desktop chrome and nothing white", () => {
    setViewportWidth(375);
    const { container } = render(<RoutePending />);

    const pending = screen.getByTestId("route-pending-phone");
    expect(pending).toBeTruthy();
    // The ground is the pre-paint's navy (#081a33), stated inline so it cannot depend on
    // a stylesheet jsdom will not load. jsdom normalises an inline hex to its rgb() form,
    // so the assertion is on that — the same colour, as the DOM actually reports it.
    expect(pending.getAttribute("style")).toContain("rgb(8, 26, 51)");

    // No OPAQUE white anywhere in the pending tree — that is the regression this file
    // exists to catch. The skeleton's own shapes are white at 10% over the navy
    // (`rgba(255, 255, 255, 0.1)`), which is the intended silhouette and is not a white
    // frame, so the check is for full-strength white specifically.
    const backgrounds = [
      ...container.querySelectorAll<HTMLElement>("[style]"),
    ].map((el) => (el.getAttribute("style") ?? "").toLowerCase());
    for (const style of backgrounds) {
      expect(style).not.toContain("rgb(255, 255, 255)");
      expect(style).not.toContain("#fff");
    }

    // And no desktop chrome: the rail/inset markers the settled desktop tree renders.
    expect(screen.queryByTestId("app-sidebar")).toBeNull();
    expect(container.querySelector('[data-sidebar="trigger"]')).toBeNull();
    expect(container.querySelector('[data-slot="sidebar-inset"]')).toBeNull();
  });

  it("renders nothing at desktop width — the pre-existing loading behaviour, untouched", () => {
    setViewportWidth(1024);
    const { container } = render(<RoutePending />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("route-pending-phone")).toBeNull();
  });

  it("renders nothing at the 768px boundary itself — 768 is tablet, not phone", () => {
    setViewportWidth(768);
    const { container } = render(<RoutePending />);

    expect(container.firstChild).toBeNull();
  });
});
