import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Operon fork checks — Tables task 5 (docs/fork-discipline.md row 18, spec 7.5, R-B, R-E,
 * RF-5): every upstream route that would change a table row outside the row writer is
 * refused 409 with a machine reason, and still works for an ordinary task; a table with
 * entries or pending signals cannot be deleted, and the check holds under concurrency.
 */
function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const platform = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.url === "/internal/kaneo/agent-active") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end('{"active":true}');
    }
    res.writeHead(req.url === "/webhooks/kaneo" ? 200 : 404);
    res.end();
  });
});
const platformPort = await listen(platform);

setEnv("OPERON_INTERNAL_API_URL", `http://127.0.0.1:${platformPort}`);
setEnv("KANEO_WEBHOOK_SECRET", "tables-guard-webhook-secret");
setEnv("OPERON_KANEO_S2S_SECRET", "tables-guard-s2s-secret");
setEnv("KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS", "true");

const { createApp } = await import("../../apps/api/src/index");
const { default: db } = await import("../../apps/api/src/database");
const { tableWriteHooks } = await import(
  "../../apps/api/src/operon-tables/write-row"
);
const { tableDeleteHooks } = await import(
  "../../apps/api/src/operon-tables/guard"
);
const { tableOutboxHooks } = await import(
  "../../apps/api/src/operon-tables/outbox"
);
const { mockAuthenticatedSession } = await import("./helpers/auth");
const { resetTestDatabase } = await import("./helpers/database");
const { createProjectFixture, createWorkspaceMember } = await import(
  "./helpers/fixtures"
);
const {
  commentTable,
  customFieldDefinitionTable,
  operonTableProjectTable,
  operonTableRowOutboxTable,
  operonTableValueHistoryTable,
  projectTable,
  taskRelationTable,
  taskTable,
} = await import("../../apps/api/src/database/schema");

const { app } = createApp();

afterAll(() => {
  platform.close();
});

function json(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function seed() {
  const owner = await createWorkspaceMember({ role: "owner" });
  mockAuthenticatedSession(owner.user);
  const created = await json("POST", "/api/operon/tables", {
    workspaceId: owner.workspace.id,
    name: "Risk tips",
    slug: "RISK",
  });
  const tableId = ((await created.json()) as { id: string }).id;
  const added = await json("POST", `/api/operon/tables/${tableId}/rows`, {
    requestId: randomUUID(),
    title: "Row",
    values: { Status: "Idea" },
  });
  const rowId = ((await added.json()) as { row: { rowId: string } }).row.rowId;
  const { project } = await createProjectFixture({
    workspaceId: owner.workspace.id,
  });
  const [task] = await db
    .insert(taskTable)
    .values({ projectId: project.id, title: "Plain", number: 900 })
    .returning();
  const [other] = await db
    .insert(taskTable)
    .values({ projectId: project.id, title: "Plain 2", number: 901 })
    .returning();
  const [status] = await db
    .select()
    .from(customFieldDefinitionTable)
    .where(eq(customFieldDefinitionTable.projectId, tableId))
    .limit(1);
  return { owner, tableId, rowId, project, task, other, fieldId: status.id };
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function expectRefused(response: Response, reason: string) {
  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: string }).error).toBe(reason);
}

const TASK_FIELD_BODIES: Record<string, unknown> = {
  status: { status: "done" },
  priority: { priority: "high" },
  assignee: { userId: "" },
  "due-date": { dueDate: "2026-12-01T00:00:00.000Z" },
  title: { title: "New" },
  description: { description: "New" },
};

