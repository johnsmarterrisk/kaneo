import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Check } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import TaskCrumbSelect from "@/components/common/header/task-crumb-select";
import Layout, { usePhoneNav } from "@/components/common/layout";
import { KbdSequence } from "@/components/ui/kbd";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { shortcuts } from "@/constants/shortcuts";
import { useUpdateTask } from "@/hooks/mutations/task/use-update-task";
import { useGetColumns } from "@/hooks/queries/column/use-get-columns";
import useGetProject from "@/hooks/queries/project/use-get-project";
import useGetTask from "@/hooks/queries/task/use-get-task";
import { useProjectWebSocket } from "@/hooks/use-project-websocket";
import { isTaskCompleted } from "@/lib/due-date-status";

type TaskLayoutProps = {
  taskId: string;
  projectId: string;
  workspaceId: string;
  headerActions?: ReactNode;
  children: ReactNode;
  rightSidebar?: ReactNode;
};

export default function TaskLayout({
  taskId,
  projectId,
  workspaceId,
  headerActions,
  children,
  rightSidebar,
}: TaskLayoutProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const phoneNav = usePhoneNav();
  const { data: project } = useGetProject({ id: projectId, workspaceId });
  const { data: task } = useGetTask(taskId);
  const { data: columns = [] } = useGetColumns(projectId);
  const { mutate: updateTask } = useUpdateTask();

  useProjectWebSocket(projectId);

  const taskLabel =
    project?.slug && task?.number != null
      ? `${project.slug}-${task.number}`
      : t("tasks:common.selectTask");

  const handleTaskSwitch = (nextTaskId: string) => {
    navigate({
      to: "/dashboard/workspace/$workspaceId/project/$projectId/task/$taskId",
      params: { workspaceId, projectId, taskId: nextTaskId },
    });
  };

  // "Mark complete" (Piece B, Asana IMG_2123): completion is column-based, not a status
  // string (`isTaskCompleted`, `lib/due-date-status.ts` — the same rule the desktop
  // properties sidebar already uses for its own completion badge). Marking complete moves
  // the task to the project's first `isFinal` column; marking incomplete again moves it
  // back to the first NON-final column, a plain two-state toggle — Asana's own pill has no
  // richer state than "done" / "not done" either.
  const taskCompleted = isTaskCompleted(task?.status ?? "", columns);
  const handleToggleComplete = () => {
    if (!task) return;
    const target = taskCompleted
      ? columns.find((column) => !column.isFinal)
      : columns.find((column) => column.isFinal);
    if (!target) return;
    updateTask({ ...task, status: target.slug });
  };

  return (
    <Layout className="flex flex-col lg:flex-row">
      <div className="flex min-h-0 flex-1 flex-col">
        <Layout.Header className="border-border px-4">
          <div className="flex w-full items-center justify-between gap-2">
            {/* Phone task detail top bar (Piece B, Asana IMG_2123): back arrow, a
                centred "Mark complete" pill, "…" right. The 768px branch fires on its
                own `md:hidden`/`hidden md:flex` pair, independently of the `lg:` split
                below that puts `rightSidebar` above vs. beside the content — that split
                is untouched, per the brief's own note that this must not change the
                `lg:` behaviour above it. */}
            <div className="flex md:hidden w-full items-center gap-2">
              <button
                type="button"
                data-testid="phone-back-to-navigate"
                aria-label="Back to Navigate"
                onClick={() => phoneNav?.openPhoneNav()}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center -ml-2"
              >
                <ArrowLeft className="size-5" aria-hidden="true" />
              </button>
              <div className="flex flex-1 items-center justify-center">
                <button
                  type="button"
                  data-testid="phone-mark-complete"
                  onClick={handleToggleComplete}
                  disabled={!task}
                  className="flex min-h-[36px] items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {taskCompleted && (
                    <Check className="size-3.5" aria-hidden="true" />
                  )}
                  {taskCompleted
                    ? t("workspace:search.suggestionCompleted")
                    : t("tasks:detail.editor.checkbox.markComplete")}
                </button>
              </div>
              {/* The "…" slot renders the route's own `headerActions` verbatim (today:
                  the delete button) rather than a bespoke overflow menu — Piece B's
                  smallest-edit rule, and there is exactly one action to overflow today.
                  A real multi-item menu is future work once a second action exists. */}
              <div
                data-testid="phone-task-overflow"
                className="min-w-[44px] min-h-[44px] flex items-center justify-center"
              >
                {headerActions}
              </div>
            </div>

            <div className="hidden md:flex min-w-0 items-center gap-2">
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

              <div className="min-w-0 items-center gap-1.5 flex">
                <button
                  type="button"
                  onClick={() =>
                    navigate({
                      to: "/dashboard/workspace/$workspaceId/project/$projectId/board",
                      params: { workspaceId, projectId },
                    })
                  }
                  className="max-w-40 truncate text-left text-xs text-card-foreground hover:underline"
                >
                  {project?.name || t("navigation:sidebar.projects")}
                </button>
                <span className="text-card-foreground/70 text-xs">/</span>
                <TaskCrumbSelect
                  projectId={projectId}
                  taskId={taskId}
                  taskLabel={taskLabel}
                  onSelectTask={handleTaskSwitch}
                />
              </div>
            </div>

            <div className="hidden md:flex shrink-0 items-center gap-1.5">
              {headerActions}
            </div>
          </div>
        </Layout.Header>

        <Layout.Content>
          <div className="flex h-full min-h-0 flex-col overflow-hidden lg:flex-row">
            <div className="order-2 min-h-0 flex-1 overflow-y-auto overscroll-contain lg:order-1">
              {children}
            </div>
            <div className="order-1 border-b border-border/80 lg:order-2 lg:hidden">
              {rightSidebar}
            </div>
          </div>
        </Layout.Content>
      </div>
      <div className="hidden border-l border-border/80 bg-card lg:flex lg:h-full lg:overflow-y-auto">
        {rightSidebar}
      </div>
    </Layout>
  );
}
