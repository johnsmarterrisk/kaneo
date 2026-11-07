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
import { saveScriptFile } from "@/lib/save-script-file";
import { readScriptSource } from "@/lib/script-source";
import {
  buildScriptMarkdown,
  buildScriptText,
  scriptFilename,
} from "@/lib/task-script";
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

  const saveFailed = (error?: unknown) => {
    const name = (error as { name?: unknown } | null)?.name;
    console.error("[script-export] save failed", {
      taskId,
      name: typeof name === "string" ? name : undefined,
    });
    toast.error(t("tasks:scriptExport.saveFailed"));
  };

  // Called synchronously from the click, like copy: iOS only opens the share
  // sheet inside the user's gesture. saved / shared / cancelled show no toast,
  // the download bar or the share sheet is the feedback.
  const handleDownload = (ext: "txt" | "md") => {
    let body: string;
    try {
      const markdown = readScriptSource(task.id) ?? task.description;
      body =
        ext === "txt"
          ? buildScriptText(task.title, markdown)
          : buildScriptMarkdown(task.title, markdown);
    } catch (error) {
      saveFailed(error);
      return;
    }
    saveScriptFile({
      filename: scriptFilename(task.number, task.title, ext),
      body,
      type:
        ext === "txt"
          ? "text/plain;charset=utf-8"
          : "text/markdown;charset=utf-8",
    })
      .then((result) => {
        if (result === "unavailable") {
          toast.error(t("tasks:scriptExport.saveUnavailable"));
        }
      })
      .catch(saveFailed);
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
          <DropdownMenuItem onClick={() => handleDownload("txt")}>
            {t("tasks:scriptExport.downloadText")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleDownload("md")}>
            {t("tasks:scriptExport.downloadMarkdown")}
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
