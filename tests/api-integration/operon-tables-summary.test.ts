import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Operon fork checks — Tables task 8 (docs/fork-discipline.md row 18, spec 7.9 / 7.10 US1):
 * the workspace project list's Tables summary and the list's `isTable` flag. Counts, group
 * and status counts and "Recently added" cover only the caller's workspace, page across
 * tables, and never carry a hidden column's values.
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
setEnv("KANEO_WEBHOOK_SECRET", "tables-summary-webhook-secret");
setEnv("OPERON_KANEO_S2S_SECRET", "tables-summary-s2s-secret");
setEnv("KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS", "true");

const { createApp } = await import("../../apps/api/src/index");
const { tableOutboxHooks } = await import(
  "../../apps/api/src/operon-tables/outbox"
);
const { mockAuthenticatedSession } = await import("./helpers/auth");
const { resetTestDatabase } = await import("./helpers/database");
const { createProjectFixture, createWorkspaceMember } = await import(
  "./helpers/fixtures"
);
const { summaryLimits } = await import(
  "../../apps/api/src/operon-tables/views"
);

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

async function createTable(workspaceId: string, name: string) {
  const created = await json("POST", "/api/operon/tables", {
    workspaceId,
    name,
    slug: name.slice(0, 4).toUpperCase(),
  });
  expect(created.status).toBe(200);
  const tableId = ((await created.json()) as { id: string }).id;
  const read = await json("GET", `/api/operon/tables/${tableId}`);
  const table = (await read.json()) as {
    columns: { id: string; name: string }[];
  };
  const col = Object.fromEntries(table.columns.map((c) => [c.name, c.id]));
  return { tableId, col };
}

async function addRow(tableId: string, body: Record<string, unknown>) {
  const added = await json("POST", `/api/operon/tables/${tableId}/rows`, {
    requestId: randomUUID(),
    ...body,
  });
  expect(added.status).toBe(200);
}

type Summary = {
  tables: {
    tableId: string;
    name: string;
    entries: number;
    group: {
      name: string;
      isTemplateTopic: boolean;
      options: number;
      counts: { option: string; count: number }[];
    } | null;
    status: { option: string; count: number }[];
    lastAdded: { at: string; by: string | null } | null;
  }[];
  nextCursor: string | null;
  recent?: { title: string; tableName: string; madeBy: string | null }[];
};

async function summary(workspaceId: string, cursor?: string) {
  const res = await json(
    "GET",
    `/api/operon/tables/workspace/${workspaceId}/summary${cursor ? `?cursor=${cursor}` : ""}`,
  );
  return res;
}

describe("Tables workspace summary", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    tableOutboxHooks.disableKick = true;
    summaryLimits.page = 50;
  });

  it("counts entries, groups and statuses for the caller's workspace only", async () => {
    const other = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(other.user);
    const { tableId: foreign } = await createTable(
      other.workspace.id,
      "Foreign",
    );
    await addRow(foreign, { title: "not yours" });

    const owner = await createWorkspaceMember({
      role: "owner",
      userName: "Dana Admin",
    });
    mockAuthenticatedSession(owner.user);
    const { tableId: tips, col } = await createTable(
      owner.workspace.id,
      "Risk tips",
    );
    for (const label of ["Cyber", "Fleet"]) {
      const res = await json(
        "POST",
        `/api/operon/tables/${tips}/fields/${col.Topic}/options`,
        { action: "add", label },
      );
      expect(res.status).toBe(200);
    }
    await addRow(tips, {
      title: "One",
      values: { Topic: "Cyber", Status: "Published" },
    });
    await addRow(tips, {
      title: "Two",
      values: { Topic: "Cyber", Status: "Idea" },
    });
    await addRow(tips, {
      title: "Three",
      values: { Topic: "Fleet", Status: "Published" },
    });
    const { tableId: videos } = await createTable(owner.workspace.id, "Videos");
    for (const title of ["V1", "V2", "V3", "V4"]) {
      await addRow(videos, { title });
    }
    await createProjectFixture({ workspaceId: owner.workspace.id });

    const res = await summary(owner.workspace.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Summary;
    expect(body.tables.map((t) => t.name)).toEqual(["Risk tips", "Videos"]);
    const tipsSummary = body.tables[0];
    expect(tipsSummary?.entries).toBe(3);
    expect(tipsSummary?.group).toMatchObject({
      name: "Topic",
      isTemplateTopic: true,
      options: 2,
      counts: [
        { option: "Cyber", count: 2 },
        { option: "Fleet", count: 1 },
      ],
    });
    expect(tipsSummary?.status).toEqual([
      { option: "Idea", count: 1 },
      { option: "In progress", count: 0 },
      { option: "Published", count: 2 },
    ]);
    expect(tipsSummary?.lastAdded?.by).toBe("Dana Admin");
    expect(body.tables[1]?.entries).toBe(4);
    // Five newest across this workspace's tables; the foreign table never appears.
    expect(body.recent?.map((r) => r.title)).toEqual([
      "V4",
      "V3",
      "V2",
      "V1",
      "Three",
    ]);
    expect(JSON.stringify(body)).not.toContain("Foreign");
    expect(JSON.stringify(body)).not.toContain("not yours");

    const refused = await summary(other.workspace.id);
    expect(refused.status).toBe(403);
  });

  it("pages across tables and omits a hidden column", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(owner.user);
    const first = await createTable(owner.workspace.id, "Alpha");
    await createTable(owner.workspace.id, "Beta");
    await createTable(owner.workspace.id, "Gamma");
    await addRow(first.tableId, { title: "a", values: { Status: "Idea" } });

    summaryLimits.page = 2;
    const one = (await (await summary(owner.workspace.id)).json()) as Summary;
    expect(one.tables.map((t) => t.name)).toEqual(["Alpha", "Beta"]);
    expect(one.nextCursor).toBeTruthy();
    const two = (await (
      await summary(owner.workspace.id, one.nextCursor ?? "")
    ).json()) as Summary;
    expect(two.tables.map((t) => t.name)).toEqual(["Gamma"]);
    expect(two.nextCursor).toBeNull();
    expect(two.recent).toBeUndefined();

    // Hiding Status clears the status pointer: no status counts, no option label.
    const hidden = await json(
      "DELETE",
      `/api/custom-field/${first.col.Status}`,
    );
    expect(hidden.status).toBe(200);
    summaryLimits.page = 50;
    const after = (await (await summary(owner.workspace.id)).json()) as Summary;
    const alpha = after.tables.find((t) => t.name === "Alpha");
    expect(alpha?.status).toEqual([]);
    expect(JSON.stringify(alpha)).not.toContain("Idea");
  });

  it("marks tables isTable on the existing project list", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(owner.user);
    const { tableId } = await createTable(owner.workspace.id, "Risk tips");
    const plain = await createProjectFixture({
      workspaceId: owner.workspace.id,
    });
    const res = await json(
      "GET",
      `/api/project?workspaceId=${owner.workspace.id}`,
    );
    expect(res.status).toBe(200);
    const list = (await res.json()) as { id: string; isTable: boolean }[];
    const flag = Object.fromEntries(list.map((p) => [p.id, p.isTable]));
    expect(flag[tableId]).toBe(true);
    expect(flag[plain.project.id]).toBe(false);
  });
});
