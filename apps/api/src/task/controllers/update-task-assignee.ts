import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { taskTable, userTable } from "../../database/schema";
import { publishEvent } from "../../events";
import {
  lockTaskThenClaim,
  revokeIfReassigned,
} from "../../operon-card-claims";
import {
  assertAssignableUser,
  getProjectWorkspaceId,
} from "../../utils/assert-assignable-user";

async function updateTaskAssignee({
  id,
  userId,
  currentUserId,
}: {
  id: string;
  userId: string | null;
  currentUserId: string;
}) {
  const existingTask = await db.query.taskTable.findFirst({
    where: eq(taskTable.id, id),
  });

  if (!existingTask) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  const nextAssigneeId = userId?.trim() || null;
  if (existingTask.userId === nextAssigneeId) {
    return existingTask;
  }

  if (nextAssigneeId) {
    await assertAssignableUser(
      nextAssigneeId,
      await getProjectWorkspaceId(existingTask.projectId),
    );
  }

  // Operon fork (docs/fork-discipline.md row 19, Phase 3 D8): the reassignment and the revoke of
  // an agent's active claim on this card are one transaction, locking the task row then its
  // claim row (the one lock order), so a person's reassignment always wins.
  const [updatedTask] = await db.transaction(async (tx) => {
    const { claim } = await lockTaskThenClaim(tx, id);
    await revokeIfReassigned(tx, claim, nextAssigneeId);
    return tx
      .update(taskTable)
      .set({ userId: nextAssigneeId })
      .where(eq(taskTable.id, id))
      .returning();
  });

  if (!updatedTask) {
    throw new HTTPException(500, {
      message: "Failed to update task assignee",
    });
  }

  const newAssigneeName = nextAssigneeId
    ? (
        await db
          .select({ name: userTable.name })
          .from(userTable)
          .where(eq(userTable.id, nextAssigneeId))
          .limit(1)
      )[0]?.name
    : undefined;

  if (!nextAssigneeId) {
    await publishEvent("task.unassigned", {
      taskId: updatedTask.id,
      projectId: updatedTask.projectId,
      userId: currentUserId,
      title: updatedTask.title,
      type: "unassigned",
    });

    return updatedTask;
  }

  await publishEvent("task.assignee_changed", {
    taskId: updatedTask.id,
    projectId: updatedTask.projectId,
    userId: currentUserId,
    oldAssignee: existingTask.userId,
    newAssignee: newAssigneeName,
    newAssigneeId: nextAssigneeId,
    title: updatedTask.title,
    type: "assignee_changed",
  });

  return updatedTask;
}

export default updateTaskAssignee;
