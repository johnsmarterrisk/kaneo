import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Operon fork checks — Tables task 12 (docs/fork-discipline.md row 18, spec 7.8, 7.3 step 2,
 * R-C, RF-6): the five MCP table tools, driven through the REAL hosted MCP server with a
 * REAL Operon agent key minted by `POST /api/internal/operon/agent-key` (never an owner
 * key, never a mocked session), and the request tombstone that makes an agent's add safe to
 * retry — including after the row it made was deleted.
 *
 * The MCP tools call the REST API over KANEO_INTERNAL_API_URL, read at import, so the app
 * is served on a real port reserved before the import (as `operon-agent-key.test.ts` does).
 * A local server stands in for Operon: the agent-liveness authority answering exactly
 * `{"active":true}` and `/webhooks/kaneo` for the table's announcement.
 */
function setEnv(key: string, value: string) {
  process.env[key] = value;
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
    if (req.url === "/webhooks/kaneo") {
      res.writeHead(200);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
});
const platformPort = await listen(platform);

const reserve = http.createServer();
const appPort = await listen(reserve);
await new Promise((resolve) => reserve.close(resolve));

setEnv("OPERON_OIDC_ONLY", "true");
setEnv("OPERON_INTERNAL_API_URL", `http://127.0.0.1:${platformPort}`);
setEnv("OPERON_KANEO_S2S_SECRET", "tables-mcp-s2s-secret");
setEnv("KANEO_WEBHOOK_SECRET", "tables-mcp-webhook-secret");
setEnv("KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS", "true");
setEnv("KANEO_INTERNAL_API_URL", `http://127.0.0.1:${appPort}`);

const { createApp } = await import("../../apps/api/src/index");
const { auth } = await import("../../apps/api/src/auth");
const { default: db, schema } = await import("../../apps/api/src/database");
const { resetTestDatabase } = await import("./helpers/database");
const { createWorkspaceMember } = await import("./helpers/fixtures");
const { operonTableRequestTable, operonTableValueHistoryTable } = await import(
  "../../apps/api/src/database/schema"
);
const { tableOutboxHooks } = await import(
  "../../apps/api/src/operon-tables/outbox"
);
const { tableWriteHooks } = await import(
  "../../apps/api/src/operon-tables/write-row"
);

const { app } = createApp();
const server = serve({
  fetch: app.fetch,
  port: appPort,
  hostname: "127.0.0.1",
});
// Delivery is not under test here; the drain is driven by the outbox suite.
tableOutboxHooks.disableKick = true;

afterAll(() => {
  server.close();
  platform.close();
});

type Owner = Awaited<ReturnType<typeof createWorkspaceMember>>;
let owner: Owner;
let ownerCookie: string;
let serviceKey: string;

