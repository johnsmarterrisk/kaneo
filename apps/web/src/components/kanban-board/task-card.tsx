import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useNavigate } from "@tanstack/react-router";
import { format } from "date-fns";
import {
  Calendar,
  CalendarClock,
  CalendarX,
  GitMerge,
  GitPullRequest,
  GripVertical,
  SquareCheck,
} from "lucide-react";
import { type CSSProperties, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/preview-card";
import { useDeleteTask } from "@/hooks/mutations/task/use-delete-task";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";
import { useGetActiveWorkspaceUsers } from "@/hooks/queries/workspace-users/use-get-active-workspace-users";
import { cn } from "@/lib/cn";
import {
  dueDateStatusColors,
  getDueDateStatus,
  isTaskCompleted,
} from "@/lib/due-date-status";
import { getInitials } from "@/lib/get-initials";
import { getTaskItemStats } from "@/lib/get-task-item-stats";
import { getPriorityIcon } from "@/lib/priority";
import { toast } from "@/lib/toast";
import useBulkSelectionStore from "@/store/bulk-selection";
import useProjectStore from "@/store/project";
import { useUserPreferencesStore } from "@/store/user-preferences";
import type Task from "@/types/task";
import TaskCardContextMenuContent from "./task-card-context-menu/task-card-context-menu-content";
import { TaskLabels } from "./task-labels";

type TaskCardProps = {
  task: Task;
  disableDragDrop?: boolean;
};

function TaskCard({ task, disableDragDrop = false }: TaskCardProps) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled: disableDragDrop });

  /* `listeners` is dnd-kit's activator map, keyed by event name (`onMouseDown`,
     `onTouchStart`, `onKeyDown` — one per sensor configured in `kanban-board/index.tsx`).
     The card takes everything EXCEPT the touch activator; the grip below takes the whole
     map, so it can be dragged by mouse as well as by touch. */
  const { onTouchStart, ...cardListeners } = (listeners ?? {}) as {
    onTouchStart?: React.TouchEventHandler;
    [key: string]: unknown;
  };
  const { project } = useProjectStore();
  const taskIsCompleted = isTaskCompleted(task.status, project?.columns);
  const { data: workspace } = useActiveWorkspace();
  const { mutateAsync: deleteTask } = useDeleteTask();
  const navigate = useNavigate();
  const {
    showAssignees,
    showPriority,
    showDueDates,
    showLabels,
    showTaskNumbers,
    showTaskItemCounts,
  } = useUserPreferencesStore();
  const [isDeleteTaskModalOpen, setIsDeleteTaskModalOpen] = useState(false);
  const { toggleSelection, isSelected, isFocused } = useBulkSelectionStore();
  const isTaskSelected = isSelected(task.id);
  const isTaskFocused = isFocused(task.id);
  const taskItemStats = useMemo(
    () => getTaskItemStats(task.description),
    [task.description],
  );

  const pullRequests = useMemo(() => {
    return (task.externalLinks ?? []).filter(
      (link) => link.resourceType === "pull_request",
    );
  }, [task.externalLinks]);

  const getPRInfo = (pr: (typeof pullRequests)[number]) => {
    const isMerged = pr.metadata?.merged === true;
    const isDraft = pr.metadata?.draft === true;

    if (isMerged) {
      return {
        icon: <GitMerge className="h-3 w-3 text-info-foreground" />,
        status: t("tasks:pr.merged"),
        statusClass: "text-info-foreground",
      };
    }

    if (isDraft) {
      return {
        icon: <GitPullRequest className="h-3 w-3 text-muted-foreground" />,
        status: t("tasks:pr.draft"),
        statusClass: "text-muted-foreground",
      };
    }

    return {
      icon: <GitPullRequest className="h-3 w-3 text-success-foreground" />,
      status: t("tasks:pr.open"),
      statusClass: "text-success-foreground",
    };
  };

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition:
      transition || "transform 250ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
    opacity: isDragging ? 0.6 : 1,
    // `touchAction` deliberately NOT set here any more. It used to be
    // `isDragging ? "none" : "auto"`, which is the bug John hit: the browser decides
    // whether to claim a touch for scrolling at `touchstart`, BEFORE dnd-kit's 250ms
    // long-press delay elapses — so at press time this was always `auto`, Safari took the
    // gesture as a column pan, and the TouchSensor never activated. The style that would
    // have allowed the drag was only applied once the drag it prevented had started.
    // `touch-action: none` now lives on the drag HANDLE alone (below), so the rest of the
    // card still pans the column, which is what a reader needs far more often.
    zIndex: isDragging ? 999 : "auto",
  };

  const { data: workspaceUsers } = useGetActiveWorkspaceUsers(
    workspace?.id ?? "",
  );

  const assignee = useMemo(() => {
    return workspaceUsers?.members?.find(
      (member) => member.userId === task.userId,
    );
  }, [workspaceUsers, task.userId]);

  function handleTaskCardClick(
    e: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>,
  ) {
    if (!project || !task || !workspace) return;

    if ((e as React.MouseEvent).metaKey || (e as React.KeyboardEvent).ctrlKey) {
      toggleSelection(task.id);
      return;
    }

    const currentParams = new URLSearchParams(window.location.search);
    const currentTaskId = currentParams.get("taskId");

    if (currentTaskId === task.id) {
      navigate({
        to: ".",
        search: {},
      });
    } else {
      navigate({
        to: ".",
        search: { taskId: task.id },
      });
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      toggleSelection(task.id);
    }
  };

  const handleDeleteTask = async () => {
    try {
      await deleteTask(task.id);
      toast.success(t("tasks:delete.success"));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("tasks:delete.error"),
      );
    }
  };

  return (
    // Codex r2 #1: the listeners are SPLIT, not spread whole.
    //
    // dnd-kit keys its activator map by event name — `onMouseDown`, `onTouchStart`,
    // `onKeyDown`, one per configured sensor — so spreading `listeners` on the card put
    // `onTouchStart` on the whole body and touch was never actually confined to the grip,
    // whatever the previous round's comment claimed. Pulling `onTouchStart` out is the
    // whole fix: the card keeps mouse and keyboard activation (dragging a card by its body
    // is desktop behaviour this round must not change), and the grip is the only element
    // that can begin a TOUCH drag — which is what leaves the card body free to pan the
    // column, since cards fill it.
    <div
      ref={setNodeRef}
      style={style}
      // `max-md:!block` (John, real iPhone 2026-09-23 — "Test" wrapping as "Te / st", the
      // TP-1/priority chips stacking). dnd-kit's `attributes` puts `role="button"` on THIS
      // div, and `index.css`'s own touch-target rule (`[role="button"]:not([data-touch-
      // compact]) { display: inline-flex; align-items: center; justify-content: center }`)
      // therefore applies to it at every width. An inline-flex box with `justify-content:
      // center` shrink-wraps to its single flex child's CONTENT width and centers that
      // child inside itself — on a 334px-wide column that measured 133px, the exact
      // ~40% figure a wrapped two-letter title implies. `!block` (important, so it
      // outranks the plain-specificity attribute-selector rule) restores the plain block
      // box this div was always meant to be below `768px`; a block box's width is "auto",
      // i.e. 100% of its containing block, with no flex shrink-to-fit involved. Scoped to
      // `max-md:` ONLY, per the ticket's own instruction ("desktop unchanged") — the same
      // rule measurably narrows the card at `md` and up too, but that is a pre-existing,
      // unreported desktop behaviour outside this fix's scope; task 0.2's own fix
      // (da870ce) for the desktop COLUMN-width regression is a different bug and is
      // untouched by this change either way.
      className="relative max-md:!block"
      {...attributes}
      {...cardListeners}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/** biome-ignore lint/a11y/noStaticElementInteractions: false positive for onClick and onKeyDown */}
          <div
            onClick={handleTaskCardClick}
            className={`group relative rounded-[14px] border bg-secondary text-card-foreground p-4 shadow-xs/5 transition-[background-color,border-color,box-shadow,scale] duration-150 ease-out active:scale-[0.98] ${
              disableDragDrop ? "cursor-default" : "cursor-move"
            } ${
              isDragging
                ? "border-ring/40 bg-card shadow-lg"
                : "hover:border-border/90 hover:bg-accent hover:shadow-sm"
            } ${
              isTaskSelected
                ? "border-ring/40 bg-accent/50 shadow-sm ring-1 ring-inset ring-ring/30"
                : "border-border"
            } ${isTaskFocused ? "ring-2 ring-inset ring-ring/50" : ""}`}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleTaskCardClick(e);
              } else if (e.key === "Escape") {
                handleKeyDown(e);
              }
            }}
          >
            {/* DRAG HANDLE (John, real iPhone 2026-09-22: tasks could not be dragged
                between columns on touch). The sensors were never the problem — a
                `TouchSensor` with a 250ms long press has been configured all along — the
                problem was that nothing carried `touch-action: none` at press time, so
                Safari claimed the gesture as a column pan before the delay elapsed.
                `touch-action: none` belongs on the handle ALONE: putting it on the whole
                card would stop the column scrolling at all, since cards fill it. The
                handle is always rendered (never hover-only, which a phone cannot reach)
                and is a 44px target. */}
            {!disableDragDrop && (
              <button
                type="button"
                data-testid={`task-drag-handle-${task.id}`}
                aria-label={`Drag ${task.title}`}
                // The ONLY element with `touch-action: none`. On the card it would stop
                // the column scrolling, since cards fill it; here the rest of the card
                // still pans and only this 44px square is reserved for the drag.
                style={{ touchAction: "none" }}
                // Codex r1 #14: `float-right` with a margin rather than `absolute`, so the
                // title wraps around the grip instead of running underneath it.
                className="float-right -mt-1 -mr-1 ml-1 flex h-11 w-11 cursor-grab items-center justify-center rounded-md text-muted-foreground hover:bg-accent active:cursor-grabbing"
                onClick={(e) => e.stopPropagation()}
                onTouchStart={onTouchStart}
                {...cardListeners}
              >
                <GripVertical className="h-4 w-4" />
              </button>
            )}
            <div className="mb-2.5">
              <div
                className="overflow-hidden break-words leading-5 font-medium text-card-foreground text-[15px]"
                style={{
                  display: "-webkit-box",
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: "vertical",
                  wordBreak: "break-word",
                  hyphens: "auto",
                }}
              >
                {task.title}
              </div>
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-2">
              {showLabels && <TaskLabels labels={task.labels ?? []} />}
              {showTaskNumbers && (
                <div className="text-xs font-mono text-ink-secondary">
                  {project?.slug}-{task.number}
                </div>
              )}

              {showAssignees && (
                <div className="ml-auto">
                  {task.userId ? (
                    <Avatar className="h-6 w-6">
                      <AvatarImage
                        src={assignee?.user?.image ?? ""}
                        alt={assignee?.user?.name || ""}
                      />
                      <AvatarFallback className="text-xs font-medium border border-border/30">
                        {getInitials(assignee?.user?.name)}
                      </AvatarFallback>
                    </Avatar>
                  ) : (
                    <div
                      className="flex h-6 w-6 items-center justify-center rounded-full border border-border bg-muted"
                      title={t("tasks:assignee.unassigned")}
                    >
                      <span className="text-[10px] font-medium text-muted-foreground">
                        ?
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              {showPriority && (
                <span className="inline-flex items-center gap-1 rounded border border-border/70 bg-muted/55 px-2 py-1 text-[10px] font-medium text-muted-foreground h-5.5">
                  {getPriorityIcon(task.priority ?? "")}
                </span>
              )}

              {showTaskItemCounts && taskItemStats.total > 0 && (
                <span
                  className={cn(
                    "flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-muted/50 text-muted-foreground h-5.5",
                    {
                      "bg-success/10 text-success-foreground":
                        taskItemStats.completed === taskItemStats.total,
                    },
                  )}
                >
                  <SquareCheck className="h-[12px] w-[12px]" />
                  {taskItemStats.completed}/{taskItemStats.total}
                </span>
              )}

              {showDueDates && task.dueDate && (
                <div
                  className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded h-5.5 ${dueDateStatusColors[getDueDateStatus(task.dueDate, taskIsCompleted)]}`}
                >
                  {getDueDateStatus(task.dueDate, taskIsCompleted) ===
                    "overdue" && <CalendarX className="w-3 h-3" />}
                  {getDueDateStatus(task.dueDate, taskIsCompleted) ===
                    "due-soon" && <CalendarClock className="w-3 h-3" />}
                  {(getDueDateStatus(task.dueDate, taskIsCompleted) ===
                    "far-future" ||
                    getDueDateStatus(task.dueDate, taskIsCompleted) ===
                      "no-due-date") && <Calendar className="w-3 h-3" />}
                  <span>{format(new Date(task.dueDate), "MMM d")}</span>
                </div>
              )}

              {pullRequests.length === 1 && (
                <HoverCard openDelay={200} closeDelay={100}>
                  <HoverCardTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        window.open(pullRequests[0].url, "_blank");
                      }}
                      className="inline-flex items-center gap-1.5 rounded border border-border/70 bg-muted/55 px-2 py-1 text-[10px] font-medium text-muted-foreground"
                    >
                      {getPRInfo(pullRequests[0]).icon}
                      <span>#{pullRequests[0].externalId}</span>
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent
                    className="w-72 p-3"
                    side="bottom"
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {getPRInfo(pullRequests[0]).icon}
                        <span>{getPRInfo(pullRequests[0]).status}</span>
                        <span className="text-muted-foreground/50">•</span>
                        <span>#{pullRequests[0].externalId}</span>
                      </div>
                      <p className="text-sm font-medium leading-snug">
                        {pullRequests[0].title || t("tasks:pr.label")}
                      </p>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              )}

              {pullRequests.length > 1 &&
                (() => {
                  const hasOpen = pullRequests.some(
                    (pr) => !pr.metadata?.merged && !pr.metadata?.draft,
                  );
                  const allMerged = pullRequests.every(
                    (pr) => pr.metadata?.merged,
                  );
                  const iconColor = allMerged
                    ? "text-info-foreground"
                    : hasOpen
                      ? "text-success-foreground"
                      : "text-muted-foreground";

                  return (
                    <HoverCard openDelay={200} closeDelay={100}>
                      <HoverCardTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1.5 rounded border border-border/70 bg-muted/55 px-2 py-1 text-[10px] font-medium text-muted-foreground"
                        >
                          <GitPullRequest className={`h-3 w-3 ${iconColor}`} />
                          <span>
                            {t("tasks:pr.count", {
                              count: pullRequests.length,
                            })}
                          </span>
                        </button>
                      </HoverCardTrigger>
                      <HoverCardContent
                        className="w-auto min-w-56 max-w-96 p-1"
                        side="bottom"
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        {pullRequests.map((pr, index) => {
                          const prInfo = getPRInfo(pr);
                          const repoMatch = pr.url.match(
                            /github\.com\/([^/]+\/[^/]+)\/pull/,
                          );
                          const repoName = repoMatch ? repoMatch[1] : null;
                          return (
                            <div key={pr.id}>
                              {index > 0 && (
                                <hr className="border-border my-1" />
                              )}
                              <button
                                type="button"
                                onClick={() => window.open(pr.url, "_blank")}
                                className="w-full px-2 py-1.5 text-left hover:bg-muted/50 rounded transition-colors"
                              >
                                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                  {prInfo.icon}
                                  <span>
                                    {repoName}#{pr.externalId}
                                  </span>
                                </div>
                                <p className="text-xs leading-tight line-clamp-2 mt-0.5">
                                  {pr.title || t("tasks:pr.label")}
                                </p>
                                <span className="text-[10px] text-muted-foreground">
                                  {prInfo.status}
                                </span>
                              </button>
                            </div>
                          );
                        })}
                      </HoverCardContent>
                    </HoverCard>
                  );
                })()}
            </div>
          </div>
        </ContextMenuTrigger>

        {project && workspace && (
          <TaskCardContextMenuContent
            task={task}
            taskCardContext={{
              projectId: project.id,
              worskpaceId: workspace.id,
            }}
            onDeleteClick={() => setIsDeleteTaskModalOpen(true)}
          />
        )}
      </ContextMenu>

      <AlertDialog
        open={isDeleteTaskModalOpen}
        onOpenChange={setIsDeleteTaskModalOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("tasks:delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("tasks:delete.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              {t("common:actions.cancel")}
            </AlertDialogClose>
            <AlertDialogClose
              render={
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDeleteTask}
                />
              }
            >
              {t("tasks:delete.action")}
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default TaskCard;
