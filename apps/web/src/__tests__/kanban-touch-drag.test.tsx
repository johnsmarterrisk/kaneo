import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { CSSProperties } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectWithTasks } from "@/types/project";

/**
 * Touch drag on the board (John, real iPhone 2026-09-22; Codex r1 #7, r2 #2).
 *
 * These tests mount a card wired exactly as `task-card.tsx` wires one, inside a
 * `DndContext` carrying THE BOARD'S OWN SENSOR CONFIGURATION — the same MouseSensor
 * distance, TouchSensor delay and tolerance, and KeyboardSensor `kanban-board/index.tsx`
 * builds. Default sensors would have proved nothing about the thing that was wrong.
 *
 * The three claims are the whole fix, and each is asserted through `onDragStart`, which is
 * dnd-kit telling us a drag genuinely began rather than a class being present:
 *   1. a touch long-press ON THE GRIP starts a drag;
 *   2. a touch long-press ON THE CARD BODY does NOT — that gesture belongs to the column,
 *      which is why the card body must not carry `onTouchStart`;
 *   3. a mouse drag on the card body still starts a drag, unchanged desktop behaviour.
 */

const TASK_CARD = readFileSync(
  join(process.cwd(), "src/components/kanban-board/task-card.tsx"),
  "utf8",
);
const BOARD = readFileSync(
  join(process.cwd(), "src/components/kanban-board/index.tsx"),
  "utf8",
);

/** The board's real sensors, built the same way `kanban-board/index.tsx` builds them. */
function useBoardSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 10 },
    }),
    useSensor(KeyboardSensor),
  );
}

/** The card's drag wiring, mirroring `task-card.tsx`: everything EXCEPT the touch
    activator on the card, the whole map on the grip. */
function Card({ id, onClick }: { id: string; onClick?: () => void }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const { onTouchStart, ...cardListeners } = (listeners ?? {}) as {
    onTouchStart?: React.TouchEventHandler;
    [key: string]: unknown;
  };
  const style: CSSProperties = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative"
      data-testid={`card-${id}`}
      data-dragging={isDragging ? "true" : "false"}
      {...attributes}
      {...cardListeners}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a real <button> cannot be used — the grip is a nested button, which is invalid HTML, and the grip must stay INSIDE the clickable region because that is where task-card.tsx puts it and what makes its stopPropagation meaningful */}
      <div
        data-testid={`card-body-${id}`}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter") onClick?.();
        }}
      >
        <button
          type="button"
          data-testid={`task-drag-handle-${id}`}
          aria-label={`Drag ${id}`}
          style={{ touchAction: "none" }}
          className="float-right h-11 w-11"
          onClick={(e) => e.stopPropagation()}
          onTouchStart={onTouchStart}
          {...cardListeners}
        >
          grip
        </button>
        <span>{id}</span>
      </div>
    </div>
  );
}

function Board({
  onDragStart,
  onClick,
}: {
  onDragStart: () => void;
  onClick?: () => void;
}) {
  const sensors = useBoardSensors();
  return (
    <DndContext sensors={sensors} onDragStart={onDragStart}>
      <SortableContext items={["t1"]}>
        <Card id="t1" onClick={onClick} />
      </SortableContext>
    </DndContext>
  );
}

/** jsdom has no Touch constructor; dnd-kit reads `touches[0].clientX/clientY`, so a plain
    object with those fields is all the sensor needs. */
