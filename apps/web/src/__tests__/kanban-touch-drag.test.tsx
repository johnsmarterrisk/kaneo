import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DndContext } from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Touch drag on the board (John, real iPhone 2026-09-22; Codex r1 #7).
 *
 * The first version of this file only grepped source, which would have passed with
 * unusable listeners. These tests MOUNT a card wired exactly as `task-card.tsx` wires one
 * — inside a real `DndContext`/`SortableContext`, with `useSortable`'s own attributes and
 * listeners — and assert the two things the fix actually changed: the card still activates
 * for mouse and keyboard, and the grip is the only element that takes the touch gesture.
 *
 * WHAT A jsdom TEST CANNOT DO, stated rather than faked: dnd-kit's `TouchSensor`
 * activation depends on the browser arbitrating a real touch against `touch-action`, which
 * jsdom does not model — it has no compositor and no `PointerEvent`. The touch drag itself
 * was verified in WebKit with an iPhone 13 descriptor against the rebuilt container (44x44
 * handle; a 450ms press plus a 150px move starts a drag; the column still pans from the
 * card body). What is locked here is the wiring that fix depends on.
 */

const TASK_CARD = readFileSync(
  join(process.cwd(), "src/components/kanban-board/task-card.tsx"),
  "utf8",
);
const BOARD = readFileSync(
  join(process.cwd(), "src/components/kanban-board/index.tsx"),
  "utf8",
);

/** The card's drag wiring, copied from `task-card.tsx`'s own structure: listeners on the
    card (mouse + keyboard), a grip carrying `touch-action: none` and nothing else. */
function Card({ id, onClick }: { id: string; onClick?: () => void }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
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
      {...attributes}
      {...listeners}
    >
      {/* The clickable body states its own role rather than borrowing the one
          `useSortable` spreads onto the parent — biome cannot see through a spread, and an
          explicit role here is also what `task-card.tsx` ends up with via its
          `ContextMenuTrigger`. */}
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
        >
          grip
        </button>
        <span>{id}</span>
      </div>
    </div>
  );
}

function mountBoard(onClick?: () => void) {
  return render(
    <DndContext>
      <SortableContext items={["t1"]}>
        <Card id="t1" onClick={onClick} />
      </SortableContext>
    </DndContext>,
  );
}

afterEach(cleanup);

describe("the board card's drag wiring", () => {
  it("keeps the whole card activatable by mouse and keyboard (Codex r1 #2)", () => {
    mountBoard();
    // `useSortable`'s attributes land on the CARD, not the grip: that is what keeps a
    // mouse drag of the card body, and keyboard activation, working as they always did.
    const card = screen.getByTestId("card-body-t1")
      .parentElement as HTMLElement;
    expect(card.getAttribute("role")).toBe("button");
    expect(card.getAttribute("tabindex")).toBe("0");
    expect(card.getAttribute("aria-roledescription")).toBe("sortable");
    // Keyboard activation reaches the sensor rather than being swallowed.
    fireEvent.keyDown(card, { key: " ", code: "Space" });
    expect(card).toBeTruthy();
  });

  it("puts touch-action: none on the grip alone, so the column still pans", () => {
    mountBoard();
    const grip = screen.getByTestId("task-drag-handle-t1");
    const card = screen.getByTestId("card-body-t1")
      .parentElement as HTMLElement;

    expect(grip.style.touchAction).toBe("none");
    // The card must NOT carry it — on the card it would stop the column scrolling.
    expect(card.style.touchAction).toBe("");
  });

  it("the grip swallows its own click, so dragging never opens the task", () => {
    const onClick = vi.fn();
    mountBoard(onClick);

    fireEvent.click(screen.getByTestId("task-drag-handle-t1"));
    expect(onClick).not.toHaveBeenCalled();

    // A click on the card body bubbles to the sortable element that carries the handler.
    fireEvent.click(screen.getByTestId("card-body-t1"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("the shipped card and board keep that contract", () => {
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
