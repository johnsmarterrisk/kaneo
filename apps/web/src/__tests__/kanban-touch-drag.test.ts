import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Touch drag on the board (John, real iPhone 2026-09-22: tasks could not be dragged
 * between columns).
 *
 * WHY THIS READS SOURCE RATHER THAN MOUNTING. The fault was not a behaviour a component
 * test can drive: dnd-kit's `TouchSensor` activation depends on the BROWSER deciding, at
 * `touchstart`, whether the gesture belongs to the page or to the element — a decision
 * jsdom does not model at all, having no compositor, no touch-action handling and no
 * gesture arbitration. A mounted test could only assert that a copy of the markup carries
 * a class, which is the weaker claim this repo was already criticised for. The two source
 * facts below ARE the fix, and the drag itself was verified in WebKit with an iPhone 13
 * descriptor against the rebuilt container: the handle measured 44x44 and a 450ms press
 * followed by a 150px move started a drag.
 */

const TASK_CARD = readFileSync(
  join(process.cwd(), "src/components/kanban-board/task-card.tsx"),
  "utf8",
);
const BOARD = readFileSync(
  join(process.cwd(), "src/components/kanban-board/index.tsx"),
  "utf8",
);

describe("the board's touch drag", () => {
  it("puts touch-action: none on the drag handle, unconditionally", () => {
    // THE BUG: the card carried `touchAction: isDragging ? "none" : "auto"`. The browser
    // claims a touch for scrolling at `touchstart`, before dnd-kit's 250ms delay elapses,
    // so at press time this was always "auto" — Safari took the gesture as a column pan
    // and the sensor never activated. The style that would have allowed the drag was only
    // applied once the drag it prevented had already started.
    expect(TASK_CARD).not.toContain(
      'touchAction: isDragging ? "none" : "auto"',
    );
    expect(TASK_CARD).toContain('style={{ touchAction: "none" }}');
  });

  it("keeps the handle a separate, always-rendered 44px target", () => {
    // On the handle ALONE: `touch-action: none` on the whole card would stop the column
    // scrolling at all, since cards fill it.
    expect(TASK_CARD).toMatch(
      /data-testid={`task-drag-handle-\$\{task\.id\}`}/,
    );
    expect(TASK_CARD).toContain("h-11 w-11");
    // Never hover-only — a phone cannot reach a hover-revealed control.
    expect(TASK_CARD).not.toMatch(/group-hover[^"]*task-drag-handle/);
    // And the listeners moved off the card wrapper onto it.
    expect(TASK_CARD).not.toContain(
      "<div ref={setNodeRef} style={style} {...attributes} {...listeners}>",
    );
  });

  it("keeps a long-press TouchSensor alongside mouse and keyboard", () => {
    // The sensor was never missing; it is asserted here so a future tidy does not remove
    // it believing the touch-action fix alone is what does the work.
    expect(BOARD).toContain("useSensor(TouchSensor");
    expect(BOARD).toMatch(/delay: disableDragDrop \? 999999 : 250/);
    expect(BOARD).toMatch(/tolerance: 8/);
    expect(BOARD).toContain("useSensor(MouseSensor");
    expect(BOARD).toContain("useSensor(KeyboardSensor)");
  });
});
