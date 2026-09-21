import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import WorkspaceLayout from "@/components/common/workspace-layout";
import { apexUrl } from "@/components/operon-switcher";
import PageTitle from "@/components/page-title";
import MembersTable from "@/components/team/members-table";
import { Badge } from "@/components/ui/badge";
import useGetFullWorkspace from "@/hooks/queries/workspace/use-get-full-workspace";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/members",
)({
  component: RouteComponent,
});

/**
 * Members, in Operon mode (spec R14, GUI pass task 4a; docs/fork-discipline.md row 13).
 *
 * Operon owns identity and workspace membership end to end — every account here was
 * provisioned by `operon-account`/`operon-provision-user` (fork-discipline.md rows 1 and
 * 6), not by Kaneo's own invite flow — so this page keeps the roster (still useful to see
 * who is here) but stops offering Kaneo's own invite modal: `MembersTable` below is
 * rendered fully read-only (no role changes, no removal, no invitation actions), and the
 * one action this page used to open in place now leaves for Operon Settings -> Users,
 * where inviting and role changes actually happen. `apexUrl()` is the same
 * runtime-substituted `OPERON_APEX_URL` the injected switcher (B11) and the Telegraph
 * external-link href (B12) already read, so this is a third reader of the same value
 * rather than a new configuration surface.
 *
 * The `#/settings` fragment is a small paired addition on the OPERON side
 * (`app/src/shell/AppShell.tsx`'s `initialModule`, GUI pass task 4) recognising exactly
 * that one hash and landing on the Settings module — `SettingsView.tsx` already defaults
 * an admin session to its "Users & Roles" tab, so no further tab-selecting fragment is
 * needed to reach Users specifically.
 *
 * The link itself is gated on `canInviteUsers()` (Codex round-1 finding 13): a non-admin
 * who followed it would land on Operon Settings -> Account, not Users, because that is
 * where `SettingsView.tsx` sends a non-admin session — a dead-end link pointing at UI the
 * reader cannot reach either way. A non-admin sees the badge alone, which is still an
 * accurate, non-actionable statement of who manages this roster.
 */
function RouteComponent() {
  const { t } = useTranslation();
  const { workspaceId } = Route.useParams();
  const { data: workspace } = useGetFullWorkspace({ workspaceId });
  const { canInviteUsers } = useWorkspacePermission();
  const canInvite = Boolean(canInviteUsers());

  return (
    <>
      <PageTitle title={t("team:members.pageTitle")} />
      <WorkspaceLayout
        title={t("team:members.pageTitle")}
        headerActions={
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="text-[10px] uppercase tracking-wide"
            >
              Managed by Operon
            </Badge>
            {canInvite ? (
              <a
                href={`${apexUrl()}/#/settings`}
                className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground no-underline hover:text-foreground"
              >
                <ExternalLink className="w-3 h-3" />
                {t("team:members.inviteMember")}
              </a>
            ) : null}
          </div>
        }
      >
        <MembersTable
          workspaceId={workspaceId}
          users={workspace?.members ?? []}
          invitations={workspace?.invitations ?? []}
        />
      </WorkspaceLayout>
    </>
  );
}
