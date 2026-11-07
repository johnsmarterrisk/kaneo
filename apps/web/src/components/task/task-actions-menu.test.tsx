import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerScriptSource,
  resetScriptSourcesForTests,
} from "@/lib/script-source";
import TaskActionsMenu from "./task-actions-menu";

const mocks = vi.hoisted(() => ({
  task: undefined as
    | {
        id: string;
        title: string;
        number: number | null;
        description: string | null;
      }
    | undefined,
  canDeleteTasks: vi.fn(),
  isCheckingPermissions: false,
  deleteTask: vi.fn(),
  copyToClipboard: vi.fn(),
  saveScriptFile: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/queries/task/use-get-task", () => ({
  default: () => ({ data: mocks.task }),
}));
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    canDeleteTasks: mocks.canDeleteTasks,
    isCheckingPermissions: mocks.isCheckingPermissions,
  }),
}));
vi.mock("@/hooks/mutations/task/use-delete-task", () => ({
  useDeleteTask: () => ({ mutateAsync: mocks.deleteTask, isPending: false }),
}));
vi.mock("@/lib/copy-to-clipboard", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));
vi.mock("@/lib/save-script-file", () => ({
  saveScriptFile: mocks.saveScriptFile,
}));
vi.mock("@/lib/toast", () => ({
  toast: { error: mocks.error, success: mocks.success },
}));

const MENU = "tasks:scriptExport.menu";
const COPY = "tasks:scriptExport.copyScript";
const DELETE = "tasks:delete.action";
const TEXT = "tasks:scriptExport.downloadText";
const MARKDOWN = "tasks:scriptExport.downloadMarkdown";

beforeEach(() => {
  mocks.task = {
    id: "task-1",
    title: "MV-10 Hearing",
    number: 7,
    description: "**Wear** earplugs. [OSHA](https://x)",
  };
  mocks.canDeleteTasks.mockReturnValue(true);
  mocks.isCheckingPermissions = false;
  mocks.copyToClipboard.mockResolvedValue(true);
  mocks.saveScriptFile.mockResolvedValue("saved");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  resetScriptSourcesForTests();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: MENU }));
  return screen.findByRole("menu");
}

