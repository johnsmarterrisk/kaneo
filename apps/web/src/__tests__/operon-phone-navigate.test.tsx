import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `OperonPhoneNavigate` — iPhone pass 1, defects 2 and 3 (John, real iPhone 2026-09-23).
 *
 * Defect 2 (stamp placement): the version stamp used to render beside the "Initiative ›"
 * chevron, in the list panel's own header row — the fork's counterpart to the Operon
 * shell's `MobileNavigate.tsx` header, which had the identical defect. It now renders once,
 * at the very bottom of the screen, below `OperonRailFooter phone`.
 *
 * Defect 3 (top inset): checked on this fork's own phone Navigate strip for the same
 * defect Operon's `MobileNavigate.tsx` strip had (the Stream tile sitting under the status
 * bar while the list panel was correctly inset) and found present the same way — this
 * file's outer wrapper used to carry the ONLY `env(safe-area-inset-top)` padding, relied on
 * by both the strip and the panel beside it. Both now carry their own.
 *
 * Real `OperonPhoneModuleStrip`/`OperonRailFooter`/`OperonVersionStamp` render (the claims
 * are about how THIS file composes them); Kaneo's own `Search`/`NavMain`/`NavProjects` are
 * mocked to markers, the same scope line `operon-switcher.test.tsx` draws for its own
 * `AppSidebar` suite.
 */

vi.mock("@/components/nav-main", () => ({
  NavMain: () => <div data-testid="nav-main" />,
}));
vi.mock("@/components/nav-projects", () => ({
  NavProjects: () => <div data-testid="nav-projects" />,
}));
vi.mock("@/components/search", () => ({
  default: () => <div data-testid="search" />,
}));
vi.mock("@/components/notification/notification-dropdown", () => ({
  default: () => <div data-testid="notification-dropdown" />,
}));
vi.mock("@/components/providers/auth-provider/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { name: "Jane Rivera", email: "jane@example.test" },
  }),
}));
vi.mock("@/hooks/mutations/use-sign-out", () => ({
  default: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/queries/config/use-get-config", () => ({
  default: () => ({ data: undefined }),
}));

const { default: OperonPhoneNavigate } = await import(
  "@/components/common/operon-phone-navigate"
);

afterEach(() => {
  cleanup();
});

describe("OperonPhoneNavigate — iPhone pass 1, defect 2 (stamp placement)", () => {
  it("renders no version stamp in the header row — only the chevron", () => {
    render(<OperonPhoneNavigate />);

    const header = screen.getByText("Initiative").closest("div") as HTMLElement;
    expect(header.querySelector('[data-testid="version-stamp"]')).toBeNull();
    expect(header.textContent).toContain("›");
  });

  it("renders exactly one version stamp, below the account footer, inside the safe area", () => {
    render(<OperonPhoneNavigate />);

    const stamps = screen.getAllByTestId("version-stamp");
    expect(stamps).toHaveLength(1);

    const row = screen.getByTestId("phone-navigate-version-row");
    expect(row.contains(stamps[0])).toBe(true);
    expect(row.className).toContain("env(safe-area-inset-bottom)");

    // "Below the account row" as DOM order: the stamp row is the footer's immediately
    // following sibling.
    const footer = screen.getByTestId("operon-rail-footer");
    expect(footer.nextElementSibling).toBe(row);
  });
});

describe("OperonPhoneNavigate — iPhone pass 1, defect 3 (top inset)", () => {
  it("gives the list panel its own top safe-area inset, not only the outer screen's", () => {
    render(<OperonPhoneNavigate />);

    const headerRow = screen
      .getByText("Initiative")
      .closest("div") as HTMLElement;
    const panel = headerRow.parentElement as HTMLElement;
    expect(panel.className).toContain("env(safe-area-inset-top)");
  });
});
