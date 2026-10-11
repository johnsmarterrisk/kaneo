import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
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
 * Operon fork checks — Tables task 5 (docs/fork-discipline.md row 18, spec 7.4, R-B, RF-1,
 * RF-2, RF-7, RF-10): the durable delivery. Records survive failures and restarts, go out
 * first-in-first-out per task with identical bytes on every attempt, only to the
 * provisioned destination with the provisioned secret, never before Operon acknowledged
 * the table, and are deleted only on a 2xx.
 */
function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const WEBHOOK_SECRET = "tables-outbox-webhook-secret";
const S2S_SECRET = "tables-outbox-s2s-secret";

type Received = {
  path: string;
  raw: string;
  signatureOk: boolean;
  body: { event: string; task?: { id: string }; project: { id: string } };
};
const received: Received[] = [];
/** Statuses to answer `/webhooks/kaneo` with, in order; 200 once exhausted. */
let statuses: number[] = [];

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
    if (req.url === "/webhooks/kaneo" || req.url === "/elsewhere") {
      received.push({
        path: req.url,
        raw,
        signatureOk:
          req.headers["x-kaneo-signature"] ===
          createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex"),
        body: JSON.parse(raw),
      });
      res.writeHead(
        req.url === "/webhooks/kaneo" ? (statuses.shift() ?? 200) : 200,
      );
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
});
const platformPort = await listen(platform);
const BASE = `http://127.0.0.1:${platformPort}`;
const DESTINATION = `${BASE}/webhooks/kaneo`;

setEnv("OPERON_INTERNAL_API_URL", BASE);
setEnv("KANEO_WEBHOOK_SECRET", WEBHOOK_SECRET);
setEnv("OPERON_KANEO_S2S_SECRET", S2S_SECRET);
setEnv("KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS", "true");

const { createApp } = await import("../../apps/api/src/index");
const { default: db } = await import("../../apps/api/src/database");
const outbox = await import("../../apps/api/src/operon-tables/outbox");
const { tableOutboxHooks, drainTableOutbox, backoffSeconds } = outbox;
const { mockAuthenticatedSession } = await import("./helpers/auth");
const { resetTestDatabase } = await import("./helpers/database");
const { createProjectFixture, createWorkspaceMember } = await import(
  "./helpers/fixtures"
);
const {
  integrationTable,
  operonTableProjectTable,
  operonTableRowOutboxTable,
  userTable,
  workspaceUserTable,
} = await import("../../apps/api/src/database/schema");

const { initializePlugins } = await import("../../apps/api/src/plugins");

const { app } = createApp();
// The server's boot registers the plugins; createApp does not. With them on, a table row's
// published `task.created` reaches the generic-webhook handler, which must skip it.
initializePlugins();

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

const ALL_ON = {
  taskCreated: true,
  taskStatusChanged: true,
  taskDeleted: true,
  taskFieldsChanged: true,
};

async function provision(projectId: string, overrides = {}) {
  await db.insert(integrationTable).values({
    projectId,
    type: "generic-webhook",
    config: JSON.stringify({
      webhookUrl: DESTINATION,
      secret: WEBHOOK_SECRET,
      events: ALL_ON,
      ...overrides,
    }),
    isActive: true,
  });
}

async function seedTable(withWebhook = true) {
  const owner = await createWorkspaceMember({ role: "owner" });
  mockAuthenticatedSession(owner.user);
  const response = await json("POST", "/api/operon/tables", {
    workspaceId: owner.workspace.id,
    name: "Risk tips",
    slug: `R${randomUUID().slice(0, 4)}`,
  });
  expect(response.status).toBe(200);
  const { id } = (await response.json()) as { id: string };
  if (withWebhook) await provision(id);
  return { owner, tableId: id };
}

async function addRow(tableId: string, title = "Tip") {
  const response = await json("POST", `/api/operon/tables/${tableId}/rows`, {
    requestId: randomUUID(),
    title,
    values: { Status: "Idea" },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { row: { rowId: string } }).row.rowId;
}

async function pending() {
  return db
    .select()
    .from(operonTableRowOutboxTable)
    .orderBy(operonTableRowOutboxTable.id);
}

async function makeDue() {
  await db
    .update(operonTableRowOutboxTable)
    .set({ nextAttemptAt: sql`now() - interval '1 second'` });
}

function rows() {
  return received.filter((r) => r.body.event !== "project.created");
}

function captureLogs() {
  const lines: string[] = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(JSON.stringify(args));
    });
  }
  return lines;
}

