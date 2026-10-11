import en from "@i18n/en-US.json";
import fr from "@i18n/fr-FR.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Operon fork check (John's ruling 2026-10-11, Tables spec section 15; docs/fork-discipline.md
 * rows 2 and 18): the workspace sub-rail reads Boards, Tables, Members, in that order, with
 * Tables opening the Tables page; the sidebar's group label reads "Project Boards" (shown
 * uppercase) and lists boards only; a TABLES group under it lists each table and opens its
 * table view; the breadcrumb switcher lists boards only; the four English labels are en-US
 * values or English-only renders, and no other locale changes.
 */

const state = vi.hoisted(() => ({
  language: "en-US",
  navigate: vi.fn(),
  projects: [] as { id: string; name: string; isTable: boolean }[],
  readableTables: [] as { tableId: string; name: string }[],
  summaryError: false,
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: state.language },
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => ({}),
}));
vi.mock("@/hooks/queries/workspace/use-active-workspace", () => ({
  default: () => ({ data: { id: "w1" } }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { useListOrganizations: () => ({ data: [] }) },
}));
vi.mock("@/hooks/queries/project/use-get-projects", () => ({
  default: () => ({ data: state.projects }),
}));
// The summary route answers only the tables the caller may read (project:read, task:read).
vi.mock("@/hooks/queries/operon-tables/use-tables-summary", () => ({
  // TanStack keeps the last good `data` when a refetch fails; `isError` is what changes.
  default: () => ({
    data: { tables: state.readableTables, nextCursor: null },
    isError: state.summaryError,
  }),
}));
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    canCreateProjects: () => true,
    canDeleteProjects: () => true,
    canUpdateProjects: () => true,
  }),
}));
vi.mock("@/hooks/mutations/project/use-delete-project", () => ({
  default: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/project/use-reorder-projects", () => ({
  default: () => vi.fn(),
}));
vi.mock("@/components/shared/modals/create-project-modal", () => ({
  default: () => null,
}));

const { NavMain } = await import("@/components/nav-main");
const { NavProjects } = await import("@/components/nav-projects");
const { NavTables } = await import("@/components/operon-tables/nav-tables");
const { default: ProjectCrumbSelect } = await import(
  "@/components/common/header/project-crumb-select"
);
const { SidebarProvider } = await import("@/components/ui/sidebar");

function renderInSidebar(node: ReactNode) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <SidebarProvider>{node}</SidebarProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  state.language = "en-US";
  state.summaryError = false;
  state.navigate.mockClear();
  state.projects = [
    { id: "p1", name: "Website relaunch", isTable: false },
    { id: "t1", name: "Risk tips", isTable: true },
    { id: "p2", name: "Q4 campaign", isTable: false },
    { id: "t2", name: "Roadmap", isTable: true },
  ];
  state.readableTables = [
    { tableId: "t1", name: "Risk tips" },
    { tableId: "t2", name: "Roadmap" },
  ];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("The workspace sub-rail (OVERVIEW)", () => {
  it("reads Boards, Tables, Members, in that order", () => {
    renderInSidebar(<NavMain />);
    const items = screen
      .getAllByRole("button")
      .map((button) => button.textContent?.trim())
      .filter((text) => text && text !== "navigation:sidebar.overview");
    expect(items).toEqual(["Boards", "Tables", "navigation:sidebar.members"]);
  });

  it("Tables opens the Tables page; Boards the boards list", () => {
    renderInSidebar(<NavMain />);
    fireEvent.click(screen.getByRole("button", { name: "Tables" }));
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/dashboard/workspace/w1/tables",
    });
    fireEvent.click(screen.getByRole("button", { name: "Boards" }));
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/dashboard/workspace/w1",
    });
  });

  it("keeps the shared key's own translation in any other language", () => {
    state.language = "fr-FR";
    renderInSidebar(<NavMain />);
    expect(
      screen.getByRole("button", { name: "navigation:sidebar.projects" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Boards" })).toBeNull();
  });
});

describe("The sidebar groups", () => {
  it("PROJECT BOARDS lists the boards only, uppercase-styled", () => {
    renderInSidebar(<NavProjects />);
    const label = screen.getByText("Project Boards");
    expect(label.parentElement?.className).toContain("uppercase");
    expect(screen.getByText("Website relaunch")).toBeTruthy();
    expect(screen.getByText("Q4 campaign")).toBeTruthy();
    expect(screen.queryByText("Risk tips")).toBeNull();
    expect(screen.queryByText("Roadmap")).toBeNull();
  });

  it("TABLES lists each table, uppercase-styled, and opens its table view", () => {
    renderInSidebar(<NavTables />);
    const group = screen.getByTestId("nav-tables");
    const label = within(group).getByText("Tables");
    expect(label.parentElement?.className).toContain("uppercase");
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent?.trim())
        .filter((text) => text !== "Tables"),
    ).toEqual(["Risk tips", "Roadmap"]);
    fireEvent.click(within(group).getByText("Roadmap"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/dashboard/workspace/$workspaceId/project/$projectId/table",
      params: { workspaceId: "w1", projectId: "t2" },
    });
  });

  it("TABLES names only the tables the summary lets this member read (Codex round 1, finding 1)", () => {
    // "Roadmap" is in the workspace's project list but the member may not read it.
    state.readableTables = [{ tableId: "t1", name: "Risk tips" }];
    renderInSidebar(<NavTables />);
    const group = screen.getByTestId("nav-tables");
    expect(within(group).getByText("Risk tips")).toBeTruthy();
    expect(screen.queryByText("Roadmap")).toBeNull();
  });

  it("TABLES drops a cached list when the refetch is denied (Codex round 2)", () => {
    renderInSidebar(<NavTables />);
    expect(screen.getByText("Risk tips")).toBeTruthy();
    cleanup();
    state.summaryError = true;
    renderInSidebar(<NavTables />);
    expect(screen.queryByTestId("nav-tables")).toBeNull();
    expect(screen.queryByText("Risk tips")).toBeNull();
    expect(screen.queryByText("Roadmap")).toBeNull();
  });

  it("TABLES renders nothing while the workspace has no table", () => {
    state.readableTables = [];
    renderInSidebar(<NavTables />);
    expect(screen.queryByTestId("nav-tables")).toBeNull();
  });
});

describe("The breadcrumb project switcher", () => {
  it("keeps tables out of its list", () => {
    renderInSidebar(
      <ProjectCrumbSelect
        workspaceId="w1"
        projectId="p1"
        projectName="Website relaunch"
        onSelectProject={vi.fn()}
        onAddProject={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Website relaunch/ }));
    expect(screen.getByText("Q4 campaign")).toBeTruthy();
    expect(screen.queryByText("Risk tips")).toBeNull();
  });
});

describe("The en-US labels (values only) and the other locales", () => {
  it("en-US: New board and Project Boards; the shared sidebar key unchanged", () => {
    expect(en.workspace.projects.createProject).toBe("New board");
    expect(en.workspace.projects.pageTitle).toBe("Project Boards");
    expect(en.navigation.sidebar.projects).toBe("Projects");
  });

  it("another locale keeps its own wording", () => {
    expect(fr.navigation.sidebar.projects).toBe("Projets");
    expect(fr.workspace.projects.pageTitle).not.toBe("Project Boards");
    expect(fr.workspace.projects.createProject).not.toBe("New board");
  });
});
