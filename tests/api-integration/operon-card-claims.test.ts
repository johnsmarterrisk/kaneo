import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Operon fork checks — agent card claims (Operon agents-first-class Phase 3 D8, R12;
 * docs/fork-discipline.md row 19). The claim, the assignee and the "On it" comment commit in
 * ONE transaction; a retry with the same requestId adds nothing; a person's card is refused; a
 * person's reassignment revokes the claim. Liveness is stubbed `{ active: true }`.
 *
 * Operon mode is a property of the FILE (see `operon-oidc-only.test.ts`): the env is set
 * before the app modules are imported, through an indexed helper for biome's
 * `noUndeclaredEnvVars`. See `docs/fork-discipline.md` in the Operon repository.
 */
function setEnv(key: string, value: string) {
  process.env[key] = value;
}

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

// The platform's liveness route, answering every agent alive.
const livenessCalls: string[] = [];
const platform = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    livenessCalls.push(raw);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ active: true }));
  });
});
const platformPort = await listen(platform);

// The MCP tools call the REST API over KANEO_INTERNAL_API_URL, read at import, so the app
// is served on a real port reserved before the import.
const reserve = http.createServer();
const appPort = await listen(reserve);
await new Promise((resolve) => reserve.close(resolve));

setEnv("OPERON_OIDC_ONLY", "true");
setEnv("OPERON_INTERNAL_API_URL", `http://127.0.0.1:${platformPort}`);
setEnv("OPERON_KANEO_S2S_SECRET", "card-claims-suite-secret");
setEnv("KANEO_INTERNAL_API_URL", `http://127.0.0.1:${appPort}`);

const { createApp } = await import("../../apps/api/src/index");
const { auth } = await import("../../apps/api/src/auth");
const { default: db, schema } = await import("../../apps/api/src/database");
const { resetTestDatabase } = await import("./helpers/database");
const { agentCardClaimsTable } = await import(
  "../../apps/api/src/database/schema"
);
const { createProjectFixture, createWorkspaceMember } = await import(
  "./helpers/fixtures"
);

const { app } = createApp();
const server = serve({
  fetch: app.fetch,
  port: appPort,
  hostname: "127.0.0.1",
});

afterAll(async () => {
  server.close();
  platform.close();
});

let holder: Awaited<ReturnType<typeof createWorkspaceMember>>;
let serviceKey: string;

async function newAgent(name: string) {
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
    workspaceId: holder.workspace.id,
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
  const response = await app.request("/api/internal/operon/agent-key", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": serviceKey },
    body: JSON.stringify({ kaneoUserId: user.id }),
  });
  expect(response.status).toBe(200);
  return { user, key: ((await response.json()) as { key: string }).key };
}

