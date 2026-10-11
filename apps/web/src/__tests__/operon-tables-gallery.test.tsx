import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Gallery from "@/components/operon-tables/gallery";
import {
  pickable,
  StashPickerDialog,
  stashFileId,
} from "@/components/operon-tables/stash-picker";
import {
  MAX_CONCURRENT_PREVIEWS,
  previewsInFlight,
} from "@/components/operon-tables/use-stash-thumbnail";
import type { TableRow } from "@/fetchers/operon-tables/get-table-rows";

/**
 * Operon fork check (Tables task 11, docs/fork-discipline.md row 18, spec 7.10 US5 / R-F):
 * the gallery shows one tile per entry with an image, fetched from the platform origin with
 * credentials, four at most in flight, each refusal as its named placeholder (never a broken
 * image); a tile opens the entry; the Stash picker lists folders and image files only.
 */
const table = {
  projectId: "p1",
  name: "Did you know",
  isTable: true as const,
  groupFieldId: "topic",
  dateFieldId: "posted",
  statusFieldId: null,
  columns: [
    {
      id: "topic",
      name: "Topic",
      kind: "dropdown",
      required: false,
      options: ["Cyber"],
      position: 1,
    },
    {
      id: "posted",
      name: "Posted",
      kind: "date",
      required: false,
      options: null,
      position: 2,
    },
    {
      id: "graphic",
      name: "Graphic",
      kind: "image",
      required: false,
      options: null,
      position: 3,
    },
  ],
};

function row(id: string, title: string, graphic: string | null): TableRow {
  return {
    rowId: id,
    tableId: "p1",
    title,
    notes: "",
    assigneeId: null,
    values: { Topic: "Cyber", Posted: "2026-10-06", Graphic: graphic },
    madeBy: { id: "u1", name: "Dana" },
    createdAt: null,
    lastChange: {
      by: { id: null, name: null },
      at: null,
      columns: [],
      summary: null,
    },
    url: "",
  };
}

const STATUS_BY_FILE: Record<string, number> = {
  "f-ok": 200,
  "f-410": 410,
  "f-415": 415,
  "f-413": 413,
  "f-401": 401,
  "f-500": 500,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.cb([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  fetchMock = vi.fn(async (url: string) => {
    const id = /\/api\/files\/([^/]+)\/preview$/.exec(url)?.[1] ?? "";
    const status = STATUS_BY_FILE[id] ?? 404;
    return new Response(status === 200 ? "png" : "{}", { status });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Gallery", () => {
  it("shows a tile per entry with an image, each refusal as its named placeholder", async () => {
    const onOpen = vi.fn();
    render(
      <Gallery
        table={table}
        rows={[
          row("r0", "Loaded tile", "f-ok"),
          row("r1", "Gone", "f-410"),
          row("r2", "Wrong kind", "f-415"),
          row("r3", "Huge", "f-413"),
          row("r4", "Signed out", "f-401"),
          row("r5", "Broken", "f-500"),
          row("r6", "No picture", null),
        ]}
        onOpen={onOpen}
      />,
    );
    expect(screen.getAllByTestId("gallery-tile")).toHaveLength(6);
    expect(screen.queryByText("No picture")).toBeNull();
    for (const text of [
      "Removed from Stash",
      "Not an image",
      "Too large to preview",
      "Sign in to Operon to see images",
      "Image unavailable",
    ]) {
      expect(await screen.findByText(text)).toBeTruthy();
    }
    const img = (await screen.findByAltText("Loaded tile")) as HTMLImageElement;
    expect(img.src).toBe("blob:preview");
    expect(document.querySelectorAll("img")).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https?:\/\/[^/]+\/api\/files\/f-ok\/preview$/);
    expect(init.credentials).toBe("include");
    expect(
      screen.getByText("Each tile is the graphic itself, stored in Stash."),
    ).toBeTruthy();
    expect(screen.getAllByText("Cyber · 6 Oct 2026 · Dana")).toHaveLength(6);
    fireEvent.click(screen.getByText("Gone"));
    expect(onOpen).toHaveBeenCalledWith("r1");
  });

  it("keeps at most four previews in flight", async () => {
    const pending: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => pending.push(resolve)),
    );
    render(
      <Gallery
        table={table}
        rows={Array.from({ length: 7 }, (_, i) =>
          row(`r${i}`, `T${i}`, "f-ok"),
        )}
        onOpen={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledTimes(MAX_CONCURRENT_PREVIEWS),
    );
    expect(previewsInFlight()).toBe(MAX_CONCURRENT_PREVIEWS);
    pending.shift()?.(new Response("png", { status: 200 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(previewsInFlight()).toBeLessThanOrEqual(MAX_CONCURRENT_PREVIEWS);
    cleanup();
    for (const resolve of pending) resolve(new Response("{}", { status: 500 }));
  });
});

describe("Stash picker", () => {
  it("keeps folders and image files only", () => {
    const nodes = [
      {
        id: "1",
        parentId: null,
        name: "deck.pdf",
        kind: "file",
        mime: "application/pdf",
      },
      {
        id: "2",
        parentId: null,
        name: "tip.png",
        kind: "file",
        mime: "image/png",
      },
      { id: "3", parentId: null, name: "Graphics", kind: "folder", mime: null },
      { id: "4", parentId: null, name: "notes", kind: "file", mime: null },
    ];
    expect(pickable(nodes).map((n) => n.name)).toEqual(["Graphics", "tip.png"]);
  });

  it("lists Stash with credentials, opens a folder, and chooses an image", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const nodes = url.includes("parentId=folder-1")
        ? [
            {
              id: "img-2",
              parentId: "folder-1",
              name: "inner.jpg",
              kind: "file",
              mime: "image/jpeg",
            },
          ]
        : [
            {
              id: "folder-1",
              parentId: null,
              name: "Graphics",
              kind: "folder",
              mime: null,
            },
            {
              id: "doc-1",
              parentId: null,
              name: "brief.pdf",
              kind: "file",
              mime: "application/pdf",
            },
          ];
      return new Response(JSON.stringify({ nodes }), { status: 200 });
    });
    const onChoose = vi.fn();
    render(
      <StashPickerDialog open={true} onClose={vi.fn()} onChoose={onChoose} />,
    );
    expect(await screen.findByText("Graphics")).toBeTruthy();
    expect(screen.queryByText("brief.pdf")).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/files\/list$/);
    expect(init.credentials).toBe("include");
    fireEvent.click(screen.getByText("Graphics"));
    fireEvent.click(await screen.findByText("inner.jpg"));
    expect(onChoose).toHaveBeenCalledWith("img-2");
  });

  it("reads a pasted Stash link or a bare id", () => {
    const id = "e4caf23d-3d70-4f32-b2d3-9da7322a9959";
    expect(stashFileId(id)).toBe(id);
    expect(stashFileId(`https://operon.example/#/files/${id}`)).toBe(id);
    expect(stashFileId("https://example.com/cat.png")).toBeNull();
  });
});
