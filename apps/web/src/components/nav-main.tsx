import { useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";
import { authClient } from "@/lib/auth-client";

export function NavMain() {
  const { t } = useTranslation();
  const { data: activeWorkspace } = useActiveWorkspace();
  const { data: organizations } = authClient.useListOrganizations();
  const navigate = useNavigate();

  /*
    Operon change (spec R14, task B11): fall back to the session's single workspace.

    `useActiveWorkspace` resolves from the route's `workspaceId` param first and the
    session's active organization second, so on a route that carries neither — the
    invitations list and every account settings page — this nav rendered nothing at all.
    Upstream that was tolerable because `WorkspaceSwitcher` sat above it and could put a
    workspace back into the session. B11 hides that switcher, so the fallback has to come
    from the session itself, and per decision 49 Initiative has exactly ONE workspace: when
    the session lists exactly one, that is unambiguously the workspace this nav belongs to.
    More than one is not a state this deployment creates, and guessing between them would
    be worse than rendering nothing, so the fallback deliberately applies only to a list of
    length one.
  */
  const sessionWorkspace =
    organizations?.length === 1 ? organizations[0] : undefined;
  const workspace = activeWorkspace ?? sessionWorkspace;

  if (!workspace) return null;

  // Operon mode (spec R14, GUI pass task 4a; docs/fork-discipline.md row 13): no
  // "Invitations" entry. Operon owns identity and workspace membership end to end
  // (`operon-account`/`operon-provision-user`, fork-discipline.md rows 1 and 6) — a
  // Kaneo-native invitation would mint access outside that path — so the item, its
  // pending-count badge and the `usePendingInvitations` query it needed are all gone
  // rather than merely hidden, and the Members row below is the one place left that
  // still talks about who is on the workspace.
  const navItems = [
    {
      title: t("navigation:sidebar.projects"),
      url: `/dashboard/workspace/${workspace.id}`,
      isActive:
        window.location.pathname === `/dashboard/workspace/${workspace.id}`,
      badge: null,
    },
    {
      title: t("navigation:sidebar.members"),
      url: `/dashboard/workspace/${workspace.id}/members`,
      isActive:
        window.location.pathname ===
        `/dashboard/workspace/${workspace.id}/members`,
      badge: null,
    },
  ];

  return (
    <Collapsible defaultOpen className="group/collapsible">
      <SidebarGroup className="gap-1 p-2">
        <CollapsibleTrigger
          className="data-panel-open:[&_svg]:rotate-90"
          render={
            <SidebarGroupLabel className="h-7 cursor-pointer justify-between px-0 text-sidebar-accent-foreground" />
          }
        >
          <span>{t("navigation:sidebar.overview")}</span>
          <ChevronRight className="h-3.5 w-3.5 text-sidebar-foreground/60 transition-transform duration-200" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {navItems.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton
                    tooltip={item.title}
                    isActive={item.isActive}
                    size="default"
                    className="h-8 ps-3.5 text-sm hover:bg-transparent hover:text-sidebar-accent-foreground active:bg-transparent"
                    onClick={() => navigate({ to: item.url })}
                  >
                    <span>{item.title}</span>
                    {item.badge !== null && (
                      <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-sm border border-sidebar-border/60 px-1 text-[11px] font-medium text-sidebar-foreground/80">
                        {item.badge}
                      </span>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsiblePanel>
      </SidebarGroup>
    </Collapsible>
  );
}