describe("API integration: Tables — upstream route guard (task 5)", () => {
  let s: Seed;
  beforeEach(async () => {
    await resetTestDatabase();
    tableOutboxHooks.disableKick = true;
    tableWriteHooks.afterProjectLock = undefined;
    tableDeleteHooks.afterLock = undefined;
    s = await seed();
  });

  it("POST /task/{projectId} into a table is refused; into a project it works", async () => {
    const body = {
      title: "T",
      description: "",
      status: "to-do",
      priority: "low",
    };
    await expectRefused(
      await json("POST", `/api/task/${s.tableId}`, body),
      "table_row_use_table_route",
    );
    expect((await json("POST", `/api/task/${s.project.id}`, body)).status).toBe(
      200,
    );
  });

  it("PUT /task/{id} on a row is refused; on a task it works", async () => {
    const body = (projectId: string) => ({
      title: "T",
      description: "",
      status: "to-do",
      priority: "low",
      projectId,
      position: 1,
    });
    await expectRefused(
      await json("PUT", `/api/task/${s.rowId}`, body(s.tableId)),
      "table_row_use_table_route",
    );
    expect(
      (await json("PUT", `/api/task/${s.task.id}`, body(s.project.id))).status,
    ).toBe(200);
  });

  for (const [route, body] of Object.entries(TASK_FIELD_BODIES)) {
    it(`PUT /task/${route}/{id} on a row is refused; on a task it works`, async () => {
      await expectRefused(
        await json("PUT", `/api/task/${route}/${s.rowId}`, body),
        "table_row_use_table_route",
      );
      expect(
        (await json("PUT", `/api/task/${route}/${s.task.id}`, body)).status,
      ).toBe(200);
    });
  }

  it("PATCH /task/bulk with a row among the ids is refused; with tasks it works", async () => {
    await expectRefused(
      await json("PATCH", "/api/task/bulk", {
        taskIds: [s.task.id, s.rowId],
        operation: "updatePriority",
        value: "high",
      }),
      "table_row_use_table_route",
    );
    expect(
      (
        await json("PATCH", "/api/task/bulk", {
          taskIds: [s.task.id],
          operation: "updatePriority",
          value: "high",
        })
      ).status,
    ).toBe(200);
  });

  it("DELETE /task/{id} on a row is refused; on a task it works", async () => {
    await expectRefused(
      await json("DELETE", `/api/task/${s.rowId}`),
      "table_row_use_table_route",
    );
    expect((await json("DELETE", `/api/task/${s.task.id}`)).status).toBe(200);
  });

  it("PUT /custom-field/value on a row is refused; on a task it works", async () => {
    await expectRefused(
      await json("PUT", "/api/custom-field/value", {
        taskId: s.rowId,
        fieldId: s.fieldId,
        value: "Cyber",
      }),
      "table_row_use_table_route",
    );
    const field = await json("POST", "/api/custom-field", {
      projectId: s.project.id,
      name: "Note",
      type: "text",
    });
    const { id } = (await field.json()) as { id: string };
    expect(
      (
        await json("PUT", "/api/custom-field/value", {
          taskId: s.task.id,
          fieldId: id,
          value: "x",
        })
      ).status,
    ).toBe(200);
  });

  it("imports into a table are refused (task import, GitHub and Gitea)", async () => {
    await expectRefused(
      await json("POST", `/api/task/import/${s.tableId}`, { tasks: [] }),
      "table_import_not_supported",
    );
    expect(
      (await json("POST", `/api/task/import/${s.project.id}`, { tasks: [] }))
        .status,
    ).toBe(200);
    for (const provider of ["github", "gitea"]) {
      await expectRefused(
        await json("POST", `/api/${provider}-integration/import-issues`, {
          projectId: s.tableId,
        }),
        "table_import_not_supported",
      );
      expect(
        (
          await json("POST", `/api/${provider}-integration/import-issues`, {
            projectId: s.project.id,
          })
        ).status,
      ).not.toBe(409);
    }
  });

  it("moves into or out of a table are refused; between projects they work", async () => {
    await expectRefused(
      await json("PUT", `/api/task/move/${s.rowId}`, {
        destinationProjectId: s.project.id,
      }),
      "table_move_not_supported",
    );
    await expectRefused(
      await json("PUT", `/api/task/move/${s.task.id}`, {
        destinationProjectId: s.tableId,
      }),
      "table_move_not_supported",
    );
    const { project: second } = await createProjectFixture({
      workspaceId: s.owner.workspace.id,
    });
    expect(
      (
        await json("PUT", `/api/task/move/${s.task.id}`, {
          destinationProjectId: second.id,
        })
      ).status,
    ).toBe(200);
  });

  it("comments on a row are refused (create, update, delete); on a task they work", async () => {
    await expectRefused(
      await json("POST", `/api/comment/${s.rowId}`, { content: "hi" }),
      "table_row_comments_disabled",
    );
    // Dirty data: a comment that predates the guard.
    const [dirty] = await db
      .insert(commentTable)
      .values({ taskId: s.rowId, userId: s.owner.user.id, content: "old" })
      .returning();
    await expectRefused(
      await json("PUT", `/api/comment/${dirty.id}`, { content: "new" }),
      "table_row_comments_disabled",
    );
    await expectRefused(
      await json("DELETE", `/api/comment/${dirty.id}`),
      "table_row_comments_disabled",
    );
    expect(
      (await json("POST", `/api/comment/${s.task.id}`, { content: "hi" }))
        .status,
    ).toBe(200);
  });

  it("relations touching a row are refused (either end, delete); between tasks they work", async () => {
    for (const [source, target] of [
      [s.rowId, s.task.id],
      [s.task.id, s.rowId],
    ]) {
      await expectRefused(
        await json("POST", "/api/task-relation", {
          sourceTaskId: source,
          targetTaskId: target,
          relationType: "related",
        }),
        "table_row_relations_disabled",
      );
    }
    const [dirty] = await db
      .insert(taskRelationTable)
      .values({
        sourceTaskId: s.task.id,
        targetTaskId: s.rowId,
        relationType: "related",
      })
      .returning();
    await expectRefused(
      await json("DELETE", `/api/task-relation/${dirty.id}`),
      "table_row_relations_disabled",
    );
    expect(
      (
        await json("POST", "/api/task-relation", {
          sourceTaskId: s.task.id,
          targetTaskId: s.other.id,
          relationType: "related",
        })
      ).status,
    ).toBe(200);
  });

  it("refuses deleting a table with entries or pending signals; deletes an empty drained one (RF-5)", async () => {
    const withRow = await json("DELETE", `/api/project/${s.tableId}`);
    await expectRefused(withRow, "table_has_rows");
    expect(
      await db.select().from(taskTable).where(eq(taskTable.id, s.rowId)),
    ).toHaveLength(1);
    const records = await db.select().from(operonTableRowOutboxTable);
    expect(records.length).toBeGreaterThan(0);

    // Through the table route, the row goes and its task.deleted record stays pending.
    await json("DELETE", `/api/operon/tables/${s.tableId}/rows/${s.rowId}`);
    await expectRefused(
      await json("DELETE", `/api/project/${s.tableId}`),
      "table_outbox_pending",
    );
    expect(await db.select().from(operonTableValueHistoryTable)).toHaveLength(
      1,
    );

    await db.delete(operonTableRowOutboxTable);
    expect((await json("DELETE", `/api/project/${s.tableId}`)).status).toBe(
      200,
    );
    expect(await db.select().from(operonTableProjectTable)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(customFieldDefinitionTable)
        .where(eq(customFieldDefinitionTable.projectId, s.tableId)),
    ).toHaveLength(0);
    expect(await db.select().from(operonTableValueHistoryTable)).toHaveLength(
      0,
    );

    expect((await json("DELETE", `/api/project/${s.project.id}`)).status).toBe(
      200,
    );
  });

  it("a row add holding the project lock makes a racing delete answer table_has_rows", async () => {
    // An empty, drained table: only the racing add can make it non-empty.
    await json("DELETE", `/api/operon/tables/${s.tableId}/rows/${s.rowId}`);
    await db.delete(operonTableRowOutboxTable);

    let release: () => void = () => {};
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    tableWriteHooks.afterProjectLock = () =>
      new Promise<void>((r) => {
        release = r;
        locked();
      });
    const add = json("POST", `/api/operon/tables/${s.tableId}/rows`, {
      requestId: randomUUID(),
      title: "Racing",
    });
    await isLocked;
    tableWriteHooks.afterProjectLock = undefined;
    // The guard's early check sees an empty table; the authoritative check waits on the lock.
    const del = json("DELETE", `/api/project/${s.tableId}`);
    await new Promise((r) => setTimeout(r, 300));
    release();
    expect((await add).status).toBe(200);
    await expectRefused(await del, "table_has_rows");
    expect(
      (await db.select().from(operonTableRowOutboxTable)).map((r) => r.event),
    ).toEqual(["task.created", "task.fields_changed"]);
  });

  it("a delete holding the project lock makes a racing add fail with no row or orphan record", async () => {
    await json("DELETE", `/api/operon/tables/${s.tableId}/rows/${s.rowId}`);
    await db.delete(operonTableRowOutboxTable);

    let release: () => void = () => {};
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    tableDeleteHooks.afterLock = () =>
      new Promise<void>((r) => {
        release = r;
        locked();
      });
    const del = json("DELETE", `/api/project/${s.tableId}`);
    await isLocked;
    tableDeleteHooks.afterLock = undefined;
    const add = json("POST", `/api/operon/tables/${s.tableId}/rows`, {
      requestId: randomUUID(),
      title: "Too late",
    });
    await new Promise((r) => setTimeout(r, 300));
    release();
    expect((await del).status).toBe(200);
    const added = await add;
    expect(added.status).toBe(404);
    expect(await db.select().from(operonTableRowOutboxTable)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(projectTable)
        .where(eq(projectTable.id, s.tableId)),
    ).toHaveLength(0);
  });
});
