import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Operon fork checks — Tables task 8 (docs/fork-discipline.md row 18, spec 7.9 / 7.10 /
 * RF-11): the server search and the table view's rows route. Both must find a row long
 * past the first 2,000 created (search over Notes; chip filters and the date sort applied
 * before the page is cut), treat `%` and `_` literally, never search a hidden column, and
 * never answer for a table of another workspace.
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
setEnv("KANEO_WEBHOOK_SECRET", "tables-search-webhook-secret");
setEnv("OPERON_KANEO_S2S_SECRET", "tables-search-s2s-secret");
setEnv("KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS", "true");

const { createApp } = await import("../../apps/api/src/index");
const { default: db } = await import("../../apps/api/src/database");
const { tableOutboxHooks } = await import(
  "../../apps/api/src/operon-tables/outbox"
);
const { mockAuthenticatedSession } = await import("./helpers/auth");
const { resetTestDatabase } = await import("./helpers/database");
const { createWorkspaceMember } = await import("./helpers/fixtures");

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

type Row = {
  rowId: string;
  title: string;
  tableName?: string;
  values: Record<string, unknown>;
};

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
  return ((await added.json()) as { row: Row }).row;
}

/**
 * 2,050 rows straight into Postgres (the row writer would take minutes): row 1 is the
 * OLDEST, holds the only "zebrafish" in its Notes, the only "Site" channel, the only
 * "Published" status and the globally newest date (2031). Row 2 is undated.
 */
async function seedBulk(tableId: string, col: Record<string, string>) {
  await db.execute(sql`
    INSERT INTO task (id, project_id, number, title, description, created_at)
    SELECT 'bulk-' || g, ${tableId}, g + 1, 'Bulk ' || g,
      CASE WHEN g = 1 THEN 'the oldest row mentions zebrafish' ELSE 'filler' END,
      now() - (interval '1 second' * (3000 - g))
    FROM generate_series(1, 2050) AS g`);
  await db.execute(sql`
    INSERT INTO custom_field_value (id, task_id, field_id, value)
    SELECT md5(random()::text || g), 'bulk-' || g, ${col.Status}, CASE WHEN g = 1 THEN 'Published' ELSE 'Idea' END
    FROM generate_series(1, 2050) AS g`);
  await db.execute(sql`
    INSERT INTO custom_field_value (id, task_id, field_id, value)
    SELECT md5(random()::text || g), 'bulk-' || g, ${col.Channel}, CASE WHEN g = 1 THEN 'Site' ELSE 'LinkedIn' END
    FROM generate_series(1, 2050) AS g`);
  await db.execute(sql`
    INSERT INTO custom_field_value (id, task_id, field_id, value)
    SELECT md5(random()::text || g), 'bulk-' || g, ${col.Posted},
      CASE WHEN g = 1 THEN '2031-01-01' ELSE '2026-0' || (1 + g % 9) || '-15' END
    FROM generate_series(1, 2050) AS g WHERE g <> 2`);
}

