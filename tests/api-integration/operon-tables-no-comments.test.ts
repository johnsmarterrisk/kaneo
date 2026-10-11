import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Operon fork checks — Tables task 9 (docs/fork-discipline.md row 18, spec 7.5 / R-E): a
 * table row has no comments and no relations. Comment create/update/delete (both the
 * /comment and the /activity/comment routes) and a relation with a row at either end are
 * refused over REST and through the real MCP tools; the comment and relation reads of a row
 * answer an empty list even over dirty data; a move into a table is refused; the row read
 * answers the panel's shape and 404 `not_a_table_row` for an ordinary task.
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
setEnv("KANEO_WEBHOOK_SECRET", "tables-re-webhook-secret");
setEnv("OPERON_KANEO_S2S_SECRET", "tables-re-s2s-secret");
setEnv("KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS", "true");

const { createApp } = await import("../../apps/api/src/index");
const { default: db } = await import("../../apps/api/src/database");
const { tableOutboxHooks } = await import(
  "../../apps/api/src/operon-tables/outbox"
);
const { registerMcpTools, toMcpToolRegistrar } = await import(
  "../../apps/api/src/mcp/tools"
);
const { mockAuthenticatedSession } = await import("./helpers/auth");
const { resetTestDatabase } = await import("./helpers/database");
const { createProjectFixture, createWorkspaceMember } = await import(
  "./helpers/fixtures"
);
const { activityTable, taskRelationTable, taskTable } = await import(
  "../../apps/api/src/database/schema"
);

const { app } = createApp();

// The MCP tools call the API over fetch with the caller's bearer (F12); route this
// fake origin into the app so the real tool code runs against the real routes.
const MCP_BASE = "http://tables-mcp.test";
const realFetch = globalThis.fetch;
vi.stubGlobal(
  "fetch",
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith(MCP_BASE)) {
      return Promise.resolve(app.request(url.slice(MCP_BASE.length), init));
    }
    return realFetch(input, init);
  },
);

afterAll(() => {
  platform.close();
  vi.unstubAllGlobals();
});

function json(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function expectRefused(res: Response, reason: string) {
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe(reason);
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
    title: "MFA tip",
    values: { Status: "Idea" },
  });
  const rowId = ((await added.json()) as { row: { rowId: string } }).row.rowId;
  const { project } = await createProjectFixture({
    workspaceId: owner.workspace.id,
  });
  const [task] = await db
    .insert(taskTable)
    .values({ projectId: project.id, title: "Ordinary", number: 7 })
    .returning();
  return { owner, tableId, rowId, project, task };
}

async function mcpClient() {
  const server = new McpServer({ name: "tables-re", version: "1.0.0" });
  registerMcpTools(toMcpToolRegistrar(server), MCP_BASE, "session-bearer");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "tables-re-client", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

function toolText(result: unknown) {
  const r = result as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0]?.text ?? "", isError: Boolean(r.isError) };
}

describe("Tables R-E: no comments and no relations on rows", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    tableOutboxHooks.disableKick = true;
  });

  it("refuses comment create, update and delete on a row over REST; reads are empty", async () => {
    const s = await seed();
    await expectRefused(
      await json("POST", `/api/comment/${s.rowId}`, { content: "hi" }),
      "table_row_comments_disabled",
    );
    await expectRefused(
      await json("POST", "/api/activity/comment", {
        taskId: s.rowId,
        comment: "hi",
      }),
      "table_row_comments_disabled",
    );
    // Dirty data: a comment on the row that predates the guard (comments are activities).
    const [dirty] = await db
      .insert(activityTable)
      .values({
        taskId: s.rowId,
        type: "comment",
        userId: s.owner.user.id,
        content: "old",
      })
      .returning();
    for (const res of [
      await json("PUT", `/api/comment/${dirty.id}`, { content: "new" }),
      await json("DELETE", `/api/comment/${dirty.id}`),
      await json("PUT", "/api/activity/comment", {
        activityId: dirty.id,
        comment: "new",
      }),
      await json("DELETE", "/api/activity/comment", { activityId: dirty.id }),
    ]) {
      await expectRefused(res, "table_row_comments_disabled");
    }
    const read = await json("GET", `/api/comment/${s.rowId}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual([]);

    // An ordinary task keeps its comments.
    const ok = await json("POST", `/api/comment/${s.task.id}`, {
      content: "fine",
    });
    expect(ok.status).toBe(200);
    const list = (await (
      await json("GET", `/api/comment/${s.task.id}`)
    ).json()) as unknown[];
    expect(list).toHaveLength(1);
  });

  it("refuses a relation with a row at either end, empties the row's relation read, refuses a move in", async () => {
    const s = await seed();
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
    await db.insert(taskRelationTable).values({
      sourceTaskId: s.task.id,
      targetTaskId: s.rowId,
      relationType: "related",
    });
    const read = await json("GET", `/api/task-relation/${s.rowId}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual([]);
    const ordinary = (await (
      await json("GET", `/api/task-relation/${s.task.id}`)
    ).json()) as unknown[];
    expect(ordinary).toHaveLength(1);

    await expectRefused(
      await json("PUT", `/api/task/move/${s.task.id}`, {
        destinationProjectId: s.tableId,
      }),
      "table_move_not_supported",
    );
  });

  it("refuses the MCP comment and relation tools on a row (either direction)", async () => {
    const s = await seed();
    const client = await mcpClient();
    const comment = toolText(
      await client.callTool({
        name: "create_task_comment",
        arguments: { taskId: s.rowId, content: "hi" },
      }),
    );
    expect(comment.isError).toBe(true);
    expect(comment.text).toContain("Entries of a table have no comments");
    for (const [sourceTaskId, targetTaskId] of [
      [s.rowId, s.task.id],
      [s.task.id, s.rowId],
    ]) {
      const relation = toolText(
        await client.callTool({
          name: "create_task_relation",
          arguments: { sourceTaskId, targetTaskId, relationType: "related" },
        }),
      );
      expect(relation.isError).toBe(true);
      expect(relation.text).toContain("Entries of a table have no relations");
    }
    const listed = toolText(
      await client.callTool({
        name: "list_task_comments",
        arguments: { taskId: s.rowId },
      }),
    );
    expect(listed.isError).toBe(false);
    expect(JSON.parse(listed.text)).toEqual([]);
    // The ordinary task still takes a comment through the same tool.
    const ok = toolText(
      await client.callTool({
        name: "create_task_comment",
        arguments: { taskId: s.task.id, content: "fine" },
      }),
    );
    expect(ok.isError).toBe(false);
  });

  it("reads one row for the panel, and 404s an ordinary task", async () => {
    const s = await seed();
    const res = await json("GET", `/api/operon/tables/rows/${s.rowId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      row: { rowId: string; title: string; madeBy: { name: string } };
      table: { name: string; statusColumn: string; dateColumn: string };
    };
    expect(body.row.rowId).toBe(s.rowId);
    expect(body.row.title).toBe("MFA tip");
    expect(body.row.madeBy.name).toBe("Integration Test User");
    expect(body.table).toMatchObject({
      name: "Risk tips",
      statusColumn: "Status",
      dateColumn: "Posted",
    });
    const ordinary = await json("GET", `/api/operon/tables/rows/${s.task.id}`);
    expect(ordinary.status).toBe(404);
    expect(((await ordinary.json()) as { error: string }).error).toBe(
      "not_a_table_row",
    );
  });
});
