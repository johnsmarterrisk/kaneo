import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useDeleteTask } from "@/hooks/mutations/task/use-delete-task";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

type TaskDeleteButtonProps = {
  taskId: string;
  onDeleted: () => void;
  className?: string;
  // Operon fork (script export, row 21): the phone Task actions menu opens
  // this dialog itself, so it can be controlled and rendered without a trigger.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
};

export default function TaskDeleteButton({
  taskId,
  onDeleted,
  className,
  open,
  onOpenChange,
  hideTrigger = false,
}: TaskDeleteButtonProps) {
  const { t } = useTranslation();
  const [localOpen, setLocalOpen] = useState(false);
  const isOpen = open ?? localOpen;
  const { canDeleteTasks, isCheckingPermissions } = useWorkspacePermission();
  const { mutateAsync: deleteTask, isPending } = useDeleteTask();

  if (isCheckingPermissions || !canDeleteTasks()) {
    return null;
  }

  // Every close (confirm, Cancel, Escape, backdrop) also reports to a
  // controlling parent, or a controlled dialog would stay open.
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };

  const handleDelete = async () => {
    try {
      await deleteTask(taskId);
      toast.success(t("tasks:delete.success"));
      setOpen(false);
      onDeleted();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("tasks:delete.error"),
      );
    }
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={(next) => setOpen(next)}>
      {!hideTrigger && (
        <AlertDialogTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("tasks:delete.action")}
              className={cn(
                "text-destructive hover:bg-destructive/10 hover:text-destructive",
                className,
              )}
            />
          }
        >
          <Trash2 className="size-4" />
          <span className="hidden sm:inline">{t("tasks:delete.action")}</span>
        </AlertDialogTrigger>
      )}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("tasks:delete.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("tasks:delete.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose
            render={<Button variant="outline" size="sm" disabled={isPending} />}
          >
            {t("common:actions.cancel")}
          </AlertDialogClose>
          <Button
            variant="destructive"
            size="sm"
            disabled={isPending}
            onClick={() => void handleDelete()}
          >
            {isPending
              ? t("common:actions.deleting")
              : t("tasks:delete.action")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
