import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import useGetTask from "@/hooks/queries/task/use-get-task";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { readScriptSource } from "@/lib/script-source";
import { buildScriptText } from "@/lib/task-script";
import { toast } from "@/lib/toast";
import TaskDeleteButton from "./task-delete-button";

type TaskActionsMenuProps = {
  taskId: string;
  // The phone task page has no room for a separate trash button, so its menu
  // carries Delete Task; the desktop page and the sheet keep TaskDeleteButton.
  withDelete: boolean;
  onDeleted?: () => void;
  className?: string;
};

// Operon fork (script export, row 21): the "…" Task actions menu.
export default function TaskActionsMenu({
  taskId,
  withDelete,
  onDeleted,
  className,
}: TaskActionsMenuProps) {
  const { t } = useTranslation();
  const { data: task } = useGetTask(taskId);
  const { canDeleteTasks, isCheckingPermissions } = useWorkspacePermission();
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (!task) return null;

  const showDelete = withDelete && !isCheckingPermissions && canDeleteTasks();

  const copyFailed = (error?: unknown) => {
    // Never the script text or title: only which task and what kind of failure.
    console.error("[script-export] copy failed", {
      taskId,
      name: error instanceof Error ? error.name : undefined,
    });
    toast.error(t("tasks:scriptExport.copyFailed"));
  };

  // No await may come before copyToClipboard: Safari only grants clipboard
  // writes made synchronously inside the user's click.
  const handleCopy = () => {
    let text: string;
    try {
      text = buildScriptText(
        task.title,
        readScriptSource(task.id) ?? task.description,
      );
    } catch (error) {
      copyFailed(error);
      return;
    }
    copyToClipboard(text)
      .then((ok) => {
        if (ok) toast.success(t("tasks:scriptExport.copied"));
        else copyFailed();
      })
      .catch(copyFailed);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("tasks:scriptExport.menu")}
              className={className}
            />
          }
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={handleCopy}>
            {t("tasks:scriptExport.copyScript")}
          </DropdownMenuItem>
          {showDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeleteOpen(true)}
              >
                {t("tasks:delete.action")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* A sibling of the menu, so closing the menu never unmounts the dialog. */}
      {withDelete && (
        <TaskDeleteButton
          taskId={taskId}
          hideTrigger
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          onDeleted={onDeleted ?? (() => {})}
        />
      )}
    </>
  );
}
