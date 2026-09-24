import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OperonVersionAbout from "@/components/common/operon-version-about";
import { resetLoadedVersionForTests } from "@/lib/version-check";

/**
 * OperonVersionAbout — Versioning v1 (Operon repo's
 * `docs/specs/versioning-v1-mini-spec.md`, task 8): the always-visible About block on the
 * account/information settings page carrying the version and both full SHAs, since the
 * chrome stamp (`OperonVersionStamp`) now shows the version alone and moves the SHAs to a
 * hover tooltip nothing on a phone can trigger.
 */

beforeEach(() => {
  resetLoadedVersionForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OperonVersionAbout", () => {
  it("renders the version and both full SHAs from the same embedded identity OperonVersionStamp reads", async () => {
    vi.stubGlobal(
      "__KANEO_LOADED_VERSION_JSON__",
      JSON.stringify({
        release: "2026.09.22-4",
        operon_sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        fork_sha: "f4e5d6c7b8a9f4e5d6c7b8a9f4e5d6c7b8a9f4e5",
        config_hash: "deadbeef",
        built_at: "2026-09-22T12:00:00.000Z",
      }),
    );

    render(<OperonVersionAbout />);

    await waitFor(() => {
      expect(screen.getByTestId("about-version-release").textContent).toBe(
        "v2026.09.22-4",
      );
    });
    // Full SHAs, not the shortened 7-char tooltip form — a support ticket needs to be
    // able to copy-paste the exact commit.
    expect(screen.getByTestId("about-version-operon-sha").textContent).toBe(
      "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    );
    expect(screen.getByTestId("about-version-fork-sha").textContent).toBe(
      "f4e5d6c7b8a9f4e5d6c7b8a9f4e5d6c7b8a9f4e5",
    );
  });

  it('renders "dev" and "unknown" for a local build with no release identity, never throwing', async () => {
    vi.stubGlobal(
      "__KANEO_LOADED_VERSION_JSON__",
      JSON.stringify({
        release: "",
        operon_sha: "unknown",
        fork_sha: "unknown",
        config_hash: "deadbeef",
        built_at: "2026-09-22T12:00:00.000Z",
      }),
    );

    render(<OperonVersionAbout />);

    await waitFor(() => {
      expect(screen.getByTestId("about-version-release").textContent).toBe(
        "dev",
      );
    });
    expect(screen.getByTestId("about-version-operon-sha").textContent).toBe(
      "unknown",
    );
    expect(screen.getByTestId("about-version-fork-sha").textContent).toBe(
      "unknown",
    );
  });

  it('renders "unknown" placeholders before the embedded identity resolves, never a blank cell', () => {
    vi.stubGlobal("__KANEO_LOADED_VERSION_JSON__", undefined);
    render(<OperonVersionAbout />);
    expect(screen.getByTestId("about-version-operon-sha").textContent).toBe(
      "unknown",
    );
    expect(screen.getByTestId("about-version-fork-sha").textContent).toBe(
      "unknown",
    );
  });
});
