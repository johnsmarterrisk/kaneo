import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, CalendarClock } from "lucide-react";
import { useTranslation } from "react-i18next";
import Activity from "@/components/activity";
import CommentInput from "@/components/activity/comment-input";
import { isCommentActivity } from "@/components/activity/utils";
import { ExternalLinksAccordion } from "@/components/external-links/external-links-accordion";
import useAuth from "@/components/providers/auth-provider/hooks/use-auth";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Timeline } from "@/components/ui/timeline";
import useGetActivitiesByTaskId from "@/hooks/queries/activity/use-get-activities-by-task-id";
import useExternalLinks from "@/hooks/queries/external-link/use-external-links";
import useGetProject from "@/hooks/queries/project/use-get-project";
import useGetTask from "@/hooks/queries/task/use-get-task";
import useGetTaskRelations from "@/hooks/queries/task-relation/use-get-task-relations";
import { useGetActiveWorkspaceUsers } from "@/hooks/queries/workspace-users/use-get-active-workspace-users";
import { formatDateShort } from "@/lib/format";
import { getInitials } from "@/lib/get-initials";
import type { ExternalLink } from "@/types/external-link";
import TaskAssigneePopover from "./task-assignee-popover";
import TaskDescription from "./task-description";
import TaskDueDatePopover from "./task-due-date-popover";
import TaskRelations from "./task-relations";
import TaskSubtasks from "./task-subtasks";
import TaskTitle from "./task-title";

type TaskDetailsContentProps = {
  taskId: string | undefined;
  projectId: string;
  workspaceId: string;
  className?: string;
};

export default function TaskDetailsContent({
  taskId,
  projectId,
  workspaceId,
  className,
}: TaskDetailsContentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: task } = useGetTask(taskId ?? "");
  const { data: project } = useGetProject({ id: projectId, workspaceId });
  const { data: activities = [] } = useGetActivitiesByTaskId(taskId ?? "");
  const { data: externalLinks = [], isLoading: isLoadingExternalLinks } =
    useExternalLinks(taskId ?? "");
  const { data: relations = [] } = useGetTaskRelations(taskId ?? "");
  const { data: workspaceUsers } = useGetActiveWorkspaceUsers(workspaceId);
  const { user } = useAuth();

  const parentRelation = relations.find(
    (rel) => rel.relationType === "subtask" && rel.targetTaskId === taskId,
  );
  const parentTask = parentRelation?.sourceTask;

  const assignee = workspaceUsers?.members?.find(
    (member) => member.userId === task?.userId,
  );

  if (!taskId) return null;

  return (
    <div className={`${className} gap-4`}>
      <div className="flex flex-col gap-2.5">
        {parentTask && (
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-card-foreground transition-colors w-fit"
            onClick={() =>
              navigate({
                to: "/dashboard/workspace/$workspaceId/project/$projectId/task/$taskId",
                params: {
                  workspaceId,
                  projectId,
                  taskId: parentTask.id,
                },
              })
            }
          >
            <ArrowUpRight className="size-3" />
            <span>
              {t("tasks:detail.subtaskOf")}{" "}
              <span className="font-medium">{parentTask.title}</span>
            </span>
          </button>
        )}
        <p className="text-xs font-semibold text-card-foreground/70">
          {project?.slug}-{task?.number}
        </p>
        <TaskTitle taskId={taskId} />
        {/* Assignee + due row (Piece B, Asana IMG_2123) — phone task detail only. Sits
            directly beneath the title, matching the reference's header block.

            Codex r1 #15 — WHAT THE CODE ACTUALLY DOES, correcting the claim that used to
            sit here. This row is `md:hidden`, so it is gone at 768px and above. The full
            properties panel (`TaskPropertiesSidebar`) renders below the content via
            `task-layout.tsx`'s `lg:hidden` block, so it shows below 1024px. The two
            therefore never overlap: under 768px the reader gets this row and the panel
            beneath it, and from 768-1023px they get the panel alone, with no compact row.
            The earlier note claimed both showed together on a tablet as "accepted
            redundancy" — that was never true, and the `lg:` split is still untouched. */}
        {task && (
          <div className="flex md:hidden items-center gap-3 text-sm">
            <TaskAssigneePopover task={task} workspaceId={workspaceId}>
              <button
                type="button"
                data-testid="phone-task-assignee"
                className="flex min-h-[32px] items-center gap-1.5 rounded-full bg-secondary px-2 py-1"
              >
                <Avatar className="h-5 w-5">
                  <AvatarImage
                    src={assignee?.user?.image ?? ""}
                    alt={assignee?.user?.name || ""}
                  />
                  <AvatarFallback className="text-[9px] font-medium">
                    {getInitials(assignee?.user?.name || task.assigneeName)}
                  </AvatarFallback>
                </Avatar>
                <span className="text-xs font-medium text-card-foreground">
                  {assignee?.user?.name ||
                    task.assigneeName ||
                    t("tasks:popover.assignee.unassigned")}
                </span>
              </button>
            </TaskAssigneePopover>
            <TaskDueDatePopover task={task}>
              <button
                type="button"
                data-testid="phone-task-due-date"
                className="flex min-h-[32px] items-center gap-1.5 rounded-full bg-secondary px-2 py-1 text-xs font-medium text-card-foreground"
              >
                <CalendarClock className="size-3.5" aria-hidden="true" />
                {task.dueDate
                  ? formatDateShort(task.dueDate)
                  : t("tasks:backlog.filters.noDueDate")}
              </button>
            </TaskDueDatePopover>
          </div>
        )}
        <TaskDescription taskId={taskId} />
      </div>
      {!isLoadingExternalLinks && externalLinks.length > 0 && (
        <div className="mt-4">
          <ExternalLinksAccordion
            externalLinks={externalLinks as ExternalLink[]}
            isLoading={isLoadingExternalLinks}
          />
        </div>
      )}
      <div className="mt-4">
        {task && (
          <TaskSubtasks
            taskId={taskId}
            projectId={projectId}
            workspaceId={workspaceId}
            parentStatus={task.status}
          />
        )}
      </div>
      <div className="mt-2">
        <TaskRelations
          taskId={taskId}
          projectId={projectId}
          workspaceId={workspaceId}
        />
      </div>
      <span className="text-sm font-medium text-muted-foreground h-[1px] bg-border w-full block shrink-0" />
      <div className="flex flex-col gap-4">
        <h1 className="text-md font-semibold">{t("tasks:detail.activity")}</h1>
        {user?.id && taskId && <CommentInput taskId={taskId} />}
        {activities.length > 0 ? (
          <Timeline>
            {activities.map((activity, index) => {
              const nextActivity = activities[index + 1];
              const showConnector =
                !isCommentActivity(activity) &&
                Boolean(nextActivity) &&
                !isCommentActivity(nextActivity);

              return (
                <Activity
                  key={activity.id}
                  activity={activity}
                  step={activities.length - index}
                  showConnector={showConnector}
                />
              );
            })}
          </Timeline>
        ) : (
          <p className="text-sm font-medium text-muted-foreground">
            {t("tasks:detail.noActivity")}
          </p>
        )}
      </div>
    </div>
  );
}
