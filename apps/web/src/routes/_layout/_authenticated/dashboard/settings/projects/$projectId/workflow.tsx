import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import PageTitle from "@/components/page-title";
import ColumnEditor from "@/components/project/column-editor";
import WorkflowEditor from "@/components/project/workflow-editor";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/settings/projects/$projectId/workflow",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation();
  const { projectId } = Route.useParams();

  return (
    <>
      <PageTitle title={t("settings:projectWorkflow.pageTitle")} />
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="space-y-2">
          {/* text-card-foreground: this page renders on the settings frame's white
              bg-card panel (settings.tsx), not the app's navy ground — same GUI-4
              pattern as general.tsx's own h1. */}
          <h1 className="text-2xl font-semibold text-card-foreground">
            {t("settings:projectWorkflow.title")}
          </h1>
          <p className="text-muted-foreground">
            {t("settings:projectWorkflow.subtitle")}
          </p>
        </div>

        <div className="space-y-6">
          <div className="space-y-1">
            <h2 className="text-md font-medium text-card-foreground">
              {t("settings:projectWorkflow.columnsTitle")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("settings:projectWorkflow.columnsDescription")}
            </p>
          </div>
          <ColumnEditor projectId={projectId} />
        </div>

        <div className="space-y-6">
          <div className="space-y-1">
            <h2 className="text-md font-medium text-card-foreground">
              {t("settings:projectWorkflow.automationTitle")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("settings:projectWorkflow.automationDescription")}
            </p>
          </div>
          <WorkflowEditor projectId={projectId} />
        </div>
      </div>
    </>
  );
}
