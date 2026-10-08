import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import {
  useProjectFieldLabels,
  useSetProjectFieldLabels,
} from "@/hooks/queries/operon-field-labels/use-project-field-label";
import { toast } from "@/lib/toast";

/**
 * Operon fork addition (social agent S18, docs/fork-discipline.md row 17): the project
 * settings page's two optional field labels. Empty by default, with the translated word as
 * placeholder; clearing a field restores the default. Saved on blur, like the page's other
 * fields. The strings are English, as the fork's other Operon-only chrome is
 * (`operon-switcher.tsx`): an i18n key would be a new key in 19 upstream bundles.
 */
export function OperonFieldLabelsSettings({
  projectId,
  canEdit,
}: {
  projectId: string;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const { data, isSuccess } = useProjectFieldLabels(projectId);
  const { mutateAsync, isPending } = useSetProjectFieldLabels(projectId);
  const [descriptionLabel, setDescriptionLabel] = useState("");
  const [dueDateLabel, setDueDateLabel] = useState("");

  useEffect(() => {
    if (!data) return;
    setDescriptionLabel(data.descriptionLabel ?? "");
    setDueDateLabel(data.dueDateLabel ?? "");
  }, [data]);

  const save = async () => {
    if (
      !data ||
      (descriptionLabel.trim() === (data.descriptionLabel ?? "") &&
        dueDateLabel.trim() === (data.dueDateLabel ?? ""))
    ) {
      return;
    }
    try {
      await mutateAsync({ descriptionLabel, dueDateLabel });
      toast.success("Field labels saved");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Field labels were not saved",
      );
    }
  };

  const disabled = !canEdit || !isSuccess || isPending;

  return (
    <div className="flex flex-col gap-3">
      <div className="space-y-0.5">
        <p className="text-base font-medium text-sidebar-foreground">
          Field labels
        </p>
        <p className="text-sm text-sidebar-foreground">
          Optional words this project shows for the description and due date.
          Leave empty for the defaults.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <label
          htmlFor="operon-description-label"
          className="text-sm text-sidebar-foreground"
        >
          Label for the description
        </label>
        <Input
          id="operon-description-label"
          className="w-full sm:w-64"
          maxLength={40}
          placeholder={t("settings:projectGeneral.descriptionLabel")}
          value={descriptionLabel}
          disabled={disabled}
          onChange={(event) => setDescriptionLabel(event.target.value)}
          onBlur={save}
        />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <label
          htmlFor="operon-due-date-label"
          className="text-sm text-sidebar-foreground"
        >
          Label for the due date
        </label>
        <Input
          id="operon-due-date-label"
          className="w-full sm:w-64"
          maxLength={40}
          placeholder={t("tasks:dueDate.label")}
          value={dueDateLabel}
          disabled={disabled}
          onChange={(event) => setDueDateLabel(event.target.value)}
          onBlur={save}
        />
      </div>
    </div>
  );
}
