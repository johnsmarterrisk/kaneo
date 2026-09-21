import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "./members";

/**
 * Codex round-2 finding 6: the `canInviteUsers()` gate on this route's "Managed by
 * Operon" header (Codex round-1 finding 13) had no regression test for either branch.
 *
 * Two claims:
 *  1. An admin (`canInviteUsers` true) sees the badge AND the link to Operon Settings.
 *  2. A member (`canInviteUsers` false) sees the badge alone — no link, so nobody
 *     follows it to a page `SettingsView.tsx` would only land them on Account anyway
 *     (the dead-end this gate exists to avoid).
 *
 * Mocking pattern (`createFileRoute` returning `{...options, useParams}`) copied from
 * `gantt.test.tsx`, the established shape for testing a TanStack file-route component
 * directly rather than through a full router.
 */

const routeParams = { workspaceId: "workspace-1" };
const canInviteUsers = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    ...(options as Record<string, unknown>),
    useParams: () => routeParams,
  }),
}));

vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({ canInviteUsers: () => canInviteUsers() }),
}));

vi.mock("@/hooks/queries/workspace/use-get-full-workspace", () => ({
  default: () => ({ data: { members: [], invitations: [] } }),
}));

vi.mock("@/components/operon-switcher", () => ({
  apexUrl: () => "https://operon.example.test",
}));

vi.mock("@/components/team/members-table", () => ({
  default: () => <div data-testid="members-table" />,
}));

vi.mock("@/components/common/workspace-layout", () => ({
  default: ({
    headerActions,
    children,
  }: {
    headerActions?: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      <div data-testid="header-actions">{headerActions}</div>
      {children}
    </div>
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const MembersRoute = (Route as unknown as { component: ComponentType })
  .component;

afterEach(() => {
  cleanup();
  canInviteUsers.mockReset();
});

describe("Members route, the canInviteUsers() gate", () => {
  it("shows the badge and the Operon Settings link for an admin", () => {
    canInviteUsers.mockReturnValue(true);

    render(<MembersRoute />);

    expect(screen.getByText("Managed by Operon")).toBeTruthy();
    const link = screen.getByRole("link", {
      name: /team:members.inviteMember/,
    });
    expect(link.getAttribute("href")).toBe(
      "https://operon.example.test/#/settings",
    );
  });

  it("shows only the badge for a member — no dead-end link", () => {
    canInviteUsers.mockReturnValue(false);

    render(<MembersRoute />);

    expect(screen.getByText("Managed by Operon")).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: /team:members.inviteMember/ }),
    ).toBeNull();
  });
});
