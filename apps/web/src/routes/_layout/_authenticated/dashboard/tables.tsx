import { createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";

/**
 * Operon fork addition (John's ruling 2026-10-11, Tables spec section 15;
 * docs/fork-discipline.md row 18): `/dashboard/tables`, the address Operon's phone "Tables"
 * tab lands on. Operon does not know Initiative's workspace id, so this resolves the
 * session's active workspace to its Tables page; without one, `/dashboard` picks the
 * workspace (or onboarding) exactly as it does for the boards list.
 */
export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/tables",
)({
  beforeLoad: async () => {
    const session = await authClient.getSession();
    const workspaceId = session?.data?.session?.activeOrganizationId;
    if (workspaceId) {
      throw redirect({
        to: "/dashboard/workspace/$workspaceId/tables",
        params: { workspaceId },
      });
    }
    throw redirect({ to: "/dashboard" });
  },
});