async function rowsPage(tableId: string, query: string) {
  const res = await json("GET", `/api/operon/tables/${tableId}/rows?${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    rows: Row[];
    nextCursor: string | null;
    total: number | null;
    entries: number | null;
  };
}

async function search(workspaceId: string, q: string, extra = "") {
  return json(
    "GET",
    `/api/operon/tables/search?workspaceId=${workspaceId}&q=${encodeURIComponent(q)}${extra}`,
  );
}

describe("Tables search and rows routes", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    tableOutboxHooks.disableKick = true;
  });

  it("finds a Notes word only the oldest of 2,050 rows holds, and pages", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(owner.user);
    const { tableId, col } = await createTable(owner.workspace.id, "Risk tips");
    await seedBulk(tableId, col);

    const res = await search(
      owner.workspace.id,
      "ZEBRAFISH",
      `&tableId=${tableId}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Row[] };
    expect(body.rows.map((r) => r.rowId)).toEqual(["bulk-1"]);
    expect(body.rows[0]?.tableName).toBe("Risk tips");

    const first = (await (
      await search(owner.workspace.id, "Bulk", "&limit=50")
    ).json()) as { rows: Row[]; nextCursor: string };
    expect(first.rows).toHaveLength(50);
    expect(first.rows[0]?.rowId).toBe("bulk-2050");
    const second = (await (
      await search(
        owner.workspace.id,
        "Bulk",
        `&limit=50&cursor=${first.nextCursor}`,
      )
    ).json()) as { rows: Row[] };
    expect(second.rows[0]?.rowId).toBe("bulk-2000");
  });

  it("applies chips and the date sort before paging", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(owner.user);
    const { tableId, col } = await createTable(owner.workspace.id, "Risk tips");
    await seedBulk(tableId, col);

    for (const filter of [
      `filter=${col.Status}:Published`,
      `filter=${col.Channel}:Site`,
      "sort=date&year=2031",
    ]) {
      const page = await rowsPage(tableId, filter);
      expect(page.rows.map((r) => r.rowId)).toEqual(["bulk-1"]);
      expect(page.total).toBe(1);
      expect(page.entries).toBe(2050);
    }

    // Date sort: the undated row first ("No date"), then the globally newest date.
    const dated = await rowsPage(tableId, "sort=date&limit=3");
    expect(dated.rows.map((r) => r.rowId).slice(0, 2)).toEqual([
      "bulk-2",
      "bulk-1",
    ]);
    expect(dated.rows[1]?.values.Posted).toBe("2031-01-01");
    // Walking every page of the date sort visits each row exactly once.
    const seen = new Set<string>();
    let cursor: string | null = null;
    let last = "9999-12-31";
    do {
      const page = await rowsPage(
        tableId,
        `sort=date&limit=200${cursor ? `&cursor=${cursor}` : ""}`,
      );
      for (const row of page.rows) {
        expect(seen.has(row.rowId)).toBe(false);
        seen.add(row.rowId);
        const posted = row.values.Posted as string | null;
        if (posted) {
          expect(posted <= last).toBe(true);
          last = posted;
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(2050);

    const refused = await json(
      "GET",
      `/api/operon/tables/${tableId}/rows?filter=${col.Status}:Nope`,
    );
    expect(refused.status).toBe(422);
  });

  it("matches % and _ literally and never searches a hidden column", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(owner.user);
    const { tableId } = await createTable(owner.workspace.id, "Risk tips");
    const series = await json("POST", "/api/custom-field", {
      projectId: tableId,
      name: "Series",
      type: "text",
    });
    const seriesId = ((await series.json()) as { id: string }).id;
    await addRow(tableId, { title: "50% off" });
    await addRow(tableId, { title: "a_b" });
    await addRow(tableId, { title: "plain", notes: "nothing special" });
    await addRow(tableId, { title: "secret", values: { Series: "kumquat" } });

    const titles = async (q: string) =>
      (
        (await (await search(owner.workspace.id, q)).json()) as { rows: Row[] }
      ).rows.map((r) => r.title);
    expect(await titles("%")).toEqual(["50% off"]);
    expect(await titles("_")).toEqual(["a_b"]);
    expect(await titles("kumquat")).toEqual(["secret"]);

    const hidden = await json("DELETE", `/api/custom-field/${seriesId}`);
    expect(hidden.status).toBe(200);
    expect(await titles("kumquat")).toEqual([]);
  });

  it("never answers for a table of another workspace", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    const other = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(other.user);
    const { tableId: otherTable } = await createTable(
      other.workspace.id,
      "Elsewhere",
    );
    await addRow(otherTable, { title: "shared word quince" });

    mockAuthenticatedSession(owner.user);
    const { tableId } = await createTable(owner.workspace.id, "Risk tips");
    await addRow(tableId, { title: "mine quince" });

    const mine = (await (
      await search(owner.workspace.id, "quince")
    ).json()) as {
      rows: Row[];
    };
    expect(mine.rows.map((r) => r.title)).toEqual(["mine quince"]);

    const crossed = await search(
      owner.workspace.id,
      "quince",
      `&tableId=${otherTable}`,
    );
    expect(crossed.status).toBe(404);
    const crossedBody = await crossed.text();
    expect(crossedBody).not.toContain("quince");
    expect(crossedBody).not.toContain("rows");

    const foreign = await search(other.workspace.id, "quince");
    expect(foreign.status).toBe(403);
  });
});
