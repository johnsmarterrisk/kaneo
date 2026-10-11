import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import ProjectLayout from "@/components/common/project-layout";
import TableView from "@/components/operon-tables/table-view";
import PageTitle from "@/components/page-title";
import TaskDetailsSheet from "@/components/task/task-details-sheet";
import useGetTable from "@/hooks/queries/operon-tables/use-get-table";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";

/**
 * Operon fork addition (Tables task 8, docs/fork-discipline.md row 18, spec 7.10): a table
 * project's one view. `?taskId=<row>` opens that entry's record panel and `?taskId=new` an
 * empty one ("Add entry"), both through the task details sheet's table branch (task 9).
 */
type TableSearchParams = {
  taskId?: string;
};

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/table",
)({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): TableSearchParams => ({
    taskId: typeof search.taskId === "string" ? search.taskId : undefined,
  }),
});

function RouteComponent() {
  const { workspaceId, projectId } = Route.useParams();
  const { taskId } = Route.useSearch();
  const navigate = useNavigate();
  const { isAdmin } = useWorkspacePermission();
  const { data: table } = useGetTable(projectId);

  const openRow = useCallback(
    (rowId: string) =>
      navigate({ to: ".", search: { taskId: rowId }, replace: true }),
    [navigate],
  );
  const close = useCallback(
    () => navigate({ to: ".", search: {}, replace: true }),
    [navigate],
  );

  return (
    <>
      <PageTitle title={table?.name ?? "Table"} />
      <ProjectLayout
        projectId={projectId}
        workspaceId={workspaceId}
        activeView="table"
      >
        <TableView
          projectId={projectId}
          workspaceId={workspaceId}
          isAdmin={isAdmin}
          onOpenRow={openRow}
          onAddEntry={() => openRow("new")}
          onOpenColumns={() =>
            navigate({
              to: "/dashboard/settings/projects/$projectId/columns",
              params: { projectId },
            })
          }
        />
        <TaskDetailsSheet
          taskId={taskId}
          projectId={projectId}
          workspaceId={workspaceId}
          onClose={close}
        />
      </ProjectLayout>
    </>
  );
}
