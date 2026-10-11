import { createFileRoute, redirect } from "@tanstack/react-router";
import { getTable } from "@/fetchers/operon-tables/get-table";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/",
)({
  // Operon fork addition (Tables task 8, docs/fork-discipline.md row 18): a table project
  // opens on its table view, every other project on the board. A failed flag read falls
  // back to the board, the upstream behavior.
  beforeLoad: async ({ params, context }) => {
    const table = await context.queryClient
      .fetchQuery({
        queryKey: ["operon-table", params.projectId],
        queryFn: () => getTable(params.projectId),
      })
      .catch(() => null);
    throw redirect({
      to: table
        ? "/dashboard/workspace/$workspaceId/project/$projectId/table"
        : "/dashboard/workspace/$workspaceId/project/$projectId/board",
      params,
      replace: true,
    });
  },
});
