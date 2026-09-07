import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

/**
 * Operon fork checks for `GET`/`POST /api/telegraph-integration/project/{projectId}`
 * (Operon spec R15, R16, decision 31, task C19).
 *
 * Each case is written to fail if a specific property of that router is undone — the
 * create-or-get semantics, the index-backed idempotency, the `manage_settings` gate, and
 * the fact that a `telegraph` config carries no credential. See `docs/fork-discipline.md`
 * in the Operon repository for why these live in the fork rather than in Operon.
 */

const APEX = "https://operon.test";

async function seedProject(role = "owner") {
  const member = await createWorkspaceMember({ role });
  const { project } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  return { member, project };
}

function requester(projectId: string) {
  const { app } = createApp();
  const path = `/api/telegraph-integration/project/${projectId}`;
  return (method: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

function telegraphRows(projectId: string) {
  return db
    .select()
    .from(schema.integrationTable)
    .where(
      and(
        eq(schema.integrationTable.projectId, projectId),
        eq(schema.integrationTable.type, "telegraph"),
      ),
    );
}

describe("API integration: the telegraph integration router", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("answers null before anything is provisioned, and the created row after", async () => {
    const { member, project } = await seedProject();
    mockAuthenticatedSession(member.user);
    const request = requester(project.id);

    const before = await request("GET");
    expect(before.status).toBe(200);
    expect(await before.json()).toBeNull();

    const created = await request("POST", { apexUrl: APEX });
    expect(created.status).toBe(200);
    const body = await created.json();
    expect(body).toMatchObject({
      projectId: project.id,
      apexUrl: APEX,
      isActive: true,
    });
    // The id is what B13's `CreateTaskFromMessage` attaches an external link with, so it
    // has to be in the response; without it the whole route is pointless.
    expect(body.id).toEqual(expect.any(String));

    const read = await request("GET");
    expect(await read.json()).toMatchObject({ id: body.id, apexUrl: APEX });
  });

  it("is idempotent: a repeated POST creates no second row and does not move the id", async () => {
    const { member, project } = await seedProject();
    mockAuthenticatedSession(member.user);
    const request = requester(project.id);

    const first = await (await request("POST", { apexUrl: APEX })).json();
    const second = await (await request("POST", { apexUrl: APEX })).json();

    expect(second.id).toBe(first.id);
    expect(await telegraphRows(project.id)).toHaveLength(1);
  });

  it("converges on ONE row when two POSTs race, which is what the unique index buys", async () => {
    const { member, project } = await seedProject();
    mockAuthenticatedSession(member.user);
    const request = requester(project.id);

    // Genuinely concurrent: a read-before-insert guard would let both see nothing and the
    // second insert would raise a unique violation instead of returning 200.
    const [a, b] = await Promise.all([
      request("POST", { apexUrl: APEX }),
      request("POST", { apexUrl: APEX }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await telegraphRows(project.id)).toHaveLength(1);
  });

  it("is create-or-GET, not create-or-replace: a second POST does not rewrite the config", async () => {
    const { member, project } = await seedProject();
    mockAuthenticatedSession(member.user);
    const request = requester(project.id);

    await request("POST", { apexUrl: APEX });
    const changed = await (
      await request("POST", { apexUrl: "https://somewhere-else.test" })
    ).json();

    // The provisioner runs every five minutes; replace semantics would churn `updated_at`
    // on every project forever and let a misconfigured caller silently repoint the row.
    expect(changed.apexUrl).toBe(APEX);
    const [row] = await telegraphRows(project.id);
    expect(JSON.parse(row.config)).toEqual({ apexUrl: APEX });
  });

  it("accepts a POST with no body at all — apexUrl is optional", async () => {
    const { member, project } = await seedProject();
    mockAuthenticatedSession(member.user);

    const created = await requester(project.id)("POST");
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ apexUrl: null });
  });

  it("rejects an apexUrl that is not an http(s) URL", async () => {
    const { member, project } = await seedProject();
    mockAuthenticatedSession(member.user);
    const request = requester(project.id);

    expect(
      (await request("POST", { apexUrl: "ftp://operon.test" })).status,
    ).toBe(400);
    expect((await request("POST", { apexUrl: "not a url" })).status).toBe(400);
    expect((await request("POST", { apexUrl: 42 })).status).toBe(400);
    expect(await telegraphRows(project.id)).toHaveLength(0);
  });

  it("refuses a POST from a member without workspace:manage_settings, but still allows the GET", async () => {
    const { member, project } = await seedProject("member");
    mockAuthenticatedSession(member.user);
    const request = requester(project.id);

    expect((await request("POST", { apexUrl: APEX })).status).toBe(403);
    expect(await telegraphRows(project.id)).toHaveLength(0);
    // The read route carries no permission middleware, exactly like the generic-webhook
    // router's read route, so an ordinary member can still resolve the id for a task link.
    expect((await request("GET")).status).toBe(200);
  });

  it("refuses a caller outside the project's workspace", async () => {
    const { project } = await seedProject();
    const outsider = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(outsider.user);
    const request = requester(project.id);

    expect((await request("GET")).status).toBe(403);
    expect((await request("POST", { apexUrl: APEX })).status).toBe(403);
    expect(await telegraphRows(project.id)).toHaveLength(0);
  });

  it("does not disturb the project's generic-webhook row — the two coexist under UNIQUE (projectId, type)", async () => {
    const { member, project } = await seedProject();
    await db.insert(schema.integrationTable).values({
      projectId: project.id,
      type: "generic-webhook",
      config: JSON.stringify({ webhookUrl: "https://example.test/hook" }),
      isActive: true,
    });
    mockAuthenticatedSession(member.user);

    expect(
      (await requester(project.id)("POST", { apexUrl: APEX })).status,
    ).toBe(200);

    const all = await db
      .select()
      .from(schema.integrationTable)
      .where(eq(schema.integrationTable.projectId, project.id));
    expect(all.map((row) => row.type).sort()).toEqual([
      "generic-webhook",
      "telegraph",
    ]);
  });
});
