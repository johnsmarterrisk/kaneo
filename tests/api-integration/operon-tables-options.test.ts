import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Operon fork checks — Tables task 7 (docs/fork-discipline.md row 18, spec 7.3 step 3,
 * 7.3a, RF-3, RF-8): Topic Rename and Merge rewrite every affected row in one
 * transaction — one history row and one signal per row, one shared writeId — and an
 * admin's "New topic…" adds the option atomically with its row save.
 */
function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const WEBHOOK_SECRET = "tables-options-webhook-secret";
const received: { event: string; task?: { id: string } }[] = [];

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
    if (req.url === "/webhooks/kaneo") {
      received.push(JSON.parse(raw));
      res.writeHead(200);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
});
const platformPort = await listen(platform);
const BASE = `http://127.0.0.1:${platformPort}`;

setEnv("OPERON_INTERNAL_API_URL", BASE);
setEnv("KANEO_WEBHOOK_SECRET", WEBHOOK_SECRET);
setEnv("OPERON_KANEO_S2S_SECRET", "tables-options-s2s-secret");
setEnv("KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS", "true");

const { createApp } = await import("../../apps/api/src/index");
const { auth } = await import("../../apps/api/src/auth");
const { default: db } = await import("../../apps/api/src/database");
const { optionEditHooks } = await import(
  "../../apps/api/src/operon-tables/options"
);
const { tableOutboxHooks, drainTableOutbox } = await import(
  "../../apps/api/src/operon-tables/outbox"
);
const { tableWriteHooks } = await import(
  "../../apps/api/src/operon-tables/write-row"
);
const { mockAuthenticatedSession } = await import("./helpers/auth");
const { resetTestDatabase } = await import("./helpers/database");
const { createWorkspaceMember } = await import("./helpers/fixtures");
const {
  customFieldDefinitionTable,
  customFieldValueTable,
  integrationTable,
  operonTableRowOutboxTable,
  operonTableValueHistoryTable,
  userTable,
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

async function createTable(name: string) {
  const response = await json("POST", "/api/operon/tables", {
    workspaceId: owner.workspace.id,
    name,
    slug: name.slice(0, 4).toUpperCase(),
  });
  const id = ((await response.json()) as { id: string }).id;
  const defs = await db
    .select()
    .from(customFieldDefinitionTable)
    .where(eq(customFieldDefinitionTable.projectId, id));
  const col = Object.fromEntries(defs.map((d) => [d.name, d]));
  await db
    .update(customFieldDefinitionTable)
    .set({ options: ["Cyber", "Fraud", "Phishing"] })
    .where(eq(customFieldDefinitionTable.id, col.Topic.id));
  await db.insert(integrationTable).values({
    projectId: id,
    type: "generic-webhook",
    config: JSON.stringify({
      webhookUrl: `${BASE}/webhooks/kaneo`,
      secret: WEBHOOK_SECRET,
      events: { taskCreated: true, taskFieldsChanged: true, taskDeleted: true },
    }),
    isActive: true,
  });
  return { id, topic: col.Topic.id as string };
}

let owner: Awaited<ReturnType<typeof createWorkspaceMember>>;

async function addRow(tableId: string, topic: string | null, title = "Tip") {
  const response = await json("POST", `/api/operon/tables/${tableId}/rows`, {
    requestId: randomUUID(),
    title,
    values: topic === null ? {} : { Topic: topic },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { row: { rowId: string } }).row.rowId;
}

function options(
  tableId: string,
  fieldId: string,
  body: unknown,
  headers = {},
) {
  return json(
    "POST",
    `/api/operon/tables/${tableId}/fields/${fieldId}/options`,
    body,
    headers,
  );
}

async function topicOf(taskId: string, fieldId: string) {
  const [row] = await db
    .select({ value: customFieldValueTable.value })
    .from(customFieldValueTable)
    .where(
      and(
        eq(customFieldValueTable.taskId, taskId),
        eq(customFieldValueTable.fieldId, fieldId),
      ),
    );
  return row?.value ?? null;
}

async function topicOptions(fieldId: string) {
  const [def] = await db
    .select()
    .from(customFieldDefinitionTable)
    .where(eq(customFieldDefinitionTable.id, fieldId));
  return def.options as string[];
}

describe("API integration: Tables — topic rename, merge, new topic (task 7)", () => {
  let t: { id: string; topic: string };
  beforeEach(async () => {
    await resetTestDatabase();
    tableOutboxHooks.disableKick = true;
    optionEditHooks.afterRows = undefined;
    tableWriteHooks.afterProjectLock = undefined;
    received.length = 0;
    owner = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(owner.user);
    t = await createTable("Risk tips");
  });

  it("rename rewrites every row carrying the label, one history row and record each", async () => {
    const a = await addRow(t.id, "Cyber");
    const b = await addRow(t.id, "Cyber");
    const c = await addRow(t.id, "Fraud");
    await db.delete(operonTableRowOutboxTable);

    const response = await options(t.id, t.topic, {
      action: "rename",
      from: "Cyber",
      to: "Cyber risk",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rowsRewritten: 2 });
    expect(await topicOptions(t.topic)).toEqual([
      "Cyber risk",
      "Fraud",
      "Phishing",
    ]);
    expect(await topicOf(a, t.topic)).toBe("Cyber risk");
    expect(await topicOf(b, t.topic)).toBe("Cyber risk");
    expect(await topicOf(c, t.topic)).toBe("Fraud");

    const history = (
      await db.select().from(operonTableValueHistoryTable)
    ).filter((h) => h.reason === "topic_rename");
    expect(history.map((h) => h.taskId).sort()).toEqual([a, b].sort());
    expect(history.every((h) => h.oldValue === "Cyber")).toBe(true);
    const records = await db.select().from(operonTableRowOutboxTable);
    expect(records.map((r) => r.taskId).sort()).toEqual([a, b].sort());
    expect(
      records.every(
        (r) =>
          r.event === "task.fields_changed" &&
          (r.payload as { data: { reason: string } }).data.reason ===
            "topic_rename",
      ),
    ).toBe(true);
  });

  it("a merge over three rows is three records sharing one writeId and three deliveries (RF-3)", async () => {
    const rows = [
      await addRow(t.id, "Phishing"),
      await addRow(t.id, "Phishing"),
      await addRow(t.id, "Phishing"),
    ];
    await addRow(t.id, "Cyber");
    await db.delete(operonTableRowOutboxTable);

    const response = await options(t.id, t.topic, {
      action: "merge",
      from: "Phishing",
      into: "Cyber",
    });
    expect(response.status).toBe(200);
    expect(await topicOptions(t.topic)).toEqual(["Cyber", "Fraud"]);
    const records = await db.select().from(operonTableRowOutboxTable);
    expect(records).toHaveLength(3);
    expect(new Set(records.map((r) => r.writeId)).size).toBe(1);
    expect(new Set(records.map((r) => r.taskId))).toEqual(new Set(rows));

    await drainTableOutbox();
    const merged = received.filter((r) => r.event === "task.fields_changed");
    expect(merged.map((r) => r.task?.id).sort()).toEqual([...rows].sort());
    for (const row of rows) expect(await topicOf(row, t.topic)).toBe("Cyber");
  });

  it("a failure mid-merge leaves both options, every row and no record", async () => {
    const rows = [
      await addRow(t.id, "Phishing"),
      await addRow(t.id, "Phishing"),
    ];
    await db.delete(operonTableRowOutboxTable);
    const historyBefore = (await db.select().from(operonTableValueHistoryTable))
      .length;
    optionEditHooks.afterRows = async () => {
      throw new Error("injected");
    };
    const response = await options(t.id, t.topic, {
      action: "merge",
      from: "Phishing",
      into: "Cyber",
    });
    expect(response.status).toBe(500);
    expect(await topicOptions(t.topic)).toEqual(["Cyber", "Fraud", "Phishing"]);
    for (const row of rows)
      expect(await topicOf(row, t.topic)).toBe("Phishing");
    expect(await db.select().from(operonTableRowOutboxTable)).toHaveLength(0);
    expect((await db.select().from(operonTableValueHistoryTable)).length).toBe(
      historyBefore,
    );
  });

  it("a row save racing a merge waits on the definition lock and answers unknown_option (RF-8)", async () => {
    await addRow(t.id, "Phishing");
    const target = await addRow(t.id, "Fraud");
    let release: () => void = () => {};
    let paused: () => void = () => {};
    const isPaused = new Promise<void>((r) => {
      paused = r;
    });
    optionEditHooks.afterRows = () =>
      new Promise<void>((r) => {
        release = r;
        paused();
      });
    const merge = options(t.id, t.topic, {
      action: "merge",
      from: "Phishing",
      into: "Cyber",
    });
    await isPaused;
    optionEditHooks.afterRows = undefined;
    const save = json("PATCH", `/api/operon/tables/${t.id}/rows/${target}`, {
      values: { Topic: "Phishing" },
    });
    await new Promise((r) => setTimeout(r, 300));
    release();
    expect((await merge).status).toBe(200);
    const saved = await save;
    expect(saved.status).toBe(422);
    expect(await saved.json()).toMatchObject({
      error: "unknown_option",
      options: ["Cyber", "Fraud"],
    });
    expect(await topicOf(target, t.topic)).toBe("Fraud");
  });

  it("members and API keys cannot add, rename or merge; hidden and foreign fields are refused", async () => {
    const member = await addMember(owner.workspace.id, "member");
    mockAuthenticatedSession(member);
    for (const body of [
      { action: "add", label: "New" },
      { action: "rename", from: "Cyber", to: "C" },
      { action: "merge", from: "Cyber", into: "Fraud" },
    ]) {
      const response = await options(t.id, t.topic, body);
      expect(response.status).toBe(403);
    }
    mockAuthenticatedSession(owner.user);
    const key = await auth.api.createApiKey({
      body: { userId: owner.user.id, name: "owner-key" },
    });
    expect(
      (
        await options(
          t.id,
          t.topic,
          { action: "add", label: "X" },
          { "x-api-key": key.key },
        )
      ).status,
    ).toBe(403);

    const other = await createTable("Videos");
    const foreign = await options(t.id, other.topic, {
      action: "add",
      label: "X",
    });
    expect(foreign.status).toBe(422);
    expect(((await foreign.json()) as { error: string }).error).toBe(
      "unknown_column",
    );
    await json("DELETE", `/api/custom-field/${t.topic}`);
    const hidden = await options(t.id, t.topic, { action: "add", label: "X" });
    expect(hidden.status).toBe(422);
    expect(await topicOptions(t.topic)).toEqual(["Cyber", "Fraud", "Phishing"]);
  });

  it("an unknown option on save is 422 with the list, never added implicitly", async () => {
    const response = await json("POST", `/api/operon/tables/${t.id}/rows`, {
      requestId: randomUUID(),
      title: "Tip",
      values: { Topic: "Weather" },
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "unknown_option",
      column: "Topic",
      options: ["Cyber", "Fraud", "Phishing"],
    });
    expect(await topicOptions(t.topic)).toEqual(["Cyber", "Fraud", "Phishing"]);
  });

  it("an admin's New topic adds the option with the row; a member's is refused", async () => {
    const added = await json("POST", `/api/operon/tables/${t.id}/rows`, {
      requestId: randomUUID(),
      title: "Tip",
      values: { Topic: "Weather" },
      newTopic: { fieldId: t.topic, label: "Weather" },
    });
    expect(added.status).toBe(200);
    expect(await topicOptions(t.topic)).toEqual([
      "Cyber",
      "Fraud",
      "Phishing",
      "Weather",
    ]);

    const member = await addMember(owner.workspace.id, "member");
    mockAuthenticatedSession(member);
    const refused = await json("POST", `/api/operon/tables/${t.id}/rows`, {
      requestId: randomUUID(),
      title: "Tip",
      values: { Topic: "Storms" },
      newTopic: { fieldId: t.topic, label: "Storms" },
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "admin_only",
    );
    expect(await topicOptions(t.topic)).not.toContain("Storms");

    mockAuthenticatedSession(owner.user);
    const mismatch = await json("POST", `/api/operon/tables/${t.id}/rows`, {
      requestId: randomUUID(),
      title: "Tip",
      values: { Topic: "Cyber" },
      newTopic: { fieldId: t.topic, label: "Storms" },
    });
    expect(mismatch.status).toBe(422);
    expect(((await mismatch.json()) as { error: string }).error).toBe(
      "invalid_new_topic",
    );
  });

  it("two concurrent New topic saves of one label create one option, both rows carry it", async () => {
    const save = () =>
      json("POST", `/api/operon/tables/${t.id}/rows`, {
        requestId: randomUUID(),
        title: "Tip",
        values: { Topic: "Weather" },
        newTopic: { fieldId: t.topic, label: "Weather" },
      });
    const [a, b] = await Promise.all([save(), save()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const opts = await topicOptions(t.topic);
    expect(opts.filter((o) => o === "Weather")).toHaveLength(1);
    const values = await db
      .select({ value: customFieldValueTable.value })
      .from(customFieldValueTable)
      .where(eq(customFieldValueTable.fieldId, t.topic));
    expect(values.map((v) => v.value)).toEqual(["Weather", "Weather"]);
  });
});
