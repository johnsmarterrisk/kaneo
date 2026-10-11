import { useNavigate, useParams } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
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
import useGetProjects from "@/hooks/queries/project/use-get-projects";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";

/**
 * Operon fork addition (John's ruling 2026-10-11, Tables follow-up; docs/fork-discipline.md
 * row 18): the sidebar's TABLES group, under PROJECT BOARDS — each table listed the way
 * `nav-projects.tsx` lists a board (same label styling, 44px rows, same collapse), each
 * opening its table view. Read from the same project list the boards come from (`isTable`),
 * so no second request. Nothing renders while the workspace has no table: the sub-rail's
 * "Tables" entry is the way to the Tables page and its "New table".
 */
export function NavTables() {
  const navigate = useNavigate();
  const { data: workspace } = useActiveWorkspace();
  const { data: projects } = useGetProjects({
    workspaceId: workspace?.id || "",
  });
  const { projectId: currentProjectId } = useParams({ strict: false });
  const tables = projects?.filter((project) => project.isTable) ?? [];
  if (!workspace || tables.length === 0) return null;

  return (
    <Collapsible defaultOpen className="group/collapsible">
      <SidebarGroup
        data-testid="nav-tables"
        className="group-data-[collapsible=icon]:hidden gap-1 p-2 pt-1"
      >
        <CollapsibleTrigger
          className="data-panel-open:[&_svg]:rotate-90"
          render={
            <SidebarGroupLabel className="h-7 cursor-pointer justify-between px-0 text-[12.5px] font-bold uppercase tracking-wide text-sidebar-accent-foreground" />
          }
        >
          <span>Tables</span>
          <ChevronRight className="h-3.5 w-3.5 text-sidebar-foreground/60 transition-transform duration-200" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {tables.map((table) => (
                <SidebarMenuItem key={table.id}>
                  <SidebarMenuButton
                    isActive={currentProjectId === table.id}
                    size="default"
                    className="h-11 gap-0 ps-3.5 text-sm hover:bg-transparent hover:text-sidebar-accent-foreground active:bg-transparent"
                    onClick={() =>
                      navigate({
                        to: "/dashboard/workspace/$workspaceId/project/$projectId/table",
                        params: {
                          workspaceId: workspace.id,
                          projectId: table.id,
                        },
                      })
                    }
                  >
                    <span>{table.name}</span>
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
