import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Operon agents-first-class Phase 4 D7: `GET /api/internal/operon/agent-activity` — one Kaneo
 * user's activity rows for Operon's Activity read. The service key only; exactly the keys
 * {id, type, at, taskId, projectId, workspaceId} (never content or event_data); a free-text `type`
 * answers `other`; other users' rows absent; the 90-day bound; keyset pages by (created_at, id)
 * with no row skipped or repeated; malformed input 400; and the composite index serves a
 * 100,000-row user in < 500 ms.
 */

process.env.OPERON_OIDC_ONLY = "true";
const { createApp } = await import("../../apps/api/src/index");
const { auth } = await import("../../apps/api/src/auth");
const { default: db, schema } = await import("../../apps/api/src/database");
const { resetTestDatabase } = await import("./helpers/database");
const { createProjectFixture, createWorkspaceMember } = await import(
  "./helpers/fixtures"
);

const { app } = createApp();
let holder: Awaited<ReturnType<typeof createWorkspaceMember>>;
let serviceKey: string;
let otherKey: string;

async function newUser(name: string) {
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: `user-${randomUUID()}`,
      email: `${name}-${randomUUID()}@example.com`,
      emailVerified: true,
      name,
    })
    .returning();
  return user;
}
async function newTask() {
  const { project } = await createProjectFixture({
    workspaceId: holder.workspace.id,
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({ projectId: project.id, title: "Card" })
    .returning();
  return { task, project };
}
const read = (query: string, key = serviceKey) =>
  app.request(`/api/internal/operon/agent-activity?${query}`, {
    headers: { "x-api-key": key },
  });

beforeEach(async () => {
  await resetTestDatabase();
  holder = await createWorkspaceMember({ role: "owner" });
  const created = await auth.api.createApiKey({
    body: {
      userId: holder.user.id,
      name: "svc",
      permissions: {
        workspace: ["manage_settings"],
        task: ["create", "update"],
        operon: ["rekey"],
      },
      metadata: { operonService: true },
    },
  });
  if (!created?.key) throw new Error("no service key");
  serviceKey = created.key;
  const plain = await auth.api.createApiKey({
    body: { userId: holder.user.id, name: "plain" },
  });
  if (!plain?.key) throw new Error("no plain key");
  otherKey = plain.key;
});

describe("agent-activity", () => {
  it("answers the user's rows with exactly the allowed keys, a free-text type as other, other users absent", async () => {
    const agent = await newUser("agent");
    const other = await newUser("other");
    const { task, project } = await newTask();
    await db.insert(schema.activityTable).values([
      {
        taskId: task.id,
        type: "comment",
        userId: agent.id,
        content: "secret body",
        eventData: { x: "secret" },
      },
      { taskId: task.id, type: "secret text", userId: agent.id, content: "x" },
      {
        taskId: task.id,
        type: "comment",
        userId: other.id,
        content: "not mine",
      },
    ]);
    const res = await read(`userId=${agent.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Record<string, string>[];
      next: string | null;
    };
    expect(body.items).toHaveLength(2);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual([
        "at",
        "id",
        "projectId",
        "taskId",
        "type",
        "workspaceId",
      ]);
      expect(item).toMatchObject({
        taskId: task.id,
        projectId: project.id,
        workspaceId: holder.workspace.id,
      });
    }
    expect(body.items.map((i) => i.type).sort()).toEqual(["comment", "other"]);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(body.next).toBeNull();
  });

  it("a session or another key is 403; malformed userId, cursor and limit are 400", async () => {
    const agent = await newUser("agent");
    expect((await read(`userId=${agent.id}`, otherKey)).status).toBe(403);
    expect(
      (
        await app.request(
          `/api/internal/operon/agent-activity?userId=${agent.id}`,
        )
      ).status,
    ).toBe(401);
    expect((await read("userId=a%20b")).status).toBe(400);
    expect((await read(`userId=${agent.id}&limit=0`)).status).toBe(400);
    expect((await read(`userId=${agent.id}&limit=101`)).status).toBe(400);
    expect((await read(`userId=${agent.id}&limit=x`)).status).toBe(400);
    expect((await read(`userId=${agent.id}&before=2026-01-01`)).status).toBe(
      400,
    );
    expect(
      (await read(`userId=${agent.id}&before=2026-01-01T00:00:00.000000~a'b`))
        .status,
    ).toBe(400);
  });

  it("pages by (created_at, id) with equal timestamps: every row once; rows older than 90 days absent", async () => {
    const agent = await newUser("agent");
    const { task } = await newTask();
    const same = new Date(Date.now() - 60_000);
    await db.insert(schema.activityTable).values(
      Array.from({ length: 7 }, (_, i) => ({
        id: `act-${i}`,
        taskId: task.id,
        type: "comment",
        userId: agent.id,
        createdAt: same,
      })),
    );
    await db.insert(schema.activityTable).values({
      id: "act-old",
      taskId: task.id,
      type: "comment",
      userId: agent.id,
      createdAt: new Date(Date.now() - 91 * 86400_000),
    });
    const seen: string[] = [];
    let next: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res = await read(
        `userId=${agent.id}&limit=3${next ? `&before=${encodeURIComponent(next)}` : ""}`,
      );
      const body = (await res.json()) as {
        items: { id: string }[];
        next: string | null;
      };
      seen.push(...body.items.map((i) => i.id));
      next = body.next;
      if (!next) break;
    }
    expect(seen).toEqual([
      "act-6",
      "act-5",
      "act-4",
      "act-3",
      "act-2",
      "act-1",
      "act-0",
    ]);
  });

  it("the composite index serves a 100,000-row user: the plan uses it and a page returns in < 500 ms", async () => {
    const agent = await newUser("agent");
    const { task } = await newTask();
    await db.execute(sql`
      INSERT INTO activity (id, task_id, type, user_id, created_at, updated_at)
      SELECT 'bulk-' || g, ${task.id}, 'comment', ${agent.id}, now() - (g || ' seconds')::interval, now()
        FROM generate_series(1, 100000) g`);
    await db.execute(sql`ANALYZE activity`);
    const plan = await db.execute(sql`
      EXPLAIN SELECT a.id FROM activity a
       WHERE a.user_id = ${agent.id} AND a.created_at > (now() AT TIME ZONE 'UTC') - interval '90 days'
       ORDER BY a.created_at DESC NULLS LAST, a.id DESC NULLS LAST LIMIT 100`);
    expect(JSON.stringify(plan.rows)).toContain("activity_user_created_id_idx");
    const t0 = performance.now();
    const res = await read(`userId=${agent.id}&limit=100`);
    const ms = performance.now() - t0;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(
      100,
    );
    expect(ms).toBeLessThan(500);
  }, 120_000);
});
