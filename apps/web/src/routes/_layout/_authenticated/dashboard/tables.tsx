import { createFileRoute, redirect } from "@tanstack/react-router";
import getWorkspaces from "@/fetchers/workspace/get-workspaces";
import { authClient } from "@/lib/auth-client";
import { handleUnauthorized, isUnauthorizedError } from "@/lib/http-error";
import type Workspace from "@/types/workspace";

/**
 * Operon fork addition (John's ruling 2026-10-11, Tables spec section 15;
 * docs/fork-discipline.md row 18): `/dashboard/tables`, the address Operon's phone "Tables"
 * tab lands on. Operon does not know Initiative's workspace id, so this picks the workspace
 * the way `/dashboard` does — the session's active one when it is listed, else the first
 * (made active, as `/dashboard` does) — and opens its Tables page. A session fresh from the
 * sign-in hand-off has no active workspace yet, which is why the list is read, not only the
 * session. No workspace at all falls to `/dashboard` (invitations or onboarding).
 */
export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/tables",
)({
  beforeLoad: async () => {
    let workspaces: Workspace[];
    try {
      workspaces = await getWorkspaces();
    } catch (error) {
      if (isUnauthorizedError(error)) {
        handleUnauthorized();
        return;
      }
      throw error;
    }
    if (!workspaces?.length) throw redirect({ to: "/dashboard" });

    const session = await authClient.getSession();
    const activeId = session?.data?.session?.activeOrganizationId;
    const workspace =
      workspaces.find((ws) => ws.id === activeId) ?? workspaces[0];
    if (workspace.id !== activeId) {
      authClient.organization.setActive({ organizationId: workspace.id });
    }
    throw redirect({
      to: "/dashboard/workspace/$workspaceId/tables",
      params: { workspaceId: workspace.id },
    });
  },
});
