import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Operon fork checks — Tables task 5 (docs/fork-discipline.md row 18, spec 7.3, R-B, R-B2,
 * R-B3, R-G, RF-8): a table row save commits the row, its value history, its attribution
 * and its outbox records in ONE transaction; a save equal to the stored row writes
 * nothing; validation answers structured 422s that never echo a value.
 *
 * A local HTTP server stands in for Operon: agent liveness, the Stash image check and
 * `/webhooks/kaneo` (which the table's announcement reaches when it is created).
 */
function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const WEBHOOK_SECRET = "tables-rows-webhook-secret";
const S2S_SECRET = "tables-rows-s2s-secret";
const LIVE_IMAGE = "11111111-1111-4111-8111-111111111111";
const DELETED_IMAGE = "33333333-3333-4333-8333-333333333333";

const platform = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    if (req.url === "/internal/kaneo/agent-active") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end('{"active":true}');
    }
    if (req.url === "/internal/kaneo/stash-image") {
      const fileId = String(JSON.parse(raw).fileId);
      res.writeHead(fileId === LIVE_IMAGE ? 200 : 410);
      return res.end();
    }
    if (req.url === "/webhooks/kaneo") {
      createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
      res.writeHead(200);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
});
const platformPort = await listen(platform);

setEnv("OPERON_INTERNAL_API_URL", `http://127.0.0.1:${platformPort}`);
setEnv("KANEO_WEBHOOK_SECRET", WEBHOOK_SECRET);
setEnv("OPERON_KANEO_S2S_SECRET", S2S_SECRET);
setEnv("KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS", "true");