function touch(el: Element, type: string, x: number, y: number) {
  fireEvent(
    el,
    Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      touches: [{ clientX: x, clientY: y, identifier: 0, target: el }],
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the board card's drag wiring, under the board's own sensors", () => {
  it("a touch long-press ON THE GRIP starts a drag", () => {
    const onDragStart = vi.fn();
    render(<Board onDragStart={onDragStart} />);

    touch(screen.getByTestId("task-drag-handle-t1"), "touchstart", 50, 50);
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(onDragStart).toHaveBeenCalledTimes(1);
  });

  it("a touch long-press ON THE CARD BODY does not — that gesture is the column's", () => {
    // THE r2 BUG: spreading the whole listener map on the card put `onTouchStart` on the
    // body, so a touch anywhere on a card began a drag and the column could not be panned.
    const onDragStart = vi.fn();
    render(<Board onDragStart={onDragStart} />);

    touch(screen.getByTestId("card-body-t1"), "touchstart", 50, 50);
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(onDragStart).not.toHaveBeenCalled();
  });

  it("a mouse drag on the card body still starts a drag (desktop unchanged)", () => {
    const onDragStart = vi.fn();
    render(<Board onDragStart={onDragStart} />);
    const body = screen.getByTestId("card-body-t1");

    fireEvent.mouseDown(body, { clientX: 0, clientY: 0 });
    // Past the MouseSensor's 8px activation distance.
    fireEvent.mouseMove(document, { clientX: 40, clientY: 0 });
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(onDragStart).toHaveBeenCalledTimes(1);

    // End the gesture INSIDE act and let dnd-kit's teardown run. It installs a
    // capture-phase listener that swallows the click following a drag, and that listener
    // outlives `cleanup()` — leaving it armed made the next test's click on a card body
    // vanish, which looked like a broken handler and was really this.
    act(() => {
      fireEvent.mouseUp(document);
      vi.advanceTimersByTime(300);
    });
  });

  it("puts touch-action: none on the grip alone, so the column still pans", () => {
    render(<Board onDragStart={vi.fn()} />);
    expect(screen.getByTestId("task-drag-handle-t1").style.touchAction).toBe(
      "none",
    );
    expect(screen.getByTestId("card-t1").style.touchAction).toBe("");
  });

  // Two renders, not two clicks in one: a click on the grip leaves dnd-kit mid-gesture,
  // and asserting the body's click afterwards would be measuring that state rather than
  // the handler.
  it("the grip swallows its own click, so dragging never opens the task", () => {
    const onClick = vi.fn();
    render(<Board onDragStart={vi.fn()} onClick={onClick} />);

    fireEvent.click(screen.getByTestId("task-drag-handle-t1"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("a click on the card body still opens the task", () => {
    const onClick = vi.fn();
    render(<Board onDragStart={vi.fn()} onClick={onClick} />);

    fireEvent.click(screen.getByTestId("card-body-t1"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("the shipped card and board keep that contract", () => {
  it("never spreads the touch activator back onto the card", () => {
    // Codex r2 #1: `listeners` is keyed by event name, so spreading it whole put
    // `onTouchStart` on the card body and touch was never confined to the grip.
    expect(TASK_CARD).toContain("const { onTouchStart, ...cardListeners }");
    expect(TASK_CARD).not.toMatch(
      /className="relative"\s+\{\.\.\.attributes\}\s+\{\.\.\.listeners\}/,
    );
  });

  it("never reverts to the conditional touch-action that caused the bug", () => {
    // At press time the old value was always "auto" — the browser claims the gesture at
    // touchstart, before dnd-kit's delay elapses, so the style that would have allowed
    // the drag was only applied once the drag it prevented had started.
    expect(TASK_CARD).not.toContain(
      'touchAction: isDragging ? "none" : "auto"',
    );
    expect(TASK_CARD).toContain('style={{ touchAction: "none" }}');
    expect(TASK_CARD).toContain("h-11 w-11");
  });

  it("keeps mouse, touch and keyboard sensors, with the established touch tolerance", () => {
    expect(BOARD).toContain("useSensor(MouseSensor");
    expect(BOARD).toContain("useSensor(TouchSensor");
    expect(BOARD).toContain("useSensor(KeyboardSensor)");
    expect(BOARD).toMatch(/delay: disableDragDrop \? 999999 : 250/);
    // Codex r1 #16: back to the established value; 8 was unrelated to the fault.
    expect(BOARD).toMatch(/tolerance: 10/);
  });
});

/**
 * The phone board layout (John, real iPhone 2026-09-22: "cards squeezed").
 *
 * Read from source rather than measured: jsdom computes no layout, so a rendered column
 * has no width to assert, and `calc(100% - 2rem)` only becomes a number in a browser.
 * What can regress here is the RULE, and the rule is the fix — one column per screen, the
 * container minus its two 16px gutters, snapping between them, with the desktop board
 * untouched above `md`.
 */
describe("the phone board shows one column at a time", () => {
  it("sizes each column to its container minus its gutters, and snaps between them", () => {
    // Percentage sizing follows the strip even when it is narrower than the viewport.
    expect(BOARD).toContain("max-md:w-[calc(100%-2rem)]");
    expect(BOARD).toContain("max-md:mx-4");
    expect(BOARD).toContain("max-md:scroll-px-4");
    expect(BOARD).toContain("max-md:flex-none");
    expect(BOARD).toContain("max-md:snap-start");
    expect(BOARD).toContain("max-md:snap-x");
    expect(BOARD).toContain("max-md:snap-mandatory");
    // The desktop min/max widths must not apply on a phone, or the column cannot shrink.
    expect(BOARD).toContain("max-md:min-w-0");
    expect(BOARD).toContain("max-md:max-w-none");
  });

  it("keeps the multi-column desktop board unchanged above md", () => {
    expect(BOARD).toContain("max-w-96 min-w-80");
    expect(BOARD).toContain("gap-3 p-3");
  });

  it("gives the strip a tab row so the other columns are discoverable", () => {
    // A snapping strip with nothing above it hides every column but one.
    expect(BOARD).toContain('data-testid="phone-column-tabs"');
    expect(BOARD).toContain("md:hidden");
    expect(BOARD).toContain("min-h-[44px]");
    // Throttled to a frame: a flick must not schedule a React render per scroll event.
    expect(BOARD).toContain("requestAnimationFrame");
    expect(BOARD).toContain("cancelAnimationFrame");
  });
});

// Mount the SHIPPED strip, sensors, and drag lifecycle. Only domain dependencies and
// the column contents are isolated; jsdom geometry is supplied per test.
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/hooks/mutations/task/use-update-task", () => ({
  useUpdateTask: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useRegisterShortcuts: () => {},
}));
vi.mock("@/components/bulk-selection/bulk-toolbar", () => ({
  default: () => null,
}));
vi.mock("@/components/kanban-board/task-card", () => ({ default: () => null }));
vi.mock("@/components/kanban-board/column", () => ({
  default: ({ column }: { column: ProjectWithTasks["columns"][number] }) => (
    <SortableContext items={column.tasks}>
      {column.tasks.map((task) => (
        <Card key={task.id} id={task.id} />
      ))}
    </SortableContext>
  ),
}));
const { default: KanbanBoard } = await import("@/components/kanban-board");

const project = {
  id: "p1",
  workspaceId: "w1",
  name: "Board",
  columns: [
    { id: "a", slug: "a", name: "First", tasks: [{ id: "t1" }] },
    { id: "b", slug: "b", name: "Second", tasks: [] },
    { id: "c", slug: "c", name: "Third", tasks: [] },
  ],
} as ProjectWithTasks;

function stripGeometry(container: HTMLElement, lefts: number[]) {
  const columns = Array.from(
    container.querySelectorAll<HTMLElement>("[data-column-id]"),
  );
  const strip = columns[0].parentElement?.parentElement as HTMLElement;
  Object.defineProperty(strip, "clientWidth", {
    configurable: true,
    value: 300,
  });
  vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
    left: 70,
    width: 300,
  } as DOMRect);
  columns.forEach((column, index) => {
    vi.spyOn(column, "getBoundingClientRect").mockReturnValue({
      left: lefts[index],
      width: 268,
    } as DOMRect);
  });
  return strip;
}

describe("the real board strip", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const observers: {
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  function flushFrame() {
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  }
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    frames.clear();
    observers.length = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => frames.delete(id)),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        constructor() {
          observers.push(this);
        }
      },
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
  });

  it("coalesces scrolls, uses container coordinates, and selects a neighbour in a gutter", () => {
    const { container } = render(<KanbanBoard project={project} />);
    const strip = stripGeometry(container, [-214, 86, 386]);
    fireEvent.scroll(strip);
    fireEvent.scroll(strip);
    expect(frames.size).toBe(1);
    expect(screen.getByTestId("phone-column-tab-b")).not.toHaveAttribute(
      "aria-current",
    );
    flushFrame();
    expect(screen.getByTestId("phone-column-tab-b")).toHaveAttribute(
      "aria-current",
      "true",
    );
    // Centre at 220 lies between columns a (ends at 210) and b (starts at 242).
    stripGeometry(container, [-58, 242, 542]);
    fireEvent.scroll(strip);
    flushFrame();
    expect(screen.getByTestId("phone-column-tab-a")).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("reconciles a removed column without needing a scroll event", () => {
    const view = render(<KanbanBoard project={project} />);
    stripGeometry(view.container, [-214, 86, 386]);
    flushFrame();
    expect(screen.getByTestId("phone-column-tab-b")).toHaveAttribute(
      "aria-current",
      "true",
    );
    view.rerender(
      <KanbanBoard
        project={{
          ...project,
          columns: [project.columns[0], project.columns[2]],
        }}
      />,
    );
    stripGeometry(view.container, [86, 386]);
    flushFrame();
    expect(screen.getByTestId("phone-column-tab-a")).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("scrolls only the chosen column and respects reduced motion", () => {
    const { container } = render(<KanbanBoard project={project} />);
    const column = container.querySelector(
      '[data-column-id="c"]',
    ) as HTMLElement;
    const scrollIntoView = vi.fn();
    column.scrollIntoView = scrollIntoView;
    fireEvent.click(screen.getByTestId("phone-column-tab-c"));
    expect(scrollIntoView).toHaveBeenLastCalledWith({
      behavior: "smooth",
      inline: "start",
      block: "nearest",
    });
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
    } as MediaQueryList);
    fireEvent.click(screen.getByTestId("phone-column-tab-c"));
    expect(scrollIntoView).toHaveBeenLastCalledWith({
      behavior: "auto",
      inline: "start",
      block: "nearest",
    });
  });

  it("cancels queued work and disconnects the observer on unmount", () => {
    const view = render(<KanbanBoard project={project} />);
    const strip = stripGeometry(view.container, [86, 386, 686]);
    flushFrame();
    fireEvent.scroll(strip);
    expect(frames.size).toBe(1);
    view.unmount();
    expect(frames.size).toBe(0);
    const observer = observers.find((item) =>
      item.observe.mock.calls.some(([target]) => target === strip),
    );
    expect(observer?.disconnect).toHaveBeenCalledOnce();
  });

  it("does not measure or schedule scroll updates on desktop", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    const { container } = render(<KanbanBoard project={project} />);
    const strip = stripGeometry(container, [86, 386, 686]);
    fireEvent.scroll(strip);
    expect(frames.size).toBe(0);
  });

  it("disables snap while a grip drag is active, and restores it on cancellation", () => {
    const { container } = render(<KanbanBoard project={project} />);
    const strip = stripGeometry(container, [86, 386, 686]);
    touch(screen.getByTestId("task-drag-handle-t1"), "touchstart", 50, 50);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByTestId("card-t1")).toHaveAttribute(
      "data-dragging",
      "true",
    );
    expect(strip.className).toContain("max-md:snap-none");
    act(() => {
      fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
      vi.advanceTimersByTime(300);
    });
    expect(strip.className).toContain("max-md:snap-mandatory");
    expect(screen.getByTestId("card-t1")).toHaveAttribute(
      "data-dragging",
      "false",
    );
  });
});
