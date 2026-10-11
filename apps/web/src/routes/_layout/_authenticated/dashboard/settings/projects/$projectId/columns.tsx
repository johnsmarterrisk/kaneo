import { createFileRoute } from "@tanstack/react-router";
import ColumnsPage from "@/components/operon-tables/columns-page";
import PageTitle from "@/components/page-title";

/**
 * Operon fork addition (Tables task 10, docs/fork-discipline.md row 18): a table project's
 * Columns page, beside Workflow in the project settings.
 */
export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/settings/projects/$projectId/columns",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const { projectId } = Route.useParams();
  return (
    <>
      <PageTitle title="Columns" />
      <div className="max-w-4xl mx-auto">
        <ColumnsPage projectId={projectId} />
      </div>
    </>
  );
}
