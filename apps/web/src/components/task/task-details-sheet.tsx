import { useNavigate } from "@tanstack/react-router";
import { Maximize2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import RecordPanel from "@/components/operon-tables/record-panel";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import useGetTable from "@/hooks/queries/operon-tables/use-get-table";
import useGetProject from "@/hooks/queries/project/use-get-project";
import useGetTask from "@/hooks/queries/task/use-get-task";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import TaskDeleteButton from "./task-delete-button";
import TaskDetailsContent from "./task-details-content";
import TaskPropertiesSidebar from "./task-properties-sidebar";

type TaskDetailsSheetProps = {
  taskId: string | undefined;
  projectId: string;
  workspaceId: string;
  onClose: () => void;
};

/**
 * Operon fork addition (Tables task 9, docs/fork-discipline.md row 18): a table project's
 * entries open the record panel (columns, Made by, Last change; no comments, relations or
 * subtasks) instead of the board fields. `taskId="new"` is an empty entry ("Add entry").
 * The board sheet renders only once the table flag is known to be absent, so a table
 * entry never flashes the task fields (or reads the task routes) first.
 */
export default function TaskDetailsSheet(props: TaskDetailsSheetProps) {
  const { data: table, isLoading } = useGetTable(props.projectId);
  const { isAdmin } = useWorkspacePermission();
  if (table) {
    return (
      <Sheet
        open={!!props.taskId}
        onOpenChange={(open) => !open && props.onClose()}
      >
        <SheetContent
          side="right"
          className="w-full max-w-full sm:max-w-lg md:max-w-xl p-0 gap-0 [&>button]:hidden"
        >
          {props.taskId && (
            <RecordPanel
              table={table}
              rowId={props.taskId}
              canAddTopic={isAdmin}
              onClose={props.onClose}
            />
          )}
        </SheetContent>
      </Sheet>
    );
  }
  if (isLoading) return null;
  return <BoardTaskDetailsSheet {...props} />;
}

function BoardTaskDetailsSheet({
  taskId,
  projectId,
  workspaceId,
  onClose,
}: TaskDetailsSheetProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [currentTaskId, setCurrentTaskId] = useState<string | undefined>(
    taskId,
  );

  const { data: task } = useGetTask(currentTaskId ?? "");
  const { data: project } = useGetProject({ id: projectId, workspaceId });

  useEffect(() => {
    if (taskId) {
      // Update taskId immediately without closing/reopening
      setCurrentTaskId(taskId);
    } else {
      // Delay clearing to allow exit animation
      const timer = setTimeout(() => {
        setCurrentTaskId(undefined);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [taskId]);

  const handleOpenFullPage = useCallback(() => {
    if (!currentTaskId) return;
    navigate({
      to: "/dashboard/workspace/$workspaceId/project/$projectId/task/$taskId",
      params: {
        workspaceId,
        projectId,
        taskId: currentTaskId,
      },
    });
  }, [navigate, workspaceId, projectId, currentTaskId]);

  return (
    <Sheet open={!!taskId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full max-w-full sm:max-w-lg md:max-w-2xl lg:max-w-4xl p-0 gap-0 [&>button]:hidden"
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card text-card-foreground shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-muted-foreground">
              {project?.slug}-{task?.number}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {currentTaskId && (
              <TaskDeleteButton taskId={currentTaskId} onDeleted={onClose} />
            )}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("tasks:detail.openInFullPage")}
                    onClick={handleOpenFullPage}
                    className="text-card-foreground"
                  >
                    <Maximize2 className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t("tasks:detail.openInFullPage")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("common:actions.close")}
              onClick={onClose}
              className="text-card-foreground"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        <div
          className="flex flex-col flex-1 min-h-0 overflow-hidden"
          key={currentTaskId}
        >
          <TaskPropertiesSidebar
            taskId={currentTaskId}
            projectId={projectId}
            workspaceId={workspaceId}
            className="w-full bg-card border-b border-border flex flex-col gap-0 overflow-y-auto shrink-0"
            compact={true}
          />

          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="px-4 py-4">
              <TaskDetailsContent
                taskId={currentTaskId}
                projectId={projectId}
                workspaceId={workspaceId}
                className="flex flex-col gap-3"
              />
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
