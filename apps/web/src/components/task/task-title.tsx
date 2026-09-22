import { useCallback, useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Form, FormField } from "@/components/ui/form";
import { useUpdateTaskTitle } from "@/hooks/mutations/task/use-update-task-title";
import useGetTask from "@/hooks/queries/task/use-get-task";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import debounce from "@/lib/debounce";
import { registerDirtyEditor } from "@/lib/version-check";

type TaskTitleProps = {
  taskId: string;
};

export default function TaskTitle({ taskId }: TaskTitleProps) {
  const { t } = useTranslation();
  const { data: task } = useGetTask(taskId);
  const { mutateAsync: updateTaskTitle } = useUpdateTaskTitle();
  const { canUpdateTasks } = useWorkspacePermission();
  const canEdit = canUpdateTasks();
  const isInitializedRef = useRef(false);
  const taskRef = useRef(task);
  const updateTaskRef = useRef(updateTaskTitle);
  /**
   * Stage 1 round-1 finding 6: true from the moment a keystroke changes the title until
   * the 800 ms debounce hands the save off to `useUpdateTaskTitle` — the window
   * `useIsMutating()` alone cannot see, because nothing is mutating YET. Registered below
   * so a version-mismatch reload defers rather than discarding a title edit mid-debounce.
   */
  const dirtyRef = useRef(false);

  useEffect(() => {
    taskRef.current = task;
    updateTaskRef.current = updateTaskTitle;
  }, [task, updateTaskTitle]);

  useEffect(() => registerDirtyEditor(() => dirtyRef.current), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: taskId is not needed here
  useEffect(() => {
    isInitializedRef.current = false;
  }, [taskId]);

  const form = useForm<{
    title: string;
  }>({
    values: {
      title: task?.title || "",
    },
  });

  useEffect(() => {
    if (task?.title !== undefined) isInitializedRef.current = true;
  }, [task?.title]);

  const debouncedUpdate = useCallback(
    debounce(async (title: string) => {
      if (!isInitializedRef.current) return;

      const currentTask = taskRef.current;
      const updateTaskFn = updateTaskRef.current;

      if (!currentTask || !updateTaskFn) return;

      try {
        // Handing off to the mutation now — `useIsMutating()` covers it from here, so the
        // dirty predicate's job (bridging the gap BEFORE this point) is done.
        dirtyRef.current = false;
        await updateTaskFn({
          ...currentTask,
          title,
        });
      } catch (error) {
        console.error("Failed to update title:", error);
      }
    }, 800),
    [],
  );

  const handleTitleChange = useCallback(
    (value: string) => {
      if (!isInitializedRef.current) return;

      dirtyRef.current = true;
      debouncedUpdate(value);
    },
    [debouncedUpdate],
  );

  return (
    <Form {...form}>
      <FormField
        control={form.control}
        name="title"
        render={({ field }) => (
          <input
            {...field}
            type="text"
            placeholder={t("tasks:detail.titlePlaceholder")}
            readOnly={!canEdit}
            className="block h-auto w-full appearance-none border-0 bg-transparent p-0 font-heading text-[2rem] leading-[1.15] font-semibold tracking-[-0.02em] text-card-foreground outline-none placeholder:text-card-foreground/45"
            onChange={(e) => {
              field.onChange(e);
              handleTitleChange(e.target.value);
            }}
          />
        )}
      />
    </Form>
  );
}