/** A real Better Auth session row, presented as its signed cookie. */
async function sessionCookie(userId: string) {
  const token = `tok-${randomUUID()}`;
  await db.insert(schema.sessionTable).values({
    id: `session-${randomUUID()}`,
    token,
    userId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const signature = createHmac("sha256", process.env.AUTH_SECRET ?? "")
    .update(token)
    .digest("base64");
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

function rest(method: string, path: string, cookie: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** An Operon-managed plain member of `workspaceId` (the `custom` account row marks it). */
async function newAgentUser(workspaceId: string, name: string) {
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: `user-${randomUUID()}`,
      email: `agent-${randomUUID()}@example.com`,
      emailVerified: true,
      name,
    })
    .returning();
  await db.insert(schema.workspaceUserTable).values({
    workspaceId,
    userId: user.id,
    role: "member",
    joinedAt: new Date(),
  });
  await db.insert(schema.accountTable).values({
    accountId: randomUUID().replace(/-/g, "").padEnd(64, "0"),
    providerId: "custom",
    userId: user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return user;
}

/** The production mint path: Operon's service key asks for the agent's own key. */
async function mintAgentKey(userId: string) {
  const response = await app.request("/api/internal/operon/agent-key", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": serviceKey },
    body: JSON.stringify({ kaneoUserId: userId }),
  });
  expect(response.status).toBe(200);
  const { key } = (await response.json()) as { key: string };
  expect(key.startsWith("operon_agt_")).toBe(true);
  return key;
}

const ACCEPT = "application/json, text/event-stream";

async function rpc(response: Response) {
  const text = await response.text();
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice(6);
  return JSON.parse(data ?? text);
}

/** One MCP session over the hosted endpoint, as an agent's SDK client opens it. */
async function mcpClient(key: string) {
  let id = 0;
  const post = (body: object, sessionId?: string) =>
    app.request("/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: ACCEPT,
        authorization: `Bearer ${key}`,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
  const init = await post({
    jsonrpc: "2.0",
    id: ++id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tables-mcp-suite", version: "1.0.0" },
    },
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get("mcp-session-id") ?? "";
  await rpc(init);
  return {
    async list(): Promise<string[]> {
      const answer = await rpc(
        await post(
          { jsonrpc: "2.0", id: ++id, method: "tools/list" },
          sessionId,
        ),
      );
      return answer.result.tools.map((t: { name: string }) => t.name);
    },
    /** The tool's JSON answer, and whether the tool reported an error. */
    async call(name: string, args: object) {
      const answer = await rpc(
        await post(
          {
            jsonrpc: "2.0",
            id: ++id,
            method: "tools/call",
            params: { name, arguments: args },
          },
          sessionId,
        ),
      );
      const text = answer.result.content[0].text as string;
      return {
        isError: answer.result.isError === true,
        text,
        // biome-ignore lint/suspicious/noExplicitAny: a tool's JSON answer, asserted below.
        body: JSON.parse(text) as any,
      };
    },
  };
}

async function createTable(cookie: string, workspaceId: string, name: string) {
  const created = await rest("POST", "/api/operon/tables", cookie, {
    workspaceId,
    name,
    slug: name.slice(0, 4).toUpperCase(),
  });
  expect(created.status).toBe(200);
  const { id } = (await created.json()) as { id: string };
  const defs = await db
    .select()
    .from(schema.customFieldDefinitionTable)
    .where(eq(schema.customFieldDefinitionTable.projectId, id));
  const col = Object.fromEntries(defs.map((d) => [d.name, d]));
  // Topic has no options in the template; give it two directly.
  await db
    .update(schema.customFieldDefinitionTable)
    .set({ options: ["Cyber", "Fraud"] })
    .where(eq(schema.customFieldDefinitionTable.id, col.Topic.id));
  return { tableId: id, col };
}

async function rowsOf(tableId: string) {
  return db
    .select({ id: schema.taskTable.id, title: schema.taskTable.title })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.projectId, tableId));
}

let agent: typeof schema.userTable.$inferSelect;
let agentKey: string;
let table: Awaited<ReturnType<typeof createTable>>;

beforeEach(async () => {
  await resetTestDatabase();
  owner = await createWorkspaceMember({ role: "owner", userName: "Olive" });
  ownerCookie = await sessionCookie(owner.user.id);
  const created = await auth.api.createApiKey({
    body: {
      userId: owner.user.id,
      name: "operon-service",
      permissions: {
        workspace: ["manage_settings"],
        task: ["create", "update"],
        operon: ["rekey"],
      },
      metadata: { operonService: true },
    },
  });
  serviceKey = created.key;
  agent = await newAgentUser(owner.workspace.id, "Tables Agent");
  agentKey = await mintAgentKey(agent.id);
  table = await createTable(ownerCookie, owner.workspace.id, "Risk tips");
});

const entry = (requestId: string, extra: Record<string, unknown> = {}) => ({
  tableId: table.tableId,
  requestId,
  title: "Phishing explainer",
  notes: "A short video about phishing lures",
  values: { Topic: "Cyber", Status: "Idea" },
  ...extra,
});

describe("the table tools over the hosted MCP endpoint, with an agent key", () => {
  it("lists the five tools, the table and its active columns", async () => {
    const mcp = await mcpClient(agentKey);
    expect(await mcp.list()).toEqual(
      expect.arrayContaining([
        "list_tables",
        "get_table_columns",
        "search_table_rows",
        "add_table_row",
        "update_table_row",
      ]),
    );
    await mcp.call("add_table_row", entry("list-1"));
    const listed = await mcp.call("list_tables", {
      workspaceId: owner.workspace.id,
    });
    expect(listed.isError).toBe(false);
    expect(listed.body.tables).toEqual([
      {
        tableId: table.tableId,
        name: "Risk tips",
        entryCount: 1,
        columns: ["Topic", "Status", "Posted", "Channel", "Link"],
      },
    ]);
  });

  it("answers the columns and a JSON Schema with the CURRENT options; a hidden column is absent", async () => {
    const mcp = await mcpClient(agentKey);
    const first = await mcp.call("get_table_columns", {
      tableId: table.tableId,
    });
    expect(first.isError).toBe(false);
    const topic = first.body.columns.find(
      (c: { name: string }) => c.name === "Topic",
    );
    expect(topic).toMatchObject({
      kind: "dropdown",
      options: ["Cyber", "Fraud"],
    });
    expect(
      first.body.jsonSchema.properties.values.properties.Topic.anyOf[0].enum,
    ).toEqual(["Cyber", "Fraud"]);
    // Codex round 1, finding 6: the published Link schema is http(s) only, as the writer.
    const link =
      first.body.jsonSchema.properties.values.properties.Link.anyOf[0];
    const linkPattern = new RegExp(link.pattern);
    expect(linkPattern.test("https://example.com/a")).toBe(true);
    expect(linkPattern.test("ftp://example.com/a")).toBe(false);
    expect(linkPattern.test("javascript:alert(1)")).toBe(false);

    await db
      .update(schema.customFieldDefinitionTable)
      .set({ options: ["Cyber", "Fraud", "Payments"] })
      .where(eq(schema.customFieldDefinitionTable.id, table.col.Topic.id));
    const hide = await rest(
      "DELETE",
      `/api/custom-field/${table.col.Channel.id}`,
      ownerCookie,
    );
    expect(hide.status).toBe(200);

    const second = await mcp.call("get_table_columns", {
      tableId: table.tableId,
    });
    expect(
      second.body.jsonSchema.properties.values.properties.Topic.anyOf[0].enum,
    ).toEqual(["Cyber", "Fraud", "Payments"]);
    expect(second.text).not.toContain("Channel");
    expect(
      second.body.columns.map((c: { name: string }) => c.name),
    ).not.toContain("Channel");

    const ordinary = await mcp.call("get_table_columns", {
      tableId: owner.workspace.id,
    });
    expect(ordinary.isError).toBe(true);
  });

  it("adds a row Made by the calling agent, and a retry answers the same row", async () => {
    const mcp = await mcpClient(agentKey);
    const added = await mcp.call("add_table_row", entry("req-1"));
    expect(added.isError).toBe(false);
    expect(added.body.replayed).toBe(false);
    expect(added.body.row.madeBy).toEqual({
      id: agent.id,
      name: "Tables Agent",
    });
    expect(added.body.row.values).toMatchObject({
      Topic: "Cyber",
      Status: "Idea",
    });

    const again = await mcp.call("add_table_row", entry("req-1"));
    expect(again.body.replayed).toBe(true);
    expect(again.body.row.rowId).toBe(added.body.row.rowId);
    expect(await rowsOf(table.tableId)).toHaveLength(1);
  });

  it("refuses the same requestId with a changed payload: 409 and no row data", async () => {
    const mcp = await mcpClient(agentKey);
    const added = await mcp.call("add_table_row", entry("req-2"));
    const changed = await mcp.call(
      "add_table_row",
      entry("req-2", { title: "A different entry" }),
    );
    expect(changed.isError).toBe(true);
    expect(changed.body).toMatchObject({
      status: 409,
      error: "request_conflict",
    });
    expect(changed.body.row).toBeUndefined();
    expect(changed.text).not.toContain(added.body.row.rowId);
    expect(changed.text).not.toContain("Phishing");
    expect(await rowsOf(table.tableId)).toHaveLength(1);
  });

  it("keeps another agent's and another table's same requestId separate, never returning the first row", async () => {
    const mcp = await mcpClient(agentKey);
    const first = await mcp.call("add_table_row", entry("shared-id"));

    const other = await newAgentUser(owner.workspace.id, "Other Agent");
    const otherMcp = await mcpClient(await mintAgentKey(other.id));
    const theirs = await otherMcp.call("add_table_row", entry("shared-id"));
    expect(theirs.body.replayed).toBe(false);
    expect(theirs.body.row.rowId).not.toBe(first.body.row.rowId);
    expect(theirs.body.row.madeBy.id).toBe(other.id);

    const second = await createTable(
      ownerCookie,
      owner.workspace.id,
      "Roadmap",
    );
    const elsewhere = await mcp.call(
      "add_table_row",
      entry("shared-id", { tableId: second.tableId }),
    );
    expect(elsewhere.body.replayed).toBe(false);
    expect(elsewhere.body.row.tableId).toBe(second.tableId);
    expect(await rowsOf(table.tableId)).toHaveLength(2);
    expect(await rowsOf(second.tableId)).toHaveLength(1);
  });

  it("creates ONE row for two concurrent adds with one requestId", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived = 0;
    // Both adds pass the tombstone lookup (empty) before either commits.
    tableWriteHooks.afterPreCheck = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await gate;
    };
    try {
      const [a, b] = await Promise.all([
        (await mcpClient(agentKey)).call("add_table_row", entry("race-1")),
        (await mcpClient(agentKey)).call("add_table_row", entry("race-1")),
      ]);
      expect(a.isError).toBe(false);
      expect(b.isError).toBe(false);
      expect(a.body.row.rowId).toBe(b.body.row.rowId);
      expect([a.body.replayed, b.body.replayed].sort()).toEqual([false, true]);
    } finally {
      tableWriteHooks.afterPreCheck = undefined;
    }
    expect(await rowsOf(table.tableId)).toHaveLength(1);
  });

  it("still replays a retry after a column it named was hidden", async () => {
    const mcp = await mcpClient(agentKey);
    const body = entry("hide-1", {
      values: { Topic: "Cyber", Channel: "LinkedIn" },
    });
    const added = await mcp.call("add_table_row", body);
    expect(added.isError).toBe(false);
    const hide = await rest(
      "DELETE",
      `/api/custom-field/${table.col.Channel.id}`,
      ownerCookie,
    );
    expect(hide.status).toBe(200);
    const again = await mcp.call("add_table_row", body);
    expect(again.isError).toBe(false);
    expect(again.body).toMatchObject({ replayed: true });
    expect(again.body.row.rowId).toBe(added.body.row.rowId);
  });

  it("answers a retry after the row's delete with the original id and deleted: true, never a new row (RF-6)", async () => {
    const mcp = await mcpClient(agentKey);
    const added = await mcp.call("add_table_row", entry("del-1"));
    const rowId = added.body.row.rowId as string;
    const deleted = await rest(
      "DELETE",
      `/api/operon/tables/${table.tableId}/rows/${rowId}`,
      ownerCookie,
    );
    expect(deleted.status).toBe(200);

    const again = await mcp.call("add_table_row", entry("del-1"));
    expect(again.isError).toBe(false);
    expect(again.body).toEqual({
      row: { rowId, tableId: table.tableId },
      replayed: true,
      deleted: true,
    });
    expect(await rowsOf(table.tableId)).toHaveLength(0);

    const changed = await mcp.call(
      "add_table_row",
      entry("del-1", { title: "Something else" }),
    );
    expect(changed.body).toMatchObject({
      status: 409,
      error: "request_conflict",
    });
    expect(await rowsOf(table.tableId)).toHaveLength(0);
    const tombstones = await db
      .select()
      .from(operonTableRequestTable)
      .where(eq(operonTableRequestTable.taskId, rowId));
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses an unknown or hidden column with the active names, and an unknown option with the list", async () => {
    const hide = await rest(
      "DELETE",
      `/api/custom-field/${table.col.Channel.id}`,
      ownerCookie,
    );
    expect(hide.status).toBe(200);
    const mcp = await mcpClient(agentKey);
    for (const key of ["Budget", "Channel"]) {
      const refused = await mcp.call(
        "add_table_row",
        entry(`col-${key}`, { values: { [key]: "LinkedIn" } }),
      );
      expect(refused.isError).toBe(true);
      expect(refused.body).toMatchObject({
        status: 422,
        error: "unknown_column",
        columns: ["Topic", "Status", "Posted", "Link"],
      });
    }
    const option = await mcp.call(
      "add_table_row",
      entry("opt-1", { values: { Topic: "Weather" } }),
    );
    expect(option.body).toMatchObject({
      status: 422,
      error: "unknown_option",
      column: "Topic",
      options: ["Cyber", "Fraud"],
    });
    expect(option.text).not.toContain("Weather");
    expect(await rowsOf(table.tableId)).toHaveLength(0);
  });

  it("updates a row through the atomic route and refuses a row of another table", async () => {
    const mcp = await mcpClient(agentKey);
    const added = await mcp.call("add_table_row", entry("upd-1"));
    const rowId = added.body.row.rowId as string;
    const updated = await mcp.call("update_table_row", {
      tableId: table.tableId,
      rowId,
      values: { Status: "Published" },
    });
    expect(updated.isError).toBe(false);
    expect(updated.body.row.values.Status).toBe("Published");
    expect(updated.body.row.madeBy.id).toBe(agent.id);
    const history = await db
      .select()
      .from(operonTableValueHistoryTable)
      .where(
        and(
          eq(operonTableValueHistoryTable.taskId, rowId),
          eq(operonTableValueHistoryTable.fieldId, table.col.Status.id),
        ),
      );
    expect(history.map((h) => h.newValue)).toEqual(["Idea", "Published"]);

    const second = await createTable(
      ownerCookie,
      owner.workspace.id,
      "Roadmap",
    );
    const wrong = await mcp.call("update_table_row", {
      tableId: second.tableId,
      rowId,
      values: { Status: "Idea" },
    });
    expect(wrong.body).toMatchObject({
      status: 404,
      error: "row_not_in_table",
    });
  });

  it("pages search and never reaches a workspace the agent is not a member of", async () => {
    const mcp = await mcpClient(agentKey);
    for (const n of [1, 2, 3]) {
      await mcp.call(
        "add_table_row",
        entry(`s-${n}`, { title: `Lure ${n}`, notes: "about zebrafish" }),
      );
    }
    const first = await mcp.call("search_table_rows", {
      workspaceId: owner.workspace.id,
      query: "zebrafish",
      limit: 2,
    });
    expect(first.body.rows).toHaveLength(2);
    expect(first.body.rows[0]).toMatchObject({
      tableId: table.tableId,
      tableName: "Risk tips",
      madeBy: { id: agent.id },
    });
    const rest2 = await mcp.call("search_table_rows", {
      workspaceId: owner.workspace.id,
      query: "zebrafish",
      limit: 2,
      cursor: first.body.nextCursor,
    });
    expect(rest2.body.rows).toHaveLength(1);
    expect(rest2.body.nextCursor).toBeNull();

    // Another workspace, with a table holding the same word.
    const stranger = await createWorkspaceMember({ role: "owner" });
    const strangerCookie = await sessionCookie(stranger.user.id);
    const foreign = await createTable(
      strangerCookie,
      stranger.workspace.id,
      "Secret",
    );
    const foreignAdd = await rest(
      "POST",
      `/api/operon/tables/${foreign.tableId}/rows`,
      strangerCookie,
      { requestId: "f-1", title: "zebrafish secret", values: {} },
    );
    expect(foreignAdd.status).toBe(200);

    const mine = await mcp.call("search_table_rows", {
      workspaceId: owner.workspace.id,
      query: "zebrafish",
    });
    expect(mine.body.rows).toHaveLength(3);
    expect(mine.text).not.toContain("secret");
    const theirs = await mcp.call("search_table_rows", {
      workspaceId: stranger.workspace.id,
      query: "zebrafish",
    });
    expect(theirs.isError).toBe(true);
    expect(theirs.text).not.toContain("zebrafish secret");
    const crossTable = await mcp.call("search_table_rows", {
      workspaceId: owner.workspace.id,
      query: "zebrafish",
      tableId: foreign.tableId,
    });
    expect(crossTable.body).toMatchObject({
      status: 404,
      error: "not_a_table",
    });
    const listForeign = await mcp.call("list_tables", {
      workspaceId: stranger.workspace.id,
    });
    expect(listForeign.isError).toBe(true);
    expect(listForeign.text).not.toContain("Secret");
  });
});
