import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auth, OPERON_SERVICE_KEY_PERMISSIONS } from "../../apps/api/src/auth";
import db, { schema } from "../../apps/api/src/database";
import { operonProjectFieldLabelsTable } from "../../apps/api/src/database/schema";
import { createApp } from "../../apps/api/src/index";
import { initializePlugins } from "../../apps/api/src/plugins";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

/**
 * Operon fork checks (social agent S18, task 6): optional per-project field labels.
 *
 * GET for workspace access (Operon's key included); PUT for a signed-in project admin only;
 * empty = NULL, both cleared = no row; at most 40 characters; webhook payloads unchanged.
 *
 * See `docs/fork-discipline.md` in the Operon repository.
 */

vi.mock("../../apps/api/src/plugins/generic-webhook/config", async (orig) => ({
  ...(await orig<
    typeof import("../../apps/api/src/plugins/generic-webhook/config")
  >()),
  assertPublicWebhookDestination: async () => {},
}));

const HOOK_URL = "https://operon.example.test/webhooks/kaneo";
const SECRET = "field-labels-test-secret";
let deliveries: Record<string, unknown>[] = [];

beforeAll(() => {
  initializePlugins();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === HOOK_URL) {
        const body = String(init.body);
        expect(
          (init.headers as Record<string, string>)["X-Kaneo-Signature"],
        ).toBe(createHmac("sha256", SECRET).update(body).digest("hex"));
        deliveries.push(JSON.parse(body));
      }
      return new Response("ok", { status: 200 });
    }),
  );
});

async function seed() {
  const owner = await createWorkspaceMember({ role: "owner" });
  const { project } = await createProjectFixture({
    workspaceId: owner.workspace.id,
    name: "Rella",
  });
  const plain = await createWorkspaceMember({ userName: "Plain Member" });
  await db.insert(schema.workspaceUserTable).values({
    workspaceId: owner.workspace.id,
    userId: plain.user.id,
    role: "member",
    joinedAt: new Date(),
  });
  const { app } = createApp();
  const path = `/api/operon/project-field-labels/${project.id}`;
  const put = (body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const get = (headers: Record<string, string> = {}) =>
    app.request(path, { headers });
  return { owner, plain: plain.user, project, app, put, get };
}

async function mintServiceKey(userId: string) {
  const created = await auth.api.createApiKey({
    body: {
      userId,
      name: `labels-service-${Date.now() % 100000}`,
      permissions: OPERON_SERVICE_KEY_PERMISSIONS,
      metadata: { operonService: true },
    },
  });
  if (!created?.key) throw new Error("failed to mint a test api key");
  return created.key;
}

describe("API integration: Operon project field labels (social agent S18)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    deliveries = [];
  });

  it("reads null labels for a project that never set them", async () => {
    const { owner, project, get } = await seed();
    mockAuthenticatedSession(owner.user);
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projectId: project.id,
      descriptionLabel: null,
      dueDateLabel: null,
    });
  });

  it("lets a project admin set both labels, and clearing both removes the row", async () => {
    const { owner, project, put, get } = await seed();
    mockAuthenticatedSession(owner.user);

    const set = await put({
      descriptionLabel: "  Caption ",
      dueDateLabel: "Publish date",
    });
    expect(set.status).toBe(200);
    expect(await (await get()).json()).toEqual({
      projectId: project.id,
      descriptionLabel: "Caption",
      dueDateLabel: "Publish date",
    });

    const cleared = await put({ descriptionLabel: "", dueDateLabel: "   " });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({
      projectId: project.id,
      descriptionLabel: null,
      dueDateLabel: null,
    });
    const rows = await db.select().from(operonProjectFieldLabelsTable);
    expect(rows).toHaveLength(0);
  });

  it("refuses a 41-character label with 400 and stores nothing", async () => {
    const { owner, put } = await seed();
    mockAuthenticatedSession(owner.user);
    const response = await put({ descriptionLabel: "x".repeat(41) });
    expect(response.status).toBe(400);
    expect(await db.select().from(operonProjectFieldLabelsTable)).toHaveLength(
      0,
    );
    expect((await put({ descriptionLabel: "x".repeat(40) })).status).toBe(200);
  });

  it("refuses a member who is not a project admin with 403", async () => {
    const { plain, put, get } = await seed();
    mockAuthenticatedSession(plain);
    expect((await put({ descriptionLabel: "Caption" })).status).toBe(403);
    // A member still reads them.
    expect((await get()).status).toBe(200);
    expect(await db.select().from(operonProjectFieldLabelsTable)).toHaveLength(
      0,
    );
  });

  it("lets Operon's service key GET and never PUT", async () => {
    const { owner, project, put, get } = await seed();
    mockAuthenticatedSession(owner.user);
    expect((await put({ dueDateLabel: "Publish date" })).status).toBe(200);
    const key = await mintServiceKey(owner.user.id);
    vi.restoreAllMocks();

    const read = await get({ "x-api-key": key });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      projectId: project.id,
      descriptionLabel: null,
      dueDateLabel: "Publish date",
    });
    const write = await put({ dueDateLabel: "Hijacked" }, { "x-api-key": key });
    expect(write.status).toBe(403);
    const [row] = await db.select().from(operonProjectFieldLabelsTable);
    expect(row?.dueDateLabel).toBe("Publish date");
  });

  it("leaves the status-change webhook payload byte-identical with or without labels", async () => {
    const { owner, project, app, put } = await seed();
    await db.insert(schema.integrationTable).values({
      projectId: project.id,
      type: "generic-webhook",
      config: JSON.stringify({
        webhookUrl: HOOK_URL,
        secret: SECRET,
        events: { taskStatusChanged: true },
      }),
      isActive: true,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Launch post",
        status: "to-do",
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();
    if (!task) throw new Error("task insert failed");
    mockAuthenticatedSession(owner.user);
    const move = async (status: string) => {
      const before = deliveries.length;
      const response = await app.request(`/api/task/status/${task.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      expect(response.status).toBe(200);
      for (let i = 0; i < 100 && deliveries.length === before; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const delivery = deliveries[before];
      if (!delivery) throw new Error("no webhook delivered");
      // The send time and the revision differ between two deliveries by design.
      const { timestamp: _t, ...rest } = delivery;
      const data = { ...(rest.data as Record<string, unknown>) };
      delete data.socialRevision;
      return JSON.stringify({ ...rest, data });
    };

    expect(
      (await put({ descriptionLabel: "Caption", dueDateLabel: "Publish date" }))
        .status,
    ).toBe(200);
    const withLabels = await move("in-review");
    await move("to-do");
    expect((await put({ descriptionLabel: "", dueDateLabel: "" })).status).toBe(
      200,
    );
    const withoutLabels = await move("in-review");

    expect(withLabels).toBe(withoutLabels);
    expect(withLabels).not.toContain("Caption");
    expect(withLabels).not.toContain("Publish date");
  });
});
