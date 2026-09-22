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
  vi.useRealTimers();
  cleanup();
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
