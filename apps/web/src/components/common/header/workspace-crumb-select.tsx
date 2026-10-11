import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { englishOr } from "@/components/nav-main";
import { Button } from "@/components/ui/button";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";

export default function WorkspaceCrumbSelect() {
  const { t, i18n } = useTranslation();
  const { data: workspace } = useActiveWorkspace();
  const navigate = useNavigate();

  return (
    <Button
      variant="ghost"
      size="xs"
      className="h-7 justify-between px-2 text-xs text-card-foreground"
      onClick={() => {
        navigate({
          to: "/dashboard/workspace/$workspaceId",
          params: { workspaceId: workspace?.id },
        });
      }}
    >
      <span className="truncate text-left">
        {/* Operon (John's ruling 2026-10-11, row 18): "Initiative" in English. */}
        {englishOr(
          i18n?.language,
          "Initiative",
          workspace?.name || t("navigation:workspaceSwitcher.selectWorkspace"),
        )}
      </span>
    </Button>
  );
}