describe("API integration: Tables — durable delivery (task 5)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    tableOutboxHooks.disableKick = true;
    received.length = 0;
    statuses = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries a failing sink and delivers each record once, byte-identical every attempt", async () => {
    const { tableId } = await seedTable();
    const rowId = await addRow(tableId);
    statuses = [500, 503, 500];

    for (let pass = 0; pass < 6 && (await pending()).length > 0; pass += 1) {
      await drainTableOutbox();
      await makeDue();
    }
    expect(await pending()).toHaveLength(0);

    const created = rows().filter((r) => r.body.event === "task.created");
    const changed = rows().filter(
      (r) => r.body.event === "task.fields_changed",
    );
    // Three failed attempts then a 2xx for the first record; the second waits behind it.
    expect(created).toHaveLength(4);
    expect(new Set(created.map((r) => r.raw)).size).toBe(1);
    expect(changed).toHaveLength(1);
    expect(created[0].body.task?.id).toBe(rowId);
    expect(
      rows().every((r) => r.signatureOk && r.path === "/webhooks/kaneo"),
    ).toBe(true);
    const order = rows().map((r) => r.body.event);
    expect(order.lastIndexOf("task.created")).toBeLessThan(
      order.indexOf("task.fields_changed"),
    );
  });

  it("records the status and backs off on the ladder, never giving up", async () => {
    const { tableId } = await seedTable();
    await addRow(tableId);
    statuses = [500];
    await drainTableOutbox();
    const [first] = await pending();
    expect(first.attempts).toBe(1);
    expect(first.lastStatus).toBe(500);
    expect(first.lastErrorClass).toBe("http_500");
    expect([1, 2, 3, 4, 5, 40].map(backoffSeconds)).toEqual([
      5, 15, 60, 300, 900, 900,
    ]);
  });

  it("keeps a record Operon answers 422 pending and retries it (RF-2)", async () => {
    const { tableId } = await seedTable();
    await addRow(tableId);
    statuses = [422];
    await drainTableOutbox();
    const [record] = await pending();
    expect(record.lastStatus).toBe(422);
    expect(record.event).toBe("task.created");
    await makeDue();
    await drainTableOutbox();
    await makeDue();
    await drainTableOutbox();
    expect(await pending()).toHaveLength(0);
  });

  it("a fresh drain module instance delivers records written before it existed", async () => {
    const { tableId } = await seedTable();
    await addRow(tableId);
    vi.resetModules();
    const fresh = await import("../../apps/api/src/operon-tables/outbox");
    await fresh.drainTableOutbox();
    await fresh.drainTableOutbox();
    expect(rows().map((r) => r.body.event)).toEqual([
      "task.created",
      "task.fields_changed",
    ]);
    expect(await pending()).toHaveLength(0);
  });

  it("holds a later record of a task while the older one fails (FIFO per task)", async () => {
    const { tableId } = await seedTable();
    const rowId = await addRow(tableId);
    await json("PATCH", `/api/operon/tables/${tableId}/rows/${rowId}`, {
      values: { Status: "Published" },
    });
    const other = await addRow(tableId, "Other");
    statuses = [500];
    await drainTableOutbox();
    // The first task's created record failed: nothing else of that task went out, while
    // the other task's records did.
    expect(
      rows()
        .filter((r) => r.body.task?.id === rowId)
        .map((r) => r.body.event),
    ).toEqual(["task.created"]);
    expect(rows().filter((r) => r.body.task?.id === other)).toHaveLength(2);
    await makeDue();
    await drainTableOutbox();
    expect(
      rows()
        .filter((r) => r.body.task?.id === rowId)
        .map((r) => r.body.event),
    ).toEqual([
      "task.created",
      "task.created",
      "task.fields_changed",
      "task.fields_changed",
    ]);
  });

  it("keeps the records of a table without a webhook and reports them in outbox-health", async () => {
    const { owner, tableId } = await seedTable(false);
    await addRow(tableId);
    await drainTableOutbox();
    expect(rows()).toHaveLength(0);
    expect(await pending()).toHaveLength(2);
    const health = await json(
      "GET",
      `/api/operon/tables/outbox-health?workspaceId=${owner.workspace.id}`,
    );
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      pending: 2,
      oldestAttempts: 0,
    });
  });

  it("the generic-webhook handlers send nothing for a table, everything for a project", async () => {
    const { owner, tableId } = await seedTable();
    await addRow(tableId);
    const { project } = await createProjectFixture({
      workspaceId: owner.workspace.id,
    });
    await provision(project.id);
    const ordinary = await json("POST", `/api/task/${project.id}`, {
      title: "Plain task",
      description: "",
      status: "to-do",
      priority: "low",
    });
    expect(ordinary.status).toBe(200);
    const until = Date.now() + 3000;
    while (Date.now() < until && rows().length === 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(rows().map((r) => r.body.project.id)).toEqual([project.id]);
  });

  it("posts only to the provisioned destination with the provisioned secret (RF-1)", async () => {
    const { tableId } = await seedTable();
    await addRow(tableId);
    const logs = captureLogs();
    const moved = await json(
      "PATCH",
      `/api/generic-webhook-integration/project/${tableId}`,
      { webhookUrl: `${BASE}/elsewhere` },
    );
    expect(moved.status).toBe(200);
    await drainTableOutbox();
    expect(rows()).toHaveLength(0);
    expect(await pending()).toHaveLength(2);
    const joined = logs.join("\n");
    expect(joined).toContain("tables.outbox.destination_mismatch");
    expect(joined).not.toContain("/elsewhere");

    await json("PATCH", `/api/generic-webhook-integration/project/${tableId}`, {
      webhookUrl: DESTINATION,
      secret: "someone-elses-secret",
    });
    await makeDue();
    await drainTableOutbox();
    expect(rows()).toHaveLength(0);

    await json("PATCH", `/api/generic-webhook-integration/project/${tableId}`, {
      secret: WEBHOOK_SECRET,
    });
    await makeDue();
    await drainTableOutbox();
    expect(rows().map((r) => [r.path, r.body.event])).toEqual([
      ["/webhooks/kaneo", "task.created"],
      ["/webhooks/kaneo", "task.fields_changed"],
    ]);
  });

  it("posts nothing when the destination or the secret is not configured", async () => {
    const { tableId } = await seedTable();
    await addRow(tableId);
    for (const key of ["OPERON_INTERNAL_API_URL", "KANEO_WEBHOOK_SECRET"]) {
      const saved = process.env[key];
      setEnv(key, undefined);
      try {
        await makeDue();
        await drainTableOutbox();
      } finally {
        setEnv(key, saved);
      }
      expect(rows()).toHaveLength(0);
      expect(await pending()).toHaveLength(2);
    }
  });

  it("re-announces an unacknowledged table and delivers its rows only afterwards (RF-7)", async () => {
    const { tableId } = await seedTable();
    received.length = 0;
    await db
      .update(operonTableProjectTable)
      .set({ announcedAt: null })
      .where(eq(operonTableProjectTable.projectId, tableId));
    await addRow(tableId);

    await drainTableOutbox();
    const until = Date.now() + 3000;
    let flag = null as Date | null;
    while (Date.now() < until && !flag) {
      [{ announcedAt: flag }] = await db
        .select({ announcedAt: operonTableProjectTable.announcedAt })
        .from(operonTableProjectTable)
        .where(eq(operonTableProjectTable.projectId, tableId));
      if (!flag) await new Promise((r) => setTimeout(r, 25));
    }
    expect(flag).not.toBeNull();
    expect(received.map((r) => r.body.event)).toEqual(["project.created"]);

    await makeDue();
    await drainTableOutbox();
    await drainTableOutbox();
    expect(received.map((r) => r.body.event)).toEqual([
      "project.created",
      "task.created",
      "task.fields_changed",
    ]);
  });

  it("scopes outbox-health to one workspace's table admin (RF-10)", async () => {
    const a = await seedTable(false);
    const b = await seedTable(false);
    mockAuthenticatedSession(b.owner.user);
    await addRow(b.tableId);
    await db
      .update(operonTableRowOutboxTable)
      .set({ attempts: 7, lastErrorClass: "http_500" });

    mockAuthenticatedSession(a.owner.user);
    const own = await json(
      "GET",
      `/api/operon/tables/outbox-health?workspaceId=${a.owner.workspace.id}`,
    );
    expect(await own.json()).toEqual({
      pending: 0,
      oldestPendingSeconds: 0,
      oldestAttempts: 0,
      lastErrorClass: null,
    });
    const foreign = await json(
      "GET",
      `/api/operon/tables/outbox-health?workspaceId=${b.owner.workspace.id}`,
    );
    expect(foreign.status).toBe(403);

    const [member] = await db
      .insert(userTable)
      .values({
        id: `user-${randomUUID()}`,
        email: `${randomUUID()}@example.com`,
        emailVerified: true,
        name: "Member",
      })
      .returning();
    await db.insert(workspaceUserTable).values({
      workspaceId: b.owner.workspace.id,
      userId: member.id,
      role: "member",
      joinedAt: new Date(),
    });
    mockAuthenticatedSession(member);
    const refused = await json(
      "GET",
      `/api/operon/tables/outbox-health?workspaceId=${b.owner.workspace.id}`,
    );
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "admin_only",
    );
  });

  it("raises the stall alert with counts only when the oldest record passes 15 minutes", async () => {
    const { tableId } = await seedTable(false);
    await addRow(tableId, "Secret title canary");
    await db
      .update(operonTableRowOutboxTable)
      .set({ createdAt: sql`now() - interval '20 minutes'` });
    const logs = captureLogs();
    const alerts: unknown[] = [];
    tableOutboxHooks.alert = (message, extra) => alerts.push([message, extra]);
    try {
      await drainTableOutbox();
      await drainTableOutbox();
    } finally {
      tableOutboxHooks.alert = undefined;
    }
    expect(logs.join("\n")).toContain("tables.outbox.stalled");
    expect(logs.join("\n")).not.toContain("canary");
    // Once per 15 minutes while it stays stalled, counts only.
    expect(alerts).toEqual([
      [
        "tables.outbox.stalled",
        { pending: 2, oldestPendingSeconds: expect.any(Number) },
      ],
    ]);
  });
});
