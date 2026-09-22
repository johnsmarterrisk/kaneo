import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  type DropAnimation,
  defaultDropAnimationSideEffects,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { produce } from "immer";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUpdateTask } from "@/hooks/mutations/task/use-update-task";
import { useRegisterShortcuts } from "@/hooks/use-keyboard-shortcuts";
import useBulkSelectionStore from "@/store/bulk-selection";
import useProjectStore from "@/store/project";
import type { ProjectWithTasks } from "@/types/project";
import BulkToolbar from "../bulk-selection/bulk-toolbar";
import Column from "./column";
import TaskCard from "./task-card";

type KanbanBoardProps = {
  project: ProjectWithTasks;
  disableDragDrop?: boolean;
};

/**
 * The phone column indicator (John, real iPhone 2026-09-22). A snapping strip with nothing
 * above it is a board whose other columns are invisible and undiscoverable; these tabs name
 * every column, mark the one on screen and move to any of them on a tap. Phone only — the
 * `md` board shows every column at once and needs no index.
 */
function PhoneColumnTabs({
  columns,
  activeId,
  onSelect,
}: {
  columns: { id: string; name: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  if (columns.length === 0) return null;
  return (
    <div
      data-testid="phone-column-tabs"
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1 md:hidden"
    >
      {columns.map((column) => (
        <button
          key={column.id}
          type="button"
          data-testid={`phone-column-tab-${column.id}`}
          aria-current={column.id === activeId ? "true" : undefined}
          onClick={() => onSelect(column.id)}
          className={`min-h-[44px] shrink-0 rounded-md px-3 text-sm whitespace-nowrap ${
            column.id === activeId
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground"
          }`}
        >
          {column.name}
        </button>
      ))}
    </div>
  );
}

function KanbanBoard({ project, disableDragDrop = false }: KanbanBoardProps) {
  const queryClient = useQueryClient();
  const { setProject } = useProjectStore();
  const {
    setAvailableTasks,
    focusNext,
    focusPrevious,
    focusedTaskId,
    clearFocus,
  } = useBulkSelectionStore();
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const { mutate: updateTask } = useUpdateTask();
  const navigate = useNavigate();

  useEffect(() => {
    if (project?.columns) {
      const allTaskIds = project.columns.flatMap((column) =>
        column.tasks.map((task) => task.id),
      );
      setAvailableTasks(allTaskIds);
    }
  }, [project, setAvailableTasks]);

  useEffect(() => {
    clearFocus();
  }, [clearFocus]);

  useRegisterShortcuts({
    shortcuts: {
      j: () => {
        focusNext();
        const state = useBulkSelectionStore.getState();
        if (state.focusedTaskId) {
          navigate({ to: ".", search: { taskId: state.focusedTaskId } });
        }
      },
      k: () => {
        focusPrevious();
        const state = useBulkSelectionStore.getState();
        if (state.focusedTaskId) {
          navigate({ to: ".", search: { taskId: state.focusedTaskId } });
        }
      },
      Enter: () => {
        if (focusedTaskId && project) {
          navigate({
            to: "/dashboard/workspace/$workspaceId/project/$projectId/task/$taskId",
            params: {
              workspaceId: project.workspaceId,
              projectId: project.id,
              taskId: focusedTaskId,
            },
          });
        }
      },
    },
  });

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: disableDragDrop ? 999999 : 8 },
    }),
    // The long press that starts a touch drag. The sensor has always been here; what was
    // missing until 2026-09-22 was `touch-action: none` on the drag handle, without which
    // Safari claimed the gesture before this delay could elapse (see `task-card.tsx`).
    // Tolerance stays at the established 10px (Codex r1 #16): tightening it was unrelated
    // to the `touch-action` fault and only makes jitter cancel more drags.
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: disableDragDrop ? 999999 : 250,
        tolerance: 10,
      },
    }),
    useSensor(KeyboardSensor),
  );

  // Measure in viewport coordinates: offsetLeft may belong to an ancestor outside
  // the strip. Pick the nearest centre even while the midpoint crosses a gutter.
  const stripRef = useRef<HTMLDivElement>(null);
  const [visibleColumnId, setVisibleColumnId] = useState<string | null>(null);
  const scrollTick = useRef<number | null>(null);

  const scrollToColumn = useCallback((id: string) => {
    const column = Array.from(
      stripRef.current?.querySelectorAll<HTMLElement>("[data-column-id]") ?? [],
    ).find((element) => element.dataset.columnId === id);
    column?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      inline: "start",
      block: "nearest",
    });
  }, []);

  const onStripScroll = useCallback(() => {
    if (window.innerWidth >= 768 || scrollTick.current !== null) return;
    scrollTick.current = requestAnimationFrame(() => {
      scrollTick.current = null;
      const strip = stripRef.current;
      if (!strip) return;
      const bounds = strip.getBoundingClientRect();
      const mid = bounds.left + strip.clientWidth / 2;
      let nearest: string | null = null;
      let distance = Number.POSITIVE_INFINITY;
      for (const el of strip.querySelectorAll<HTMLElement>(
        "[data-column-id]",
      )) {
        const rect = el.getBoundingClientRect();
        const delta = Math.abs(rect.left + rect.width / 2 - mid);
        if (delta < distance) {
          nearest = el.dataset.columnId ?? null;
          distance = delta;
        }
      }
      setVisibleColumnId((prev) => (prev === nearest ? prev : nearest));
    });
  }, []);

  useEffect(() => {
    // Columns can be removed/reordered by another client without a scroll event.
    if (!project.columns) return;
    onStripScroll();
  }, [project.columns, onStripScroll]);

  const hasColumns = project.columns !== undefined;
  useEffect(() => {
    if (!hasColumns) return;
    const strip = stripRef.current;
    const observer = new ResizeObserver(onStripScroll);
    if (strip) observer.observe(strip);
    window.addEventListener("resize", onStripScroll);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onStripScroll);
      if (scrollTick.current !== null) cancelAnimationFrame(scrollTick.current);
      scrollTick.current = null;
    };
  }, [onStripScroll, hasColumns]);

  const dropAnimation: DropAnimation = {
    sideEffects: defaultDropAnimationSideEffects({
      styles: {
        active: {
          opacity: "0.8",
        },
      },
    }),
    duration: 300,
    easing: "cubic-bezier(0.23, 1, 0.32, 1)",
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (!over || !project?.columns) return;

    const activeId = active.id.toString();
    const overId = over.id.toString();

    const updatedProject = produce(project, (draft) => {
      const sourceColumn = draft?.columns?.find((col) =>
        col.tasks.some((task) => task.id === activeId),
      );
      const destinationColumn = draft?.columns?.find(
        (col) =>
          col.id === overId || col.tasks.some((task) => task.id === overId),
      );

      if (!sourceColumn || !destinationColumn) return;

      const sourceTaskIndex = sourceColumn.tasks.findIndex(
        (task) => task.id === activeId,
      );
      const task = sourceColumn.tasks[sourceTaskIndex];

      sourceColumn.tasks = sourceColumn.tasks.filter((t) => t.id !== activeId);

      if (sourceColumn.id === destinationColumn.id) {
        let destinationIndex = destinationColumn.tasks.findIndex(
          (t) => t.id === overId,
        );
        if (sourceTaskIndex <= destinationIndex) {
          destinationIndex += 1;
        }
        destinationColumn.tasks.splice(destinationIndex, 0, task);

        destinationColumn.tasks.forEach((t, index) => {
          updateTask({ ...t, position: index });
        });

        queryClient.invalidateQueries({
          queryKey: ["projects", project.workspaceId],
        });
      } else {
        // A task's status is a column slug. The column id is only the
        // droppable identity here, and the two are interchangeable only
        // because the tasks endpoint happens to return `id: column.slug`.
        task.status = destinationColumn.slug;
        const destinationIndex =
          overId === destinationColumn.id
            ? destinationColumn.tasks.length
            : destinationColumn.tasks.findIndex((t) => t.id === overId) + 1;

        destinationColumn.tasks.splice(destinationIndex, 0, task);

        destinationColumn.tasks.forEach((t, index) => {
          updateTask({ ...t, status: destinationColumn.slug, position: index });
        });

        sourceColumn.tasks.forEach((t, index) => {
          updateTask({ ...t, position: index });
        });
      }
    });

    setProject(updatedProject);
    setActiveId(null);
  };

  if (!project?.columns) {
    return (
      <div className="flex h-full w-full flex-col bg-background">
        <header className="mb-6 mt-6 space-y-6 shrink-0 px-6">
          <div className="flex items-center justify-between">
            <div className="w-48 h-8 bg-muted/50 rounded-md animate-pulse" />
          </div>
        </header>

        <div className="relative min-h-0 flex-1">
          <div className="flex h-full flex-1 gap-3 overflow-x-auto p-3">
            {[...Array(4)].map((_, i) => (
              <div
                key={`kanban-column-skeleton-${
                  // biome-ignore lint/suspicious/noArrayIndexKey: It's a skeleton
                  i
                }`}
                className="h-full min-w-80 w-full flex-1 rounded-xl border border-border/70 bg-card"
              >
                <div className="px-4 py-3 flex items-center justify-between">
                  <div className="w-24 h-5 bg-muted/50 rounded animate-pulse" />
                  <div className="w-8 h-5 bg-muted/50 rounded animate-pulse" />
                </div>

                <div className="px-2 pb-4 flex flex-col gap-3 flex-1">
                  {[...Array(3)].map((_, j) => (
                    <div
                      key={`kanban-task-skeleton-${
                        // biome-ignore lint/suspicious/noArrayIndexKey: It's a skeleton
                        j
                      }`}
                      className="p-4 bg-card rounded-lg border border-border/50 animate-pulse"
                    >
                      <div className="space-y-3">
                        <div className="w-2/3 h-4 bg-muted/70 rounded" />
                        <div className="w-1/2 h-3 bg-muted/70 rounded" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const activeTask = activeId
    ? project.columns
        .flatMap((col) => col.tasks)
        .find((task) => task.id === activeId)
    : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="flex h-full w-full flex-col bg-background">
        {/* PHONE: one column at a time (John, real iPhone 2026-09-22 — "cards squeezed").
            A 320px min-width column inside a 375px screen left the cards cramped and the
            next column half-visible, so nothing was comfortable to read or to drop onto.
            Below `md` each column is exactly the strip width minus the 16px gutters either
            side and the strip snaps between them; `md` and up is unchanged. The tabs are
            how a reader moves between columns without having to discover the swipe. */}
        <PhoneColumnTabs
          columns={project.columns ?? []}
          activeId={visibleColumnId}
          onSelect={scrollToColumn}
        />
        <div
          ref={stripRef}
          onScroll={onStripScroll}
          className={`min-h-0 flex-1 overflow-x-auto [-webkit-overflow-scrolling:touch] max-md:scroll-px-4 ${activeId ? "max-md:snap-none" : "max-md:snap-x max-md:snap-mandatory"}`}
        >
          <div className="flex h-full min-w-max gap-3 p-3 max-md:min-w-0 max-md:w-full max-md:gap-0 max-md:p-0">
            {project.columns?.map((column) => (
              <div
                key={column.id}
                data-column-id={column.id}
                className="h-full max-w-96 min-w-80 shrink-0 flex-1 max-md:mx-4 max-md:w-[calc(100%-2rem)] max-md:flex-none max-md:max-w-none max-md:min-w-0 max-md:snap-start"
              >
                <Column column={column} disableDragDrop={disableDragDrop} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <DragOverlay dropAnimation={dropAnimation}>
        {activeTask ? (
          <div className="transform rotate-1 scale-[1.03] shadow-lg">
            <div className="ring-2 ring-ring/35 rounded-lg">
              <TaskCard task={activeTask} />
            </div>
          </div>
        ) : null}
      </DragOverlay>

      <BulkToolbar />
    </DndContext>
  );
}

export default KanbanBoard;
