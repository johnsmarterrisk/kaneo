import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import Layout, { usePhoneNav } from "@/components/common/layout";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { KbdSequence } from "@/components/ui/kbd";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { shortcuts } from "@/constants/shortcuts";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";
import { cn } from "@/lib/cn";

type WorkspaceLayoutProps = {
  title: string;
  headerActions?: ReactNode;
  children: ReactNode;
  onCreateProject?: () => void;
  className?: string;
};

export default function WorkspaceLayout({
  title,
  headerActions,
  children,
  className,
}: WorkspaceLayoutProps) {
  const { data: workspace } = useActiveWorkspace();
  const phoneNav = usePhoneNav();

  return (
    <Layout>
      <Layout.Header>
        <div className="flex items-center justify-between w-full">
          {/* Phone Work top bar (Piece B): back arrow + title only — the desktop
              breadcrumb/sidebar-toggle block below is `hidden` at this width rather than
              removed, so nothing about it needs to change for md and up. */}
          <div className="flex md:hidden min-w-0 items-center gap-2">
            <button
              type="button"
              data-testid="phone-back-to-navigate"
              aria-label="Back to Navigate"
              onClick={() => phoneNav?.openPhoneNav()}
              className="min-w-[44px] min-h-[44px] flex items-center justify-center -ml-2"
            >
              <ArrowLeft className="size-5" aria-hidden="true" />
            </button>
            <span className="truncate text-base font-bold">{title}</span>
          </div>
          <div className="hidden md:flex min-w-0 items-center gap-1">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <SidebarTrigger className="-ml-1 h-6 w-6" />
                </TooltipTrigger>
                <TooltipContent>
                  <p className="flex items-center gap-2 text-[10px]">
                    Toggle sidebar
                    <KbdSequence
                      keys={[
                        shortcuts.sidebar.prefix,
                        shortcuts.sidebar.toggle,
                      ]}
                    />
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <div className="mx-1.5 h-4 w-px shrink-0 bg-border/80" />
            <Breadcrumb className="flex items-center gap-1 text-xs w-full">
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink href="/">
                    <span className="text-xs font-normal text-card-foreground">
                      {workspace?.name}
                    </span>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <span className="text-xs font-normal text-card-foreground">
                    {title}
                  </span>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
          <div
            className={`${cn("flex shrink-0 items-center gap-1.5", className)}`}
          >
            {headerActions}
          </div>
        </div>
      </Layout.Header>
      <Layout.Content>{children}</Layout.Content>
    </Layout>
  );
}
