// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NotificationDropdown from "./notification-dropdown";

/**
 * The bell trigger's ground-context fix (John, fix brief): `OperonRailHeader` mounts this
 * component directly on the navy ground, not a white card, so the default `ghost` Button
 * variant's `text-card-foreground` (navy ink — correct on a card) read as navy-on-navy at
 * rest and only became visible once `hover:bg-secondary` painted a light fill behind it.
 * `groundContext` swaps that for `text-sidebar-foreground` (white, readable on the ground)
 * with a subtle `sidebar-accent/10` hover fill instead.
 */

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

// Avoids pulling in lib/i18n/index.ts's real i18next.use(initReactI18next).init()
// chain (triggered transitively via lib/format.ts), the same reason
// members-table.test.tsx mocks lib/format directly.
vi.mock("@/lib/format", () => ({
  formatRelativeTime: () => "2 hours ago",
  formatDateMedium: () => "Sep 1, 2026",
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/mutations/notification/use-clear-notifications", () => ({
  default: () => ({ mutate: vi.fn() }),
}));

vi.mock(
  "@/hooks/mutations/notification/use-mark-all-notifications-as-read",
  () => ({
    default: () => ({ mutate: vi.fn() }),
  }),
);

vi.mock("@/hooks/mutations/notification/use-mark-notification-as-read", () => ({
  default: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/hooks/queries/notification/use-get-notifications", () => ({
  default: () => ({ data: [] }),
}));

vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useRegisterShortcuts: vi.fn(),
  // `constants/shortcuts.ts` calls this at module scope (same requirement
  // `operon-switcher.test.tsx`'s AppSidebar mocks already document).
  getModifierKeyText: () => "Ctrl",
}));

afterEach(() => {
  cleanup();
});

describe("NotificationDropdown, groundContext", () => {
  it("the bell button carries text-sidebar-foreground at rest when groundContext is set", () => {
    render(<NotificationDropdown groundContext />);

    const trigger = screen.getByRole("button", {
      name: "navigation:notifications",
    });
    const classes = trigger.className.split(/\s+/);
    expect(classes).toContain("text-sidebar-foreground");
    expect(classes).toContain("hover:bg-sidebar-accent/10");
    // Never the card-relative token that caused the bug — as its OWN class token, not a
    // substring: `*:data-[slot=button-loading-indicator]:text-card-foreground` (the
    // loading-spinner colour, untouched and irrelevant at rest) also contains the string
    // "text-card-foreground" and must not make this assertion pass by accident.
    expect(classes).not.toContain("text-card-foreground");
  });

  it("defaults to the card-relative styling when groundContext is not set (every other mount)", () => {
    render(<NotificationDropdown />);

    const trigger = screen.getByRole("button", {
      name: "navigation:notifications",
    });
    expect(trigger.className).not.toContain("text-sidebar-foreground");
  });
});
