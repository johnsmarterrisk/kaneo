import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useLocation,
} from "@tanstack/react-router";
import { CreditCard, Settings, Shield, Tag } from "lucide-react";
import { useTranslation } from "react-i18next";
import SettingsSidebar from "@/components/SettingsSidebar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import getWorkspaces from "@/fetchers/workspace/get-workspaces";
import useGetConfig from "@/hooks/queries/config/use-get-config";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { getInitials } from "@/lib/get-initials";
import type Workspace from "@/types/workspace";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/settings/workspace",
)({
  beforeLoad: async ({ context }) => {
    // Settings pages live outside `/dashboard/workspace/$workspaceId`, so they
    // have no route param to identify "which workspace". They rely on the
    // session's active organization. A user who deep-links here (or refreshes)
    // before ever visiting a workspace dashboard would otherwise see an empty
    // sidebar ("WS / Roles.Undefined") and a stuck "Loading…", so pick the first
    // workspace as active so the layout has something to render.
    //
    // The parent route reports whether the session fetch succeeded. When it
    // failed we don't know the user's current active organization, so we must
    // skip the fallback — calling `setActive` would clobber whatever the user
    // already had selected. Only select the first workspace after a successful
    // session response confirms that no active organization is set.
    if (context.sessionError) return;
    const session = context.session;
    if (!session) return; // parent should have redirected unauthenticated users
    if (session.session?.activeOrganizationId) return;

    let workspaces: Workspace[] = [];
    try {
      workspaces = await getWorkspaces();
    } catch (error) {
      if (import.meta.env.DEV) console.warn("getWorkspaces failed", error);
      throw redirect({ to: "/onboarding" });
    }
    if (workspaces.length === 0) {
      throw redirect({ to: "/onboarding" });
    }

    await authClient.organization.setActive({
      organizationId: workspaces[0].id,
    });
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation();
  const { workspace, role } = useWorkspacePermission();
  const { data: config } = useGetConfig();
  const location = useLocation();
  const menuItems = [
    {
      title: t("settings:workspaceGeneral.title"),
      url: "/dashboard/settings/workspace/general",
      icon: Settings,
    },
    {
      title: t("settings:workspaceRoles.title", { defaultValue: "Roles" }),
      url: "/dashboard/settings/workspace/roles",
      icon: Shield,
    },
    {
      title: t("settings:workspaceLabels.title", { defaultValue: "Labels" }),
      url: "/dashboard/settings/workspace/labels",
      icon: Tag,
    },
    ...(config?.billingEnabled
      ? [
          {
            title: "Billing",
            url: "/dashboard/settings/workspace/billing",
            icon: CreditCard,
          },
        ]
      : []),
  ];
  const isActivePath = (path: string) => location.pathname === path;
  const workspaceInitials = getInitials(workspace?.name, "WS");

  return (
    <div className="flex gap-6 h-full">
      <SettingsSidebar>
        {/* This aside sits on the settings frame's white bg-card panel (settings.tsx),
            not the app's navy ground. Every class below was originally one of the
            sidebar-scoped rail tokens (correct only on the navy sidebar surface); on
            this white panel they rendered as white-on-white or near-invisible
            dark-on-transparent. Swapped for the white-panel equivalents — same GUI-4
            pattern as projects.tsx (see operon-project-settings-contrast.test.ts). */}
        <div className="p-2">
          <div className="mb-1 flex items-center gap-3 rounded-md px-2 py-2">
            <Avatar className="h-8 w-8">
              <AvatarImage
                src={workspace?.logo ?? ""}
                alt={workspace?.name || ""}
              />
              <AvatarFallback className="border border-border/70 text-xs font-medium">
                {workspaceInitials}
              </AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-col md:min-w-fit">
              <p className="truncate text-sm text-card-foreground md:overflow-visible md:text-clip md:whitespace-normal">
                {workspace?.name}
              </p>
              <p className="truncate text-xs text-muted-foreground capitalize md:overflow-visible md:text-clip md:whitespace-normal">
                {t(`team:roles.${role}`, { defaultValue: role })}
              </p>
            </div>
          </div>

          <SidebarGroup className="gap-1 p-1">
            <SidebarGroupLabel className="h-7 px-2 text-xs uppercase tracking-wide text-muted-foreground">
              {t("navigation:page.settingsWorkspaceTab")}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {menuItems.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <Button
                      render={<Link to={item.url} />}
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-8 w-full justify-start gap-2 rounded-lg px-2 text-sm font-normal text-muted-foreground",
                        isActivePath(item.url) &&
                          "bg-accent text-accent-foreground",
                      )}
                    >
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </Button>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </div>
      </SettingsSidebar>

      <div className="flex-1 min-w-0 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
