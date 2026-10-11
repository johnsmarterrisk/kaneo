import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Operon fork checks — Tables task 6 (docs/fork-discipline.md row 18, spec 7.1, R-B3, R-D,
 * RF-8, RF-9): removing a table column hides it (values and history kept, admin-only
 * recovery read), every active read omits it, #1542's definition routes need a table
 * admin on table projects, a table column takes no default and active names are unique.
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
setEnv("KANEO_WEBHOOK_SECRET", "tables-columns-webhook-secret");
setEnv("OPERON_KANEO_S2S_SECRET", "tables-columns-s2s-secret");
setEnv("KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS", "true");

const { createApp } = await import("../../apps/api/src/index");
const { auth } = await import("../../apps/api/src/auth");
const { default: db } = await import("../../apps/api/src/database");
const { tableWriteHooks } = await import(
  "../../apps/api/src/operon-tables/write-row"
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
  customFieldDefinitionTable,
  customFieldValueTable,
  operonTableProjectTable,
  operonTableRowOutboxTable,
  operonTableValueHistoryTable,
  taskTable,
  userTable,
  workspaceRoleTable,
  workspaceUserTable,
} = await import("../../apps/api/src/database/schema");

const { app } = createApp();

afterAll(() => {
  platform.close();
});

function json(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function addMember(workspaceId: string, role: string) {
  const [user] = await db
    .insert(userTable)
    .values({
      id: `user-${randomUUID()}`,
      email: `${randomUUID()}@example.com`,
      emailVerified: true,
      name: `Member ${role}`,
    })
    .returning();
  await db.insert(workspaceUserTable).values({
    workspaceId,
    userId: user.id,
    role,
    joinedAt: new Date(),
  });
  return user;
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
  const defs = await db
    .select()
    .from(customFieldDefinitionTable)
    .where(eq(customFieldDefinitionTable.projectId, tableId));
  const col = Object.fromEntries(defs.map((d) => [d.name, d]));
  const series = await json("POST", "/api/custom-field", {
    projectId: tableId,
    name: "Series",
    type: "text",
  });
  expect(series.status).toBe(200);
  const seriesId = ((await series.json()) as { id: string }).id;
  const rowIds: string[] = [];
  for (const [title, value] of [
    ["One", "Spring"],
    ["Two", "Autumn"],
  ]) {
    const added = await json("POST", `/api/operon/tables/${tableId}/rows`, {
      requestId: randomUUID(),
      title,
      values: { Series: value, Status: "Idea" },
    });
    rowIds.push(((await added.json()) as { row: { rowId: string } }).row.rowId);
  }
  await json("PATCH", `/api/operon/tables/${tableId}/rows/${rowIds[0]}`, {
    values: { Series: "Summer" },
  });
  return { owner, tableId, col, seriesId, rowIds };
}

async function customRoleEditor(workspaceId: string) {
  await db.insert(workspaceRoleTable).values({
    workspaceId,
    role: "editor",
    permission: JSON.stringify({
      project: ["create", "read", "update", "delete"],
      task: ["create", "read", "update", "delete"],
    }),
  });
  return addMember(workspaceId, "editor");
}

describe("API integration: Tables — hide, not delete (task 6)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    tableOutboxHooks.disableKick = true;
    tableWriteHooks.afterPreCheck = undefined;
  });

  it("hiding keeps current and earlier values; the admin recovery read returns both", async () => {
    const s = await seed();
    const valuesBefore = await db
      .select()
      .from(customFieldValueTable)
      .where(eq(customFieldValueTable.fieldId, s.seriesId));
    const historyBefore = await db
      .select()
      .from(operonTableValueHistoryTable)
      .where(eq(operonTableValueHistoryTable.fieldId, s.seriesId));
    const outboxBefore = await db.select().from(operonTableRowOutboxTable);
    expect(valuesBefore).toHaveLength(2);
    expect(historyBefore).toHaveLength(3);

    const hide = await json("DELETE", `/api/custom-field/${s.seriesId}`);
    expect(hide.status).toBe(200);
    const [field] = await db
      .select()
      .from(customFieldDefinitionTable)
      .where(eq(customFieldDefinitionTable.id, s.seriesId));
    expect(field.hiddenAt).not.toBeNull();
    expect(
      await db
        .select()
        .from(customFieldValueTable)
        .where(eq(customFieldValueTable.fieldId, s.seriesId)),
    ).toHaveLength(2);
    expect(
      await db
        .select()
        .from(operonTableValueHistoryTable)
        .where(eq(operonTableValueHistoryTable.fieldId, s.seriesId)),
    ).toHaveLength(3);
    // A hide rewrites no rows, so it signals nothing.
    expect(await db.select().from(operonTableRowOutboxTable)).toHaveLength(
      outboxBefore.length,
    );

    const read = await json(
      "GET",
      `/api/operon/tables/${s.tableId}/fields/${s.seriesId}/history`,
    );
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      field: { hidden: boolean; name: string };
      current: { rowId: string; value: string }[];
      history: { oldValue: string | null; newValue: string | null }[];
    };
    expect(body.field).toMatchObject({ hidden: true, name: "Series" });
    expect(body.current.map((c) => c.value).sort()).toEqual([
      "Autumn",
      "Summer",
    ]);
    expect(body.history.map((h) => [h.oldValue, h.newValue])).toContainEqual([
      "Spring",
      "Summer",
    ]);
    expect(body.history).toHaveLength(3);
  });

  it("refuses the recovery read to a member, a custom role and any API key", async () => {
    const s = await seed();
    const path = `/api/operon/tables/${s.tableId}/fields/${s.seriesId}/history`;
    const member = await addMember(s.owner.workspace.id, "member");
    mockAuthenticatedSession(member);
    expect((await json("GET", path)).status).toBe(403);
    const editor = await customRoleEditor(s.owner.workspace.id);
    mockAuthenticatedSession(editor);
    const asEditor = await json("GET", path);
    expect(asEditor.status).toBe(403);
    expect(((await asEditor.json()) as { error: string }).error).toBe(
      "admin_only",
    );
    // Any API key is refused, even the owner's own (the agent path is covered in task 3).
    const ownerKey = await auth.api.createApiKey({
      body: { userId: s.owner.user.id, name: "owner-key" },
    });
    const asKey = await json("GET", path, undefined, {
      "x-api-key": ownerKey.key,
    });
    expect(asKey.status).toBe(403);
    expect(((await asKey.json()) as { error: string }).error).toBe(
      "api_key_not_allowed",
    );
  });

  it("a custom role with project:update is refused on a table's definition routes, allowed on a project's (RF-9)", async () => {
    const s = await seed();
    const { project } = await createProjectFixture({
      workspaceId: s.owner.workspace.id,
    });
    const editor = await customRoleEditor(s.owner.workspace.id);
    mockAuthenticatedSession(editor);

    const create = await json("POST", "/api/custom-field", {
      projectId: s.tableId,
      name: "Owner",
      type: "text",
    });
    const reorder = await json(
      "PUT",
      `/api/custom-field/reorder/${s.tableId}`,
      {
        fields: [{ id: s.seriesId, position: 1 }],
      },
    );
    const hide = await json("DELETE", `/api/custom-field/${s.seriesId}`);
    for (const response of [create, reorder, hide]) {
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toBe(
        "admin_only",
      );
    }

    const ordinary = await json("POST", "/api/custom-field", {
      projectId: project.id,
      name: "Owner",
      type: "text",
    });
    expect(ordinary.status).toBe(200);
    const { id } = (await ordinary.json()) as { id: string };
    expect(
      (
        await json("PUT", `/api/custom-field/reorder/${project.id}`, {
          fields: [{ id, position: 2 }],
        })
      ).status,
    ).toBe(200);
    expect((await json("DELETE", `/api/custom-field/${id}`)).status).toBe(200);
    // An ordinary project's delete still deletes.
    expect(
      await db
        .select()
        .from(customFieldDefinitionTable)
        .where(eq(customFieldDefinitionTable.id, id)),
    ).toHaveLength(0);
  });

  it("refuses a table column's default without touching any row; a project keeps #1542's backfill", async () => {
    const s = await seed();
    const before = {
      values: (await db.select().from(customFieldValueTable)).length,
      history: (await db.select().from(operonTableValueHistoryTable)).length,
      outbox: (await db.select().from(operonTableRowOutboxTable)).length,
    };
    const refused = await json("POST", "/api/custom-field", {
      projectId: s.tableId,
      name: "Region",
      type: "text",
      defaultValue: "EU",
    });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "default_not_allowed",
    );
    expect((await db.select().from(customFieldValueTable)).length).toBe(
      before.values,
    );
    expect((await db.select().from(operonTableValueHistoryTable)).length).toBe(
      before.history,
    );
    expect((await db.select().from(operonTableRowOutboxTable)).length).toBe(
      before.outbox,
    );

    const { project } = await createProjectFixture({
      workspaceId: s.owner.workspace.id,
    });
    const [task] = await db
      .insert(taskTable)
      .values({ projectId: project.id, title: "Plain", number: 900 })
      .returning();
    const backfilled = await json("POST", "/api/custom-field", {
      projectId: project.id,
      name: "Region",
      type: "text",
      defaultValue: "EU",
    });
    expect(backfilled.status).toBe(200);
    const values = await db
      .select()
      .from(customFieldValueTable)
      .where(eq(customFieldValueTable.taskId, task.id));
    expect(values.map((v) => v.value)).toEqual(["EU"]);
  });

  it("a required table column needs no default and is required on add", async () => {
    const s = await seed();
    const created = await json("POST", "/api/custom-field", {
      projectId: s.tableId,
      name: "Owner note",
      type: "text",
      required: true,
    });
    expect(created.status).toBe(200);
    const missing = await json("POST", `/api/operon/tables/${s.tableId}/rows`, {
      requestId: randomUUID(),
      title: "Three",
    });
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({
      error: "required_value",
      column: "Owner note",
    });
  });

  it("two concurrent creates of one name in different case yield one active column", async () => {
    const s = await seed();
    const [a, b] = await Promise.all([
      json("POST", "/api/custom-field", {
        projectId: s.tableId,
        name: "Region",
        type: "text",
      }),
      json("POST", "/api/custom-field", {
        projectId: s.tableId,
        name: " region ",
        type: "text",
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const active = await db
      .select()
      .from(customFieldDefinitionTable)
      .where(
        and(
          eq(customFieldDefinitionTable.projectId, s.tableId),
          isNull(customFieldDefinitionTable.hiddenAt),
        ),
      );
    expect(
      active.filter((d) => d.name.trim().toLowerCase() === "region"),
    ).toHaveLength(1);
    // A hidden column's name may be reused.
    const series = await json("DELETE", `/api/custom-field/${s.seriesId}`);
    expect(series.status).toBe(200);
    const again = await json("POST", "/api/custom-field", {
      projectId: s.tableId,
      name: "Series",
      type: "text",
    });
    expect(again.status).toBe(200);
  });

  it("a save revalidates under the locks when a column is hidden after its pre-check (RF-8)", async () => {
    const s = await seed();
    const before = {
      history: (await db.select().from(operonTableValueHistoryTable)).length,
      outbox: (await db.select().from(operonTableRowOutboxTable)).length,
    };
    tableWriteHooks.afterPreCheck = async () => {
      tableWriteHooks.afterPreCheck = undefined;
      const hide = await json("DELETE", `/api/custom-field/${s.seriesId}`);
      expect(hide.status).toBe(200);
    };
    const response = await json(
      "PATCH",
      `/api/operon/tables/${s.tableId}/rows/${s.rowIds[1]}`,
      { values: { Series: "Winter" } },
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: string;
      columns: string[];
    };
    expect(body.error).toBe("unknown_column");
    expect(body.columns).not.toContain("Series");
    expect((await db.select().from(operonTableValueHistoryTable)).length).toBe(
      before.history,
    );
    expect((await db.select().from(operonTableRowOutboxTable)).length).toBe(
      before.outbox,
    );
  });

  it("hiding the group, date or status column clears that pointer", async () => {
    const s = await seed();
    for (const name of ["Topic", "Posted", "Status"]) {
      expect(
        (await json("DELETE", `/api/custom-field/${s.col[name].id}`)).status,
      ).toBe(200);
    }
    const [flag] = await db
      .select()
      .from(operonTableProjectTable)
      .where(eq(operonTableProjectTable.projectId, s.tableId));
    expect([flag.groupFieldId, flag.dateFieldId, flag.statusFieldId]).toEqual([
      null,
      null,
      null,
    ]);
    const table = (await (
      await json("GET", `/api/operon/tables/${s.tableId}`)
    ).json()) as { columns: { name: string }[] };
    expect(table.columns.map((c) => c.name)).toEqual([
      "Channel",
      "Link",
      "Series",
    ]);
  });

  it("active definitions, values, filter values and a member's Last change omit a hidden column", async () => {
    const s = await seed();
    await json("DELETE", `/api/custom-field/${s.seriesId}`);
    const member = await addMember(s.owner.workspace.id, "member");
    mockAuthenticatedSession(member);

    const defs = (await (
      await json("GET", `/api/custom-field/project/${s.tableId}`)
    ).json()) as { id: string }[];
    expect(defs.map((d) => d.id)).not.toContain(s.seriesId);
    const byProject = (await (
      await json("GET", `/api/custom-field/project/${s.tableId}/values`)
    ).json()) as { fieldId: string }[];
    expect(byProject.length).toBeGreaterThan(0);
    expect(byProject.map((v) => v.fieldId)).not.toContain(s.seriesId);
    const byTask = (await (
      await json("GET", `/api/custom-field/task/${s.rowIds[0]}`)
    ).json()) as { fieldId: string }[];
    expect(byTask.map((v) => v.fieldId)).not.toContain(s.seriesId);
    const filters = (await (
      await json("GET", `/api/custom-field/project/${s.tableId}/filter-values`)
    ).json()) as { fieldId: string }[];
    expect(filters.map((f) => f.fieldId)).not.toContain(s.seriesId);

    // Row one's last change set Series to "Summer"; the member sees neither.
    const changed = await json(
      "PATCH",
      `/api/operon/tables/${s.tableId}/rows/${s.rowIds[0]}`,
      {},
    );
    const text = await changed.text();
    expect(changed.status).toBe(200);
    expect(text).not.toContain("Series");
    expect(text).not.toContain("Summer");
  });
});
