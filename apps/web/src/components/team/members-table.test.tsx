import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceUser,
  WorkspaceUserInvitation,
} from "@/types/workspace-user";
import MembersTable from "./members-table";

const copyToClipboard = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("@/lib/copy-to-clipboard", () => ({
  copyToClipboard: (text: string) => copyToClipboard(text),
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: (msg: string) => success(msg),
    error: (msg: string) => error(msg),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/format", () => ({
  formatDateMedium: () => "Sep 1, 2026",
}));

vi.mock("@/hooks/mutations/workspace-user/use-cancel-invitation", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/mutations/workspace-user/use-delete-workspace-user", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock(
  "@/hooks/mutations/workspace-user/use-update-workspace-user-role",
  () => ({
    default: () => ({ mutateAsync: vi.fn() }),
  }),
);

vi.mock("@/hooks/queries/workspace/use-workspace-roles", () => ({
  default: () => ({ data: [] }),
}));

vi.mock("../providers/auth-provider/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "current-user" } }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const pendingInvitation = {
  id: "invite-1",
  email: "invitee@example.com",
  role: "member",
  status: "pending",
  expiresAt: "2026-09-01T00:00:00.000Z",
} as unknown as WorkspaceUserInvitation;

const owner = {
  id: "member-1",
  userId: "owner-user",
  role: "owner",
  createdAt: "2026-08-01T00:00:00.000Z",
  user: { email: "owner@example.com", name: "Owner Person", image: null },
} as unknown as WorkspaceUser;

const member = {
  id: "member-2",
  userId: "member-user",
  role: "member",
  createdAt: "2026-08-01T00:00:00.000Z",
  user: { email: "member@example.com", name: "Member Person", image: null },
} as unknown as WorkspaceUser;

/**
 * Operon mode (spec R14, GUI pass task 4a; docs/fork-discipline.md row 13): `MembersTable`
 * no longer consults `useWorkspacePermission` at all — `canChangeRoles`, `canRemove` and
 * `canInvite` are hardcoded `false` — so every one of these holds regardless of who is
 * signed in or what role they hold. The pre-existing suite exercised the invitation row
 * menu (copy link / cancel) as reachable actions; those are gone rather than merely hidden
 * behind a permission this component still checked, so the tests below assert absence
 * instead.
 */
describe("MembersTable, read-only in Operon mode", () => {
  it("renders no pending-invitation row menu", () => {
    render(
      <MembersTable
        workspaceId="workspace-1"
        invitations={[pendingInvitation]}
        users={[] as WorkspaceUser[]}
      />,
    );

    expect(
      screen.queryByRole("button", {
        name: "team:membersTable.ariaInvitationActions",
      }),
    ).toBeNull();
    // The invitation itself is still shown — read-only means no ACTIONS, not no data.
    expect(screen.getByText(pendingInvitation.email)).toBeTruthy();
  });

  it("renders no per-member remove menu", () => {
    render(
      <MembersTable
        workspaceId="workspace-1"
        invitations={[]}
        users={[owner, member]}
      />,
    );

    expect(
      screen.queryByRole("button", {
        name: "team:membersTable.ariaRemoveMember",
      }),
    ).toBeNull();
  });

  it("renders a non-owner's role as plain text, never an editable role Select", () => {
    render(
      <MembersTable
        workspaceId="workspace-1"
        invitations={[]}
        users={[owner, member]}
      />,
    );

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("team:roles.member")).toBeTruthy();
    expect(screen.getByText("team:roles.owner")).toBeTruthy();
  });
});
