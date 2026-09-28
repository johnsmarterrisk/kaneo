import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import PageTitle from "@/components/page-title";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import useUpdateProject from "@/hooks/mutations/project/use-update-project";
import useGetProject from "@/hooks/queries/project/use-get-project";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { toast } from "@/lib/toast";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/settings/projects/$projectId/visibility",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation();
  const { projectId } = useParams({ strict: false });
  const { data: workspace } = useActiveWorkspace();
  const { data: project } = useGetProject({
    id: projectId || "",
    workspaceId: workspace?.id || "",
  });

  const queryClient = useQueryClient();
  const { mutateAsync: updateProject } = useUpdateProject();
  const { hasPermission } = useWorkspacePermission();
  const savingRef = useRef(false);
  // `project:share` isn't in CAPABILITIES (only admin/owner/custom roles
  // with it can flip visibility), so use the generic server check. Result
  // isn't cached, but visibility is a rarely-toggled setting page.
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void hasPermission({ project: ["share"] }).then((ok) => {
      if (!cancelled) setCanShare(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [hasPermission]);

  const handleToggle = useCallback(async () => {
    if (!project) return;
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      // Send only the field this page owns. `project` here comes from
      // useGetProject, a snapshot that can be stale relative to a concurrent
      // edit on the General tab; sending name/slug/description/icon back
      // from that snapshot would silently revert such an edit (the mirror
      // image of the general.tsx bug this pattern already fixes there — see
      // apps/api update-project.ts, which now leaves every omitted field
      // untouched).
      await updateProject({
        id: project.id,
        isPublic: !project.isPublic,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({
          queryKey: ["projects", workspace?.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["projects", workspace?.id, project.id],
        }),
      ]);
      toast.success(t("settings:projectVisibility.toastUpdated"));
    } catch (e) {
      toast.error(
        e instanceof Error
          ? e.message
          : t("settings:projectVisibility.toastUpdateError"),
      );
    } finally {
      savingRef.current = false;
    }
  }, [project, updateProject, queryClient, workspace?.id, t]);

  const origin = window.location.origin;

  const publicUrl = project?.id ? `${origin}/public-project/${project.id}` : "";

  return (
    <>
      <PageTitle title={t("settings:projectVisibility.pageTitle")} />
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="space-y-2">
          {/* text-card-foreground: this page renders on the settings frame's white
              bg-card panel (settings.tsx), not the app's navy ground — same GUI-4
              pattern as general.tsx's own h1. */}
          <h1 className="text-2xl font-semibold text-card-foreground">
            {t("settings:projectVisibility.title")}
          </h1>
          <p className="text-muted-foreground">
            {t("settings:projectVisibility.subtitle")}
          </p>
        </div>

        <div className="space-y-6">
          <div className="space-y-1">
            <h2 className="text-md font-medium text-card-foreground">
              {t("settings:projectVisibility.sectionTitle")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("settings:projectVisibility.sectionSubtitle")}
            </p>
          </div>

          <div className="space-y-4 border border-border rounded-md p-4 bg-sidebar">
            {/* text-sidebar-foreground, full strength (John, 2026-09-28, O1): this card
                is bg-sidebar (navy) — the shared Label primitive defaults to
                text-card-foreground (dark, for a white card), which is dark-on-navy
                here; the hints beside it now carry the same full-strength token instead
                of the global text-muted-foreground (dark gray, also dark-on-navy) or a
                reduced-opacity variant — same GUI-4 pattern as general.tsx's Project
                Information card. text-base/text-sm: one step up the type scale (O2).
                sm:text-base (Codex final-review finding, 2026-09-28): the shared
                Label default is "text-base/4.5 sm:text-sm/4 ..." and an unprefixed
                text-base override never evicts that sm: rule (twMerge only dedupes
                same-variant classes) — sm:text-base is what keeps the larger size at
                desktop width. */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-base sm:text-base font-medium text-sidebar-foreground">
                  {t("settings:projectVisibility.publicAccess")}
                </Label>
                <p className="text-sm text-sidebar-foreground">
                  {t("settings:projectVisibility.publicAccessHint")}
                </p>
              </div>
              <Switch
                checked={!!project?.isPublic}
                onCheckedChange={canShare ? handleToggle : undefined}
                disabled={!canShare}
              />
            </div>

            <Separator />

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="space-y-0.5">
                {/* text-sidebar-foreground, full strength: same bg-sidebar card, same
                    contrast fix as the Public Access Label above. */}
                <Label className="text-base sm:text-base font-medium text-sidebar-foreground">
                  {t("settings:projectVisibility.publicUrl")}
                </Label>
                <p className="text-sm text-sidebar-foreground">
                  {t("settings:projectVisibility.publicUrlHint")}
                </p>
              </div>
              <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
                <Input readOnly value={publicUrl} className="w-full sm:w-96" />
                <Button
                  size="sm"
                  onClick={() => {
                    if (!publicUrl) return;
                    navigator.clipboard
                      .writeText(publicUrl)
                      .then(() =>
                        toast.success(
                          t("settings:projectVisibility.copiedToast"),
                        ),
                      );
                  }}
                >
                  {t("settings:projectVisibility.copy")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