const { createApp } = await import("../../apps/api/src/index");
const { default: db } = await import("../../apps/api/src/database");
const { tableWriteHooks } = await import(
  "../../apps/api/src/operon-tables/write-row"
);
const { tableOutboxHooks } = await import(
  "../../apps/api/src/operon-tables/outbox"
);
const { mockAuthenticatedSession } = await import("./helpers/auth");
const { resetTestDatabase } = await import("./helpers/database");
const { createWorkspaceMember } = await import("./helpers/fixtures");
const {
  customFieldDefinitionTable,
  customFieldValueTable,
  operonTableRowMetaTable,
  operonTableRowOutboxTable,
  operonTableValueHistoryTable,
  taskTable,
  userTable,
  workspaceUserTable,
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

async function addMember(workspaceId: string, role = "member") {
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

async function seedTable() {
  const owner = await createWorkspaceMember({
    role: "owner",
    userName: "Olive",
  });
  mockAuthenticatedSession(owner.user);
  const created = await json("POST", "/api/operon/tables", {
    workspaceId: owner.workspace.id,
    name: "Risk tips",
    slug: "RISK",
  });
  expect(created.status).toBe(200);
  const table = (await created.json()) as { id: string };
  const defs = await db
    .select()
    .from(customFieldDefinitionTable)
    .where(eq(customFieldDefinitionTable.projectId, table.id));
  const col = Object.fromEntries(defs.map((d) => [d.name, d]));
  // Topic has no options in the template; give it two directly.
  await db
    .update(customFieldDefinitionTable)
    .set({ options: ["Cyber", "Fraud"] })
    .where(eq(customFieldDefinitionTable.id, col.Topic.id));
  return { owner, tableId: table.id, col };
}

async function addColumn(
  tableId: string,
  name: string,
  type: string,
  extra: Record<string, unknown> = {},
) {
  const response = await json("POST", "/api/custom-field", {
    projectId: tableId,
    name,
    type,
    ...extra,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string };
}

function addRow(tableId: string, body: Record<string, unknown>) {
  return json("POST", `/api/operon/tables/${tableId}/rows`, {
    requestId: randomUUID(),
    ...body,
  });
}

async function counts(taskId?: string) {
  const outbox = await db.select().from(operonTableRowOutboxTable);
  const history = await db.select().from(operonTableValueHistoryTable);
  const tasks = await db.select().from(taskTable);
  return {
    outbox: taskId ? outbox.filter((o) => o.taskId === taskId) : outbox,
    history: taskId ? history.filter((h) => h.taskId === taskId) : history,
    tasks,
  };
}

describe("API integration: Tables — row writes (task 5)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    tableOutboxHooks.disableKick = true;
    tableWriteHooks.afterPreCheck = undefined;
    tableWriteHooks.afterProjectLock = undefined;
    tableWriteHooks.afterValueUpsert = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates task, meta, values, history and two outbox records in one transaction", async () => {
    const { owner, tableId, col } = await seedTable();
    const longTitle = `${"Phishing ".repeat(15)}tip`;
    const response = await addRow(tableId, {
      title: longTitle,
      notes: "Check the sender",
      values: { Topic: "Cyber", [col.Status.id]: "Idea", posted: "2026-10-01" },
    });
    expect(response.status).toBe(200);
    const { row } = (await response.json()) as {
      row: {
        rowId: string;
        title: string;
        values: Record<string, unknown>;
        madeBy: { id: string };
      };
    };
    expect(row.title).toBe(longTitle.trim());
    expect(row.values).toMatchObject({
      Topic: "Cyber",
      Status: "Idea",
      Posted: "2026-10-01",
      Channel: null,
    });
    expect(row.madeBy.id).toBe(owner.user.id);

    const values = await db
      .select()
      .from(customFieldValueTable)
      .where(eq(customFieldValueTable.taskId, row.rowId));
    expect(values).toHaveLength(3);
    const [meta] = await db
      .select()
      .from(operonTableRowMetaTable)
      .where(eq(operonTableRowMetaTable.taskId, row.rowId));
    expect(meta.createdByUserId).toBe(owner.user.id);
    const { outbox, history } = await counts(row.rowId);
    expect(history).toHaveLength(3);
    expect(
      history.every((h) => h.oldValue === null && h.reason === "save"),
    ).toBe(true);
    expect(outbox.map((o) => o.event)).toEqual([
      "task.created",
      "task.fields_changed",
    ]);
    expect(new Set(outbox.map((o) => o.writeId)).size).toBe(1);
    const payload = outbox[1].payload as {
      task: { id: string; title: string };
      timestamp: string;
      data: {
        writeId: string;
        changes: { name: string; value: unknown }[];
        core: { fieldId: string; value: unknown }[];
      };
    };
    expect(payload.task.id).toBe(row.rowId);
    expect(Array.from(payload.task.title)).toHaveLength(80);
    expect(payload.task.title.endsWith("…")).toBe(true);
    expect(payload.data.writeId).toBe(outbox[1].writeId);
    expect(payload.data.changes.map((c) => [c.name, c.value]).sort()).toEqual(
      [
        ["Posted", "2026-10-01"],
        ["Status", "Idea"],
        ["Topic", "Cyber"],
      ].sort(),
    );
    expect(payload.data.core.map((c) => c.fieldId)).toEqual(["title", "notes"]);
    expect((outbox[0].payload as { timestamp: string }).timestamp).toBe(
      payload.timestamp,
    );
  });

  it("an update writes one record holding the changed fields only, with history", async () => {
    const { tableId, col } = await seedTable();
    const created = await addRow(tableId, {
      title: "Tip",
      values: { Topic: "Cyber", Status: "Idea" },
    });
    const { row } = (await created.json()) as { row: { rowId: string } };

    const response = await json(
      "PATCH",
      `/api/operon/tables/${tableId}/rows/${row.rowId}`,
      { values: { Status: "Published", Topic: "Cyber" } },
    );
    expect(response.status).toBe(200);
    const { outbox, history } = await counts(row.rowId);
    expect(outbox).toHaveLength(3);
    const update = outbox[2].payload as {
      data: { changes: { fieldId: string; value: unknown }[]; core: unknown[] };
    };
    expect(update.data.changes).toEqual([
      expect.objectContaining({ fieldId: col.Status.id, value: "Published" }),
    ]);
    expect(update.data.core).toEqual([]);
    const statusHistory = history.filter((h) => h.fieldId === col.Status.id);
    expect(statusHistory.map((h) => [h.oldValue, h.newValue])).toEqual([
      [null, "Idea"],
      ["Idea", "Published"],
    ]);
  });

  it("a save equal to the stored row writes nothing and answers 200 (R-G)", async () => {
    const { tableId } = await seedTable();
    const created = await addRow(tableId, {
      title: "Tip",
      values: { Topic: "Cyber" },
    });
    const { row } = (await created.json()) as { row: { rowId: string } };
    const before = await counts(row.rowId);
    const response = await json(
      "PATCH",
      `/api/operon/tables/${tableId}/rows/${row.rowId}`,
      { title: "Tip", values: { topic: "Cyber" } },
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { unchanged: boolean }).unchanged).toBe(
      true,
    );
    const after = await counts(row.rowId);
    expect(after.outbox).toHaveLength(before.outbox.length);
    expect(after.history).toHaveLength(before.history.length);
  });

  it("delete writes task.deleted and keeps the history", async () => {
    const { tableId } = await seedTable();
    const created = await addRow(tableId, {
      title: "Tip",
      values: { Topic: "Fraud" },
    });
    const { row } = (await created.json()) as { row: { rowId: string } };
    const response = await json(
      "DELETE",
      `/api/operon/tables/${tableId}/rows/${row.rowId}`,
    );
    expect(response.status).toBe(200);
    const { outbox, history, tasks } = await counts(row.rowId);
    expect(tasks).toHaveLength(0);
    expect(outbox.map((o) => o.event)).toEqual([
      "task.created",
      "task.fields_changed",
      "task.deleted",
    ]);
    expect((outbox[2].payload as { task: { id: string } }).task.id).toBe(
      row.rowId,
    );
    expect(history).toHaveLength(1);
  });

  it("an error after the value upsert rolls back the row and leaves no outbox record", async () => {
    const { tableId } = await seedTable();
    tableWriteHooks.afterValueUpsert = async () => {
      throw new Error("injected");
    };
    const response = await addRow(tableId, {
      title: "Tip",
      values: { Topic: "Cyber" },
    });
    expect(response.status).toBe(500);
    const { outbox, history, tasks } = await counts();
    expect(tasks).toHaveLength(0);
    expect(outbox).toHaveLength(0);
    expect(history).toHaveLength(0);
    expect(await db.select().from(customFieldValueTable)).toHaveLength(0);
  });

  it("two saves in one second give two writeIds", async () => {
    const { tableId } = await seedTable();
    const created = await addRow(tableId, { title: "Tip" });
    const { row } = (await created.json()) as { row: { rowId: string } };
    for (const status of ["Idea", "Published"]) {
      await json("PATCH", `/api/operon/tables/${tableId}/rows/${row.rowId}`, {
        values: { Status: status },
      });
    }
    const { outbox } = await counts(row.rowId);
    const updates = outbox.filter((o) => o.event === "task.fields_changed");
    expect(updates).toHaveLength(3);
    expect(new Set(updates.map((o) => o.writeId)).size).toBe(3);
  });

  it("Made by is the creator, Last change the later editor; an owner change keeps Made by", async () => {
    const { owner, tableId } = await seedTable();
    const created = await addRow(tableId, { title: "Tip" });
    const { row } = (await created.json()) as { row: { rowId: string } };

    const editor = await addMember(owner.workspace.id);
    mockAuthenticatedSession(editor);
    let response = await json(
      "PATCH",
      `/api/operon/tables/${tableId}/rows/${row.rowId}`,
      { values: { Status: "Published" } },
    );
    let body = (await response.json()) as {
      row: {
        madeBy: { id: string };
        lastChange: { by: { id: string }; summary: string };
      };
    };
    expect(body.row.madeBy.id).toBe(owner.user.id);
    expect(body.row.lastChange.by.id).toBe(editor.id);
    expect(body.row.lastChange.summary).toBe("set Status to Published");

    response = await json(
      "PATCH",
      `/api/operon/tables/${tableId}/rows/${row.rowId}`,
      { assigneeId: editor.id },
    );
    body = (await response.json()) as typeof body;
    expect(response.status).toBe(200);
    expect(body.row.madeBy.id).toBe(owner.user.id);
  });

  it("checks image values with Stash on the row route", async () => {
    const { tableId } = await seedTable();
    await addColumn(tableId, "Graphic", "image");
    const ok = await addRow(tableId, {
      title: "Tip",
      values: { Graphic: `https://operon.example/#/files/${LIVE_IMAGE}` },
    });
    expect(ok.status).toBe(200);
    const { row } = (await ok.json()) as {
      row: { values: Record<string, unknown> };
    };
    expect(row.values.Graphic).toBe(LIVE_IMAGE);

    const refused = await addRow(tableId, {
      title: "Tip 2",
      values: { Graphic: DELETED_IMAGE },
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      error: "image_refused",
      reason: "deleted",
    });
    expect((await counts()).tasks).toHaveLength(1);
  });

  it("round-trips number, boolean and multiselect and refuses bad input without a write", async () => {
    const { owner, tableId } = await seedTable();
    await addColumn(tableId, "Views", "number");
    await addColumn(tableId, "Evergreen", "boolean");
    await addColumn(tableId, "Audience", "multiselect", {
      options: ["Brokers", "Clients"],
    });
    // #1542 refuses a required column without a default (task 6 lifts that on tables).
    await db.insert(customFieldDefinitionTable).values({
      projectId: tableId,
      name: "Owner note",
      type: "text",
      required: true,
      position: 20,
    });

    const created = await addRow(tableId, {
      title: "Tip",
      values: {
        Views: 1250.5,
        Evergreen: true,
        Audience: ["Clients", "Brokers"],
        "Owner note": "x",
      },
    });
    expect(created.status).toBe(200);
    const { row } = (await created.json()) as {
      row: { rowId: string; values: Record<string, unknown> };
    };
    expect(row.values).toMatchObject({
      Views: 1250.5,
      Evergreen: true,
      Audience: ["Clients", "Brokers"],
    });
    const before = await counts();

    const refusals: [Record<string, unknown>, string][] = [
      [{ values: { Views: "many" } }, "invalid_value"],
      [{ values: { Evergreen: "yes" } }, "invalid_value"],
      [{ values: { Posted: "10/01/2026" } }, "invalid_value"],
      [{ values: { "Owner note": null } }, "required_value"],
      [{ values: { Nope: 1 } }, "unknown_column"],
      [{ values: { Topic: "Weather" } }, "unknown_option"],
    ];
    for (const [patch, error] of refusals) {
      const response = await json(
        "PATCH",
        `/api/operon/tables/${tableId}/rows/${row.rowId}`,
        patch,
      );
      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: string }).error).toBe(error);
    }
    const unknownColumn = await json(
      "PATCH",
      `/api/operon/tables/${tableId}/rows/${row.rowId}`,
      { values: { Nope: 1 } },
    );
    expect(
      ((await unknownColumn.json()) as { columns: string[] }).columns,
    ).toContain("Topic");

    const elsewhere = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(owner.user);
    const assignee = await json(
      "PATCH",
      `/api/operon/tables/${tableId}/rows/${row.rowId}`,
      { assigneeId: elsewhere.user.id },
    );
    expect(assignee.status).toBe(422);
    expect(((await assignee.json()) as { error: string }).error).toBe(
      "invalid_assignee",
    );
    const after = await counts();
    expect(after.outbox).toHaveLength(before.outbox.length);
    expect(after.history).toHaveLength(before.history.length);
  });

  it("never echoes a refused multiselect value to the caller or the console", async () => {
    const { tableId } = await seedTable();
    await addColumn(tableId, "Audience", "multiselect", {
      options: ["Brokers", "Clients"],
    });
    const canary = `canary-${randomUUID()}`;
    const logged: string[] = [];
    for (const level of ["log", "warn", "error", "info"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(
          JSON.stringify(args, (_k, v) => (v instanceof Error ? v.message : v)),
        );
      });
    }
    const response = await addRow(tableId, {
      title: "Tip",
      values: { Audience: ["Brokers", canary] },
    });
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain(canary);
    expect(logged.join("\n")).not.toContain(canary);
  });

  it("revalidates a name-keyed save under the locks when a column is renamed meanwhile (RF-8)", async () => {
    const { tableId, col } = await seedTable();
    tableWriteHooks.afterPreCheck = async () => {
      await db
        .update(customFieldDefinitionTable)
        .set({ name: "Stage" })
        .where(eq(customFieldDefinitionTable.id, col.Status.id));
    };
    const response = await addRow(tableId, {
      title: "Tip",
      values: { Status: "Idea" },
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: string;
      columns: string[];
    };
    expect(body.error).toBe("unknown_column");
    expect(body.columns).toContain("Stage");
    const { outbox, history, tasks } = await counts();
    expect(tasks).toHaveLength(0);
    expect(outbox).toHaveLength(0);
    expect(history).toHaveLength(0);
  });

  it("refuses a missing requestId and an entry that is not in the table", async () => {
    const { tableId } = await seedTable();
    const missing = await json("POST", `/api/operon/tables/${tableId}/rows`, {
      title: "Tip",
    });
    expect(missing.status).toBe(422);
    const wrong = await json(
      "PATCH",
      `/api/operon/tables/${tableId}/rows/not-a-row`,
      { title: "x" },
    );
    expect(wrong.status).toBe(404);
    expect(((await wrong.json()) as { error: string }).error).toBe(
      "row_not_in_table",
    );
  });
});