async function clickItem(name: string) {
  await openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

describe("TaskActionsMenu", () => {
  it("renders no trigger while the task is loading", () => {
    mocks.task = undefined;
    render(<TaskActionsMenu taskId="task-1" withDelete />);
    expect(screen.queryByRole("button", { name: MENU })).toBeNull();
  });

  it("copies the script synchronously within the click and reports success", async () => {
    render(<TaskActionsMenu taskId="task-1" withDelete={false} />);
    await openMenu();
    const item = await screen.findByRole("menuitem", { name: COPY });

    fireEvent.click(item);
    // Called inside the click itself, before any await (AC2).
    expect(mocks.copyToClipboard).toHaveBeenCalledWith(
      "MV-10 Hearing\n\nWear earplugs.",
    );

    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("tasks:scriptExport.copied"),
    );
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("copies the title alone for an empty description", async () => {
    mocks.task = {
      id: "task-1",
      title: "Only title",
      number: 7,
      description: null,
    };
    render(<TaskActionsMenu taskId="task-1" withDelete={false} />);
    await clickItem(COPY);
    expect(mocks.copyToClipboard).toHaveBeenCalledWith("Only title");
  });

  it("prefers the live editor source over the cached description", async () => {
    registerScriptSource("task-1", () => "Just typed");
    render(<TaskActionsMenu taskId="task-1" withDelete={false} />);
    await clickItem(COPY);
    expect(mocks.copyToClipboard).toHaveBeenCalledWith(
      "MV-10 Hearing\n\nJust typed",
    );
  });

  it("reports a failure when the clipboard write returns false", async () => {
    mocks.copyToClipboard.mockResolvedValue(false);
    render(<TaskActionsMenu taskId="task-1" withDelete={false} />);
    await clickItem(COPY);
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("tasks:scriptExport.copyFailed"),
    );
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("reports a failure when the clipboard write throws", async () => {
    mocks.copyToClipboard.mockRejectedValue(new Error("denied"));
    render(<TaskActionsMenu taskId="task-1" withDelete={false} />);
    await clickItem(COPY);
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("tasks:scriptExport.copyFailed"),
    );
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("reports a failure and copies nothing when the live source throws", async () => {
    registerScriptSource("task-1", () => {
      throw new Error("editor gone");
    });
    render(<TaskActionsMenu taskId="task-1" withDelete={false} />);
    await clickItem(COPY);
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith("tasks:scriptExport.copyFailed");
    // The log names the task and the error kind, never the script text.
    expect(console.error).toHaveBeenCalledWith("[script-export] copy failed", {
      taskId: "task-1",
      name: "Error",
    });
  });

  it("has no delete item without withDelete", async () => {
    render(<TaskActionsMenu taskId="task-1" withDelete={false} />);
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: DELETE })).toBeNull();
  });

  it("has no delete item while permissions are being checked", async () => {
    mocks.isCheckingPermissions = true;
    render(<TaskActionsMenu taskId="task-1" withDelete />);
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: DELETE })).toBeNull();
  });

  it("has no delete item without delete permission", async () => {
    mocks.canDeleteTasks.mockReturnValue(false);
    render(<TaskActionsMenu taskId="task-1" withDelete />);
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: DELETE })).toBeNull();
  });

  it("opens the confirm dialog after the menu closes, and confirm deletes", async () => {
    const onDeleted = vi.fn();
    mocks.deleteTask.mockResolvedValue({ id: "task-1" });
    render(
      <TaskActionsMenu taskId="task-1" withDelete onDeleted={onDeleted} />,
    );
    // The phone menu carries the action; there is no standalone trash trigger.
    expect(screen.queryByRole("button", { name: DELETE })).toBeNull();

    await clickItem(DELETE);
    expect(await screen.findByText("tasks:delete.title")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: DELETE }));
    await waitFor(() =>
      expect(mocks.deleteTask).toHaveBeenCalledWith("task-1"),
    );
    expect(onDeleted).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByText("tasks:delete.title")).toBeNull(),
    );
  });

  it("keeps the task when the confirm dialog is cancelled", async () => {
    const onDeleted = vi.fn();
    render(
      <TaskActionsMenu taskId="task-1" withDelete onDeleted={onDeleted} />,
    );
    await clickItem(DELETE);
    expect(await screen.findByText("tasks:delete.title")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "common:actions.cancel" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("tasks:delete.title")).toBeNull(),
    );
    expect(mocks.deleteTask).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  // Leg B (T10): both download items, each against every save outcome.
  const downloads = [
    {
      item: TEXT,
      filename: "07 - MV-10 Hearing.txt",
      type: "text/plain;charset=utf-8",
      body: "MV-10 Hearing\n\nWear earplugs.",
      liveBody: "MV-10 Hearing\n\nJust typed",
    },
    {
      item: MARKDOWN,
      filename: "07 - MV-10 Hearing.md",
      type: "text/markdown;charset=utf-8",
      body: "# MV-10 Hearing\n\n**Wear** earplugs. [OSHA](https://x)",
      liveBody: "# MV-10 Hearing\n\nJust typed",
    },
  ];

  describe.each(downloads)("$item", (d) => {
    it("saves the named file synchronously within the click, no toast", async () => {
      render(<TaskActionsMenu taskId="task-1" withDelete={false} />);
      await openMenu();
      fireEvent.click(await screen.findByRole("menuitem", { name: d.item }));
      expect(mocks.saveScriptFile).toHaveBeenCalledWith({
        filename: d.filename,
        body: d.body,
        type: d.type,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(mocks.error).not.toHaveBeenCalled();
      expect(mocks.success).not.toHaveBeenCalled();
    });

    it("saves the live editor text over the cache", async () => {
      registerScriptSource("task-1", () => "Just typed");
      render(<TaskActionsMenu taskId="task-1" withDelete={false} />);
      await clickItem(d.item);
      expect(mocks.saveScriptFile).toHaveBeenCalledWith(
        expect.objectContaining({ body: d.liveBody }),
      );
    });

    it("points at Copy script when saving is unavailable", async () => {
      mocks.saveScriptFile.mockResolvedValue("unavailable");
      render(<TaskActionsMenu taskId="task-1" withDelete={false} />);
      await clickItem(d.item);
      await waitFor(() =>
        expect(mocks.error).toHaveBeenCalledWith(
          "tasks:scriptExport.saveUnavailable",
        ),
      );
    });

    it("reports a failed save", async () => {
      mocks.saveScriptFile.mockRejectedValue(new Error("denied"));
      render(<TaskActionsMenu taskId="task-1" withDelete={false} />);
      await clickItem(d.item);
      await waitFor(() =>
        expect(mocks.error).toHaveBeenCalledWith(
          "tasks:scriptExport.saveFailed",
        ),
      );
    });

    it("reports a throwing live source without saving", async () => {
      registerScriptSource("task-1", () => {
        throw new Error("editor gone");
      });
      render(<TaskActionsMenu taskId="task-1" withDelete={false} />);
      await clickItem(d.item);
      expect(mocks.saveScriptFile).not.toHaveBeenCalled();
      expect(mocks.error).toHaveBeenCalledWith("tasks:scriptExport.saveFailed");
    });
  });
});
