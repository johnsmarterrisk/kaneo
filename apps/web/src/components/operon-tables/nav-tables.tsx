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
import useTablesSummary from "@/hooks/queries/operon-tables/use-tables-summary";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";

/**
 * Operon fork addition (John's ruling 2026-10-11, Tables follow-up; docs/fork-discipline.md
 * row 18): the sidebar's TABLES group, under PROJECT BOARDS — each table listed the way
 * `nav-projects.tsx` lists a board (same label styling, 44px rows, same collapse), each
 * opening its table view. Read from the Tables summary (Codex round 1, finding 1), never the
 * general project list: the summary route lists only tables the caller passes `project:read`
 * and `task:read` on, so a table a member may not read is never named here. It is the same
 * query the Tables page uses. Nothing renders while there is no readable table: the
 * sub-rail's "Tables" entry is the way to the Tables page and its "New table".
 */
export function NavTables() {
  const navigate = useNavigate();
  const { data: workspace } = useActiveWorkspace();
  const { data: summary, isError } = useTablesSummary(workspace?.id || "");
  const { projectId: currentProjectId } = useParams({ strict: false });
  const tables = summary?.tables ?? [];
  // Codex round 2: a failed refresh (403 once project:read or task:read is revoked) keeps
  // TanStack's cached list in `data`; names the caller may no longer read must not stay up.
  if (!workspace || isError || tables.length === 0) return null;

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
                <SidebarMenuItem key={table.tableId}>
                  <SidebarMenuButton
                    isActive={currentProjectId === table.tableId}
                    size="default"
                    className="h-11 gap-0 ps-3.5 text-sm hover:bg-transparent hover:text-sidebar-accent-foreground active:bg-transparent"
                    onClick={() =>
                      navigate({
                        to: "/dashboard/workspace/$workspaceId/project/$projectId/table",
                        params: {
                          workspaceId: workspace.id,
                          projectId: table.tableId,
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
