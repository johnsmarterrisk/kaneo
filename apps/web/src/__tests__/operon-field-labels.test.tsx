import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperonFieldLabelsSettings } from "@/components/project/operon-field-labels-settings";
import { useProjectFieldLabel } from "@/hooks/queries/operon-field-labels/use-project-field-label";

/**
 * Operon fork checks (social agent S18, task 6): optional per-project field labels.
 *
 * The hook answers `undefined` for a project without labels, a failed read and a read still
 * loading, and every touched call site falls through to the exact translation it used
 * before (`?? t("<same key>")`, asserted on the source below), so a project without labels
 * renders as upstream. With labels the call sites show the project's words.
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "settings:projectGeneral.descriptionLabel": "Description",
        "tasks:dueDate.label": "Due date",
      })[key] ?? key,
  }),
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

function answer(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useProjectFieldLabel", () => {
  it("answers undefined for a project without labels, so the call site keeps its translation", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      answer({ projectId: "p1", descriptionLabel: null, dueDateLabel: null }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(
      () => [
        useProjectFieldLabel("p1", "description"),
        useProjectFieldLabel("p1", "dueDate"),
      ],
      { wrapper },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(result.current).toEqual([undefined, undefined]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
      /\/api\/operon\/project-field-labels\/p1$/,
    );
  });

  it("answers the Social project's Caption and Publish date", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer({
          projectId: "p1",
          descriptionLabel: "Caption",
          dueDateLabel: "Publish date",
        }),
      ),
    );
    const { result } = renderHook(
      () => [
        useProjectFieldLabel("p1", "description"),
        useProjectFieldLabel("p1", "dueDate"),
      ],
      { wrapper },
    );
    await waitFor(() =>
      expect(result.current).toEqual(["Caption", "Publish date"]),
    );
  });

  it("answers undefined when the read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ message: "no" }, 500)),
    );
    const { result } = renderHook(() => useProjectFieldLabel("p1", "dueDate"), {
      wrapper,
    });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(result.current).toBeUndefined();
  });
});

describe("OperonFieldLabelsSettings", () => {
  it("shows two empty fields with the translated defaults as placeholders, and saves on blur", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? answer({
            projectId: "p1",
            descriptionLabel: "Caption",
            dueDateLabel: null,
          })
        : answer({
            projectId: "p1",
            descriptionLabel: null,
            dueDateLabel: null,
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<OperonFieldLabelsSettings projectId="p1" canEdit />, { wrapper });

    const description = (await screen.findByLabelText(
      "Label for the description",
    )) as HTMLInputElement;
    const dueDate = screen.getByLabelText(
      "Label for the due date",
    ) as HTMLInputElement;
    await waitFor(() => expect(description.disabled).toBe(false));
    expect(description.value).toBe("");
    expect(description.placeholder).toBe("Description");
    expect(dueDate.value).toBe("");
    expect(dueDate.placeholder).toBe("Due date");

    // Blur without a change sends nothing.
    fireEvent.blur(dueDate);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PUT"),
    ).toBe(false);

    fireEvent.change(description, { target: { value: "Caption" } });
    fireEvent.blur(description);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.find(([, init]) => init?.method === "PUT"),
      ).toBeTruthy(),
    );
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      descriptionLabel: "Caption",
      dueDateLabel: "",
    });
  });

  it("is read-only for someone who cannot edit the project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer({ projectId: "p1", descriptionLabel: null, dueDateLabel: null }),
      ),
    );
    render(<OperonFieldLabelsSettings projectId="p1" canEdit={false} />, {
      wrapper,
    });
    const description = (await screen.findByLabelText(
      "Label for the description",
    )) as HTMLInputElement;
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(description.disabled).toBe(true);
  });
});

describe("the touched task screens fall back to their existing translation", () => {
  // Each call site: the file, the label it reads, and the exact translation it used before.
  const sites: [string, string, string, number][] = [
    [
      "components/kanban-board/task-card-context-menu/task-card-context-menu-content.tsx",
      "dueDateLabel",
      "tasks:dueDate.label",
      1,
    ],
    [
      "components/task/task-properties-sidebar.tsx",
      "dueDateLabel",
      "tasks:properties.noDate",
      3,
    ],
    [
      "components/shared/modals/create-task-modal.tsx",
      "dueDateLabel",
      "common:modals.createTask.dueDate",
      1,
    ],
    [
      "components/shared/modals/create-task-modal.tsx",
      "descriptionLabel",
      "common:modals.createTask.descriptionPlaceholder",
      1,
    ],
    [
      "components/task/task-description.tsx",
      "descriptionLabelRef.current",
      "tasks:detail.editor.placeholder",
      1,
    ],
  ];

  for (const [file, label, key, count] of sites) {
    it(`${file}: ${label} ?? t("${key}")`, () => {
      const source = readFileSync(resolve(__dirname, "..", file), "utf8");
      const pattern = new RegExp(
        `${label.replace(/\./g, "\\.")} \\?\\?\\s*t\\("${key.replace(/\./g, "\\.")}"\\)`,
        "g",
      );
      expect(source.match(pattern)?.length ?? 0).toBe(count);
      // And no bare use of the key is left behind at that site.
      const bare = source.match(
        new RegExp(`t\\("${key.replace(/\./g, "\\.")}"\\)`, "g"),
      );
      expect(bare?.length ?? 0).toBe(count);
    });
  }
});
