import { createFileRoute } from "@tanstack/react-router";
import WorkspaceLayout from "@/components/common/workspace-layout";
import TablesSection from "@/components/operon-tables/tables-section";
import PageTitle from "@/components/page-title";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/tables",
)({
  component: RouteComponent,
});

/**
 * Operon fork addition (John's ruling 2026-10-11, Tables spec section 15;
 * docs/fork-discipline.md row 18): the Tables page, reached from the sub-rail's "Tables"
 * entry and the phone's "Tables" tab. It holds what was the Tables section at the foot of
 * the boards list — the cards, the admin "New table" card, "Recently added" — plus the
 * search across every table. The server's `requireTableAdmin` remains the check of record
 * behind the admin-only card.
 */
function RouteComponent() {
  const { workspaceId } = Route.useParams();
  const { isAdmin } = useWorkspacePermission();
  return (
    <>
      <PageTitle title="Tables" />
      <WorkspaceLayout title="Tables">
        <TablesSection workspaceId={workspaceId} isAdmin={isAdmin} />
      </WorkspaceLayout>
    </>
  );
}
