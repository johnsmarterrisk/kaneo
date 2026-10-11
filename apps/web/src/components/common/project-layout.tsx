import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  CalendarDays,
  CalendarRange,
  SquareKanban,
  SquircleDashed,
  Table2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ProjectCrumbSelect from "@/components/common/header/project-crumb-select";
import WorkspaceCrumbSelect from "@/components/common/header/workspace-crumb-select";
import Layout, { usePhoneNav } from "@/components/common/layout";
import CreateProjectModal from "@/components/shared/modals/create-project-modal";
import { Button } from "@/components/ui/button";
import { KbdSequence } from "@/components/ui/kbd";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { shortcuts } from "@/constants/shortcuts";
import useGetTable from "@/hooks/queries/operon-tables/use-get-table";
import useGetProject from "@/hooks/queries/project/use-get-project";
import { useProjectWebSocket } from "@/hooks/use-project-websocket";
import { cn } from "@/lib/cn";

type ProjectLayoutProps = {
  projectId: string;
  workspaceId: string;
  headerActions?: ReactNode;
  children: ReactNode;
  showViewSwitcher?: boolean;
  activeView?: "backlog" | "board" | "calendar" | "gantt" | "table";
};

export default function ProjectLayout({
  projectId,
  workspaceId,
  headerActions,
  children,
  showViewSwitcher = true,
  activeView,
}: ProjectLayoutProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const phoneNav = usePhoneNav();
  const { data: project } = useGetProject({ id: projectId, workspaceId });
  const [isCreateProjectModalOpen, setIsCreateProjectModalOpen] =
    useState(false);

  useProjectWebSocket(projectId);

  // Operon fork addition (Tables task 8, docs/fork-discipline.md row 18): a table project
  // has one view, the table. Its tabs show only that view, and a link that lands a table
  // on board/backlog/calendar/gantt (the sidebar and search link to /board) moves it there.
  const { data: operonTable } = useGetTable(projectId);
  const isTableProject = Boolean(operonTable);
  useEffect(() => {
    if (isTableProject && activeView !== "table") {
      navigate({
        to: "/dashboard/workspace/$workspaceId/project/$projectId/table",
        params: { workspaceId, projectId },
        replace: true,
      });
    }
  }, [isTableProject, activeView, navigate, workspaceId, projectId]);

  const resolvedView =
    activeView ??
    (location.pathname.includes("/backlog")
      ? "backlog"
      : location.pathname.includes("/calendar")
        ? "calendar"
        : location.pathname.includes("/gantt")
          ? "gantt"
          : "board");

  const handleNavigateToBacklog = () => {
    navigate({
      to: "/dashboard/workspace/$workspaceId/project/$projectId/backlog",
      params: { workspaceId, projectId },
    });
  };

  const handleNavigateToBoard = () => {
    navigate({
      to: "/dashboard/workspace/$workspaceId/project/$projectId/board",
      params: { workspaceId, projectId },
    });
  };

  const handleNavigateToCalendar = () => {
    navigate({
      to: "/dashboard/workspace/$workspaceId/project/$projectId/calendar",
      params: { workspaceId, projectId },
    });
  };

  const handleNavigateToGantt = () => {
    navigate({
      to: "/dashboard/workspace/$workspaceId/project/$projectId/gantt",
      params: { workspaceId, projectId },
    });
  };

  const handleProjectSwitch = (nextProjectId: string) => {
    navigate({
      to:
        resolvedView === "table"
          ? "/dashboard/workspace/$workspaceId/project/$projectId"
          : resolvedView === "backlog"
            ? "/dashboard/workspace/$workspaceId/project/$projectId/backlog"
            : resolvedView === "calendar"
              ? "/dashboard/workspace/$workspaceId/project/$projectId/calendar"
              : resolvedView === "gantt"
                ? "/dashboard/workspace/$workspaceId/project/$projectId/gantt"
                : "/dashboard/workspace/$workspaceId/project/$projectId/board",
      params: {
        workspaceId,
        projectId: nextProjectId,
      },
    });
  };

  return (
    <Layout>
      <Layout.Header className="border-border px-4">
        <div className="flex w-full items-center justify-between gap-2">
          {/* Phone Work top bar (Piece B): back arrow + project title only. Supersedes
              `MobileProjectNav`'s old hamburger-style popover (project switch + view
              select) at this width — the Navigate screen now owns project switching (its
              project list, `NavProjects`), and a working hamburger left behind here would
              contradict the two-screen model's own "no hamburger" rule. `MobileProjectNav`
              itself is untouched and still declared; it is simply not called from this
              width any more. Backlog/Calendar/Gantt on phones is unreached by this brief
              (Piece B names project list, board/list view and task detail only) — filed as
              an open item, not silently dropped. */}
          <div className="flex md:hidden min-w-0 items-center gap-2">
            <button
              type="button"
              data-testid="phone-back-to-navigate"
              aria-label="Back to Navigate"
              onClick={() => phoneNav?.goBack()}
              className="min-w-[44px] min-h-[44px] flex items-center justify-center -ml-2"
            >
              <ArrowLeft className="size-5" aria-hidden="true" />
            </button>
            <span className="truncate text-base font-bold">
              {project?.name ?? t("navigation:sidebar.projects")}
            </span>
          </div>

          <div className="hidden min-w-0 flex-wrap items-center gap-2 md:flex">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <SidebarTrigger className="-ml-1 h-7 w-7 cursor-pointer text-card-foreground/85 hover:text-card-foreground" />
                </TooltipTrigger>
                <TooltipContent>
                  <p className="flex items-center gap-2 text-[10px]">
                    Toggle sidebar
                    <KbdSequence
                      keys={[
                        shortcuts.sidebar.prefix,
                        shortcuts.sidebar.toggle,
                      ]}
                    />
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <div className="h-4 w-px shrink-0 bg-border/80" />

            <div className="flex min-w-0 items-center gap-1">
              <WorkspaceCrumbSelect />
              <span className="text-card-foreground/30 text-xs">/</span>
              <ProjectCrumbSelect
                workspaceId={workspaceId}
                projectId={projectId}
                projectName={project?.name}
                onSelectProject={handleProjectSwitch}
                onAddProject={() => setIsCreateProjectModalOpen(true)}
              />
            </div>

            {showViewSwitcher && isTableProject && (
              <div className="hidden flex-wrap items-center gap-1 sm:inline-flex">
                <Button
                  variant="secondary"
                  size="xs"
                  className="h-6 gap-1.5 rounded-md px-2 text-xs"
                >
                  <Table2 className="size-3.5" />
                  Table
                </Button>
              </div>
            )}

            {showViewSwitcher && !isTableProject && (
              <div className="hidden flex-wrap items-center gap-1 sm:inline-flex">
                <Button
                  variant={resolvedView === "backlog" ? "secondary" : "ghost"}
                  size="xs"
                  onClick={handleNavigateToBacklog}
                  className={cn(
                    "h-6 gap-1.5 rounded-md px-2 text-xs",
                    resolvedView !== "backlog" && "text-muted-foreground",
                  )}
                >
                  <SquircleDashed className="size-3.5" />
                  Backlog
                </Button>
                <Button
                  variant={resolvedView === "board" ? "secondary" : "ghost"}
                  size="xs"
                  onClick={handleNavigateToBoard}
                  className={cn(
                    "h-6 gap-1.5 rounded-md px-2 text-xs",
                    resolvedView !== "board" && "text-muted-foreground",
                  )}
                >
                  <SquareKanban className="size-3.5" />
                  {t("tasks:title")}
                </Button>
                <Button
                  variant={resolvedView === "calendar" ? "secondary" : "ghost"}
                  size="xs"
                  onClick={handleNavigateToCalendar}
                  className={cn(
                    "h-6 gap-1.5 rounded-md px-2 text-xs",
                    resolvedView !== "calendar" && "text-muted-foreground",
                  )}
                >
                  <CalendarRange className="size-3.5" />
                  {t("tasks:calendar.title")}
                </Button>
                <Button
                  variant={resolvedView === "gantt" ? "secondary" : "ghost"}
                  size="xs"
                  onClick={handleNavigateToGantt}
                  className={cn(
                    "h-6 gap-1.5 rounded-md px-2 text-xs",
                    resolvedView !== "gantt" && "text-muted-foreground",
                  )}
                >
                  <CalendarDays className="size-3.5" />
                  Gantt
                </Button>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {headerActions}
          </div>
        </div>
      </Layout.Header>

      <Layout.Content>{children}</Layout.Content>

      <CreateProjectModal
        open={isCreateProjectModalOpen}
        onClose={() => setIsCreateProjectModalOpen(false)}
      />
    </Layout>
  );
}