async function humanBearer(userId: string) {
  const token = `tok-${randomUUID()}`;
  await db.insert(schema.sessionTable).values({
    id: `session-${randomUUID()}`,
    token,
    userId,
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return `Bearer ${token}`;
}

async function newCard(assigneeId: string | null = null) {
  const { project } = await createProjectFixture({
    workspaceId: holder.workspace.id,
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({ projectId: project.id, title: "Card", userId: assigneeId })
    .returning();
  return task;
}

const claim = (key: string, taskId: string, requestId = randomUUID()) =>
  app.request(`/api/operon/card-claims/${taskId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ requestId }),
  });
const release = (
  key: string,
  taskId: string,
  generation: number,
  done = false,
) =>
  app.request(`/api/operon/card-claims/${taskId}?done=${done}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${key}`,
      "X-Operon-Card-Generation": String(generation),
    },
  });
const comments = async (taskId: string) =>
  db
    .select()
    .from(schema.activityTable)
    .where(
      and(
        eq(schema.activityTable.taskId, taskId),
        eq(schema.activityTable.type, "comment"),
      ),
    );
const claimRow = async (taskId: string) =>
  (
    await db
      .select()
      .from(agentCardClaimsTable)
      .where(eq(agentCardClaimsTable.taskId, taskId))
  )[0] ?? null;
const assignee = async (taskId: string) =>
  (
    await db
      .select({ userId: schema.taskTable.userId })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, taskId))
  )[0]?.userId ?? null;

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
});

describe("POST /api/operon/card-claims/:taskId (agents-first-class Phase 3 D8)", () => {
  it("two concurrent claims on an unassigned card: one assignment, the loser 409 claimed, one On it", async () => {
    const a = await newAgent("Scout");
    const b = await newAgent("Pilot");
    const task = await newCard();
    const [ra, rb] = await Promise.all([
      claim(a.key, task.id),
      claim(b.key, task.id),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expect(await loser.json()).toEqual({ error: "claimed" });
    const winner = ra.status === 201 ? a : b;
    expect(await assignee(task.id)).toBe(winner.user.id);
    const c = await comments(task.id);
    expect(c.map((x) => [x.userId, x.content])).toEqual([
      [winner.user.id, "On it"],
    ]);
    expect(await claimRow(task.id)).toMatchObject({
      claimer: winner.user.id,
      generation: 1,
      state: "active",
    });
  });

  it("a retry with the same requestId returns the same generation and adds no comment", async () => {
    const a = await newAgent("Scout");
    const task = await newCard();
    const first = await claim(a.key, task.id, "req-1");
    expect(first.status).toBe(201);
    const again = await claim(a.key, task.id, "req-1");
    expect(again.status).toBe(200);
    expect(((await again.json()) as { generation: number }).generation).toBe(1);
    expect(await comments(task.id)).toHaveLength(1);
  });

  it("a forced failure of the comment insert leaves no claim, no assignee change and no comment", async () => {
    const a = await newAgent("Scout");
    const task = await newCard();
    await db.execute(
      sql`CREATE OR REPLACE FUNCTION operon_test_fail_comment() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced'; END $$ LANGUAGE plpgsql`,
    );
    await db.execute(
      sql`CREATE TRIGGER operon_test_fail_comment BEFORE INSERT ON activity FOR EACH ROW EXECUTE FUNCTION operon_test_fail_comment()`,
    );
    try {
      const r = await claim(a.key, task.id, "req-f");
      expect(r.status).toBe(500);
    } finally {
      await db.execute(
        sql`DROP TRIGGER IF EXISTS operon_test_fail_comment ON activity`,
      );
      await db.execute(sql`DROP FUNCTION IF EXISTS operon_test_fail_comment()`);
    }
    expect(await claimRow(task.id)).toBeNull();
    expect(await assignee(task.id)).toBeNull();
    expect(await comments(task.id)).toHaveLength(0);
    // After the fault clears, the same requestId claims once.
    expect((await claim(a.key, task.id, "req-f")).status).toBe(201);
    expect(await comments(task.id)).toHaveLength(1);
  });

  it("a person's card is 409 assigned_elsewhere; another agent's card only after its own claim expired", async () => {
    const a = await newAgent("Scout");
    const b = await newAgent("Pilot");
    const personal = await newCard(holder.user.id);
    expect(await (await claim(a.key, personal.id)).json()).toEqual({
      error: "assigned_elsewhere",
    });
    const byB = await newCard(b.user.id);
    expect((await claim(a.key, byB.id)).status).toBe(409);
    expect((await claim(b.key, byB.id)).status).toBe(201);
    expect((await claim(a.key, byB.id)).status).toBe(409);
    await db
      .update(agentCardClaimsTable)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(agentCardClaimsTable.taskId, byB.id));
    const take = await claim(a.key, byB.id);
    expect(take.status).toBe(201);
    expect(((await take.json()) as { generation: number }).generation).toBe(2);
    expect(await assignee(byB.id)).toBe(a.user.id);
    expect(await comments(personal.id)).toHaveLength(0);
  });

  it("a person reassigning the card revokes the claim; a person may not claim; release needs the current generation", async () => {
    const a = await newAgent("Scout");
    const task = await newCard();
    expect((await claim(a.key, task.id)).status).toBe(201);
    const bearer = await humanBearer(holder.user.id);
    const personClaim = await app.request(
      `/api/operon/card-claims/${task.id}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: bearer },
        body: JSON.stringify({ requestId: "x" }),
      },
    );
    expect(personClaim.status).toBe(403);
    expect((await release(a.key, task.id, 9)).status).toBe(409);
    const reassign = await app.request(`/api/task/assignee/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", authorization: bearer },
      body: JSON.stringify({ userId: holder.user.id }),
    });
    expect(reassign.status).toBe(200);
    expect(await claimRow(task.id)).toMatchObject({ state: "revoked" });
    expect((await release(a.key, task.id, 1)).status).toBe(409);
    const t2 = await newCard();
    expect((await claim(a.key, t2.id)).status).toBe(201);
    const done = await release(a.key, t2.id, 1, true);
    expect(await done.json()).toEqual({ state: "done", generation: 1 });
  });
});
