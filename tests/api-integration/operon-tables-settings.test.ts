import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Operon fork checks — Tables task 10 (docs/fork-discipline.md row 18, spec 7.1, 7.9,
 * RF-9): the Columns page's server side. The group/date/status settings accept only an
 * active column of this table of the right kind, and only from a table admin; hidden
 * columns are listed to admins only. Setup mirrors operon-tables-columns.test.ts.
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
const { default: db } = await import("../../apps/api/src/database");
const { tableOutboxHooks } = await import(
  "../../apps/api/src/operon-tables/outbox"
);
const { mockAuthenticatedSession } = await import("./helpers/auth");
const { resetTestDatabase } = await import("./helpers/database");
const { createWorkspaceMember } = await import("./helpers/fixtures");
const {
  customFieldDefinitionTable,
  operonTableProjectTable,
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

async function _customRoleEditor(workspaceId: string) {
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

describe("API integration: Tables — Columns page routes (task 10)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    tableOutboxHooks.disableKick = true;
  });

  async function flag(tableId: string) {
    const [row] = await db
      .select()
      .from(operonTableProjectTable)
      .where(eq(operonTableProjectTable.projectId, tableId));
    return row;
  }

  it("an admin sets and clears the group, date and status columns", async () => {
    const s = await seed();
    const response = await json(
      "PUT",
      `/api/operon/tables/${s.tableId}/settings`,
      {
        groupFieldId: s.col.Status.id,
        statusFieldId: null,
      },
    );
    expect(response.status).toBe(200);
    const table = (await response.json()) as { groupFieldId: string };
    expect(table.groupFieldId).toBe(s.col.Status.id);
    const row = await flag(s.tableId);
    expect(row.groupFieldId).toBe(s.col.Status.id);
    expect(row.statusFieldId).toBeNull();
    expect(row.dateFieldId).toBe(s.col.Posted.id);
  });

  it("refuses another table's field, a hidden field and the wrong kind without changing a setting", async () => {
    const s = await seed();
    const other = await json("POST", "/api/operon/tables", {
      workspaceId: s.owner.workspace.id,
      name: "Videos",
      slug: "VID",
    });
    const otherId = ((await other.json()) as { id: string }).id;
    const [otherTopic] = await db
      .select()
      .from(customFieldDefinitionTable)
      .where(eq(customFieldDefinitionTable.projectId, otherId));
    await json("DELETE", `/api/custom-field/${s.col.Channel.id}`);
    const before = await flag(s.tableId);
    for (const body of [
      { groupFieldId: otherTopic.id },
      { groupFieldId: s.col.Channel.id },
      { dateFieldId: s.col.Status.id },
      { statusFieldId: s.col.Posted.id },
      { groupFieldId: s.col.Topic.id, dateFieldId: s.col.Link.id },
    ]) {
      const response = await json(
        "PUT",
        `/api/operon/tables/${s.tableId}/settings`,
        body,
      );
      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: string }).error).toBe(
        "invalid_setting",
      );
    }
    expect(await flag(s.tableId)).toEqual(before);
  });

  it("refuses a member's settings and definition calls; lists hidden columns to admins only", async () => {
    const s = await seed();
    await json("DELETE", `/api/custom-field/${s.seriesId}`);
    const asAdmin = (await (
      await json("GET", `/api/operon/tables/${s.tableId}`)
    ).json()) as { hiddenColumns?: { name: string }[] };
    expect(asAdmin.hiddenColumns?.map((c) => c.name)).toEqual(["Series"]);

    const member = await addMember(s.owner.workspace.id, "member");
    mockAuthenticatedSession(member);
    const before = await flag(s.tableId);
    const refused = await json(
      "PUT",
      `/api/operon/tables/${s.tableId}/settings`,
      { groupFieldId: s.col.Status.id },
    );
    expect(refused.status).toBe(403);
    expect(await flag(s.tableId)).toEqual(before);
    for (const response of [
      await json("POST", "/api/custom-field", {
        projectId: s.tableId,
        name: "X",
        type: "text",
      }),
      await json("DELETE", `/api/custom-field/${s.col.Link.id}`),
      await json("PUT", `/api/custom-field/reorder/${s.tableId}`, {
        fields: [{ id: s.col.Link.id, position: 1 }],
      }),
    ]) {
      expect(response.status).toBe(403);
    }
    const asMember = (await (
      await json("GET", `/api/operon/tables/${s.tableId}`)
    ).json()) as { hiddenColumns?: unknown; name: string };
    expect(asMember.name).toBe("Risk tips");
    expect(asMember.hiddenColumns).toBeUndefined();
  });
});
