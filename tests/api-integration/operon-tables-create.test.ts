import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Operon fork checks — Tables task 3 (docs/fork-discipline.md row 18, spec 7.2, R-D,
 * RF-4, RF-9): "New table" creates a flagged project from the Marketing asset template in
 * one transaction, announces it after commit with a stable timestamp, and only a workspace
 * owner/admin or an instance admin may do it — never an API key, never a custom role.
 *
 * A local HTTP server stands in for Operon at `OPERON_INTERNAL_API_URL`: it answers the
 * agent liveness check and records each signed `project.created`.
 */
function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const WEBHOOK_SECRET = "tables-create-webhook-secret";
const S2S_SECRET = "tables-create-s2s-secret";

type Delivery = { signatureOk: boolean; body: Record<string, unknown> };
const deliveries: Delivery[] = [];
let webhookStatus = 200;

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
    if (req.url === "/webhooks/kaneo") {
      const signature = String(req.headers["x-kaneo-signature"] ?? "");
      const expected = createHmac("sha256", WEBHOOK_SECRET)
        .update(raw)
        .digest("hex");
      deliveries.push({
        signatureOk: signature === expected,
        body: JSON.parse(raw),
      });
      res.writeHead(webhookStatus);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
});
const platformPort = await listen(platform);

setEnv("OPERON_INTERNAL_API_URL", `http://127.0.0.1:${platformPort}`);
setEnv("KANEO_WEBHOOK_SECRET", WEBHOOK_SECRET);
setEnv("OPERON_KANEO_S2S_SECRET", S2S_SECRET);
setEnv("KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS", "true");

const { createApp } = await import("../../apps/api/src/index");
const { auth, OPERON_SERVICE_KEY_PERMISSIONS } = await import(
  "../../apps/api/src/auth"
);
const { default: db } = await import("../../apps/api/src/database");
const { createTableHooks, tableAnnouncement } = await import(
  "../../apps/api/src/operon-tables/create-table"
);
const { deliverOperonProjectCreated } = await import(
  "../../apps/api/src/operon-project-created"
);
const { mockAuthenticatedSession } = await import("./helpers/auth");
const { resetTestDatabase } = await import("./helpers/database");
const { createProjectFixture, createWorkspaceMember } = await import(
  "./helpers/fixtures"
);

const { app } = createApp();

afterAll(() => {
  platform.close();
});

const {
  customFieldDefinitionTable,
  operonTableProjectTable,
  projectTable,
  workspaceUserTable,
  workspaceRoleTable,
  workspaceBillingTable,
  userTable,
} = await import("../../apps/api/src/database/schema");

function postTable(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.request("/api/operon/tables", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function addMember(workspaceId: string, role: string, userRole?: string) {
  const [user] = await db
    .insert(userTable)
    .values({
      id: `user-${randomUUID()}`,
      email: `${randomUUID()}@example.com`,
      emailVerified: true,
      name: `Member ${role}`,
      ...(userRole ? { role: userRole } : {}),
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

async function tableRows() {
  return db.select().from(operonTableProjectTable);
}

function createdFor(projectId: string) {
  return deliveries.filter(
    (d) =>
      d.body.event === "project.created" &&
      (d.body.project as { id: string }).id === projectId,
  );
}

async function waitFor(check: () => Promise<boolean>, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

describe("API integration: Tables — New table (task 3)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    deliveries.length = 0;
    webhookStatus = 200;
    createTableHooks.afterTemplateInsert = undefined;
  });

  it("creates a flagged project with the five template columns and announces it after commit", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(owner.user);

    const response = await postTable({
      workspaceId: owner.workspace.id,
      name: "Risk tips",
      slug: "RISK",
    });
    expect(response.status).toBe(200);
    const created = (await response.json()) as { id: string; icon: string };
    expect(created.icon).toBe("Layout");

    const definitions = await db
      .select()
      .from(customFieldDefinitionTable)
      .where(eq(customFieldDefinitionTable.projectId, created.id));
    const byName = Object.fromEntries(definitions.map((d) => [d.name, d]));
    expect(definitions).toHaveLength(5);
    expect(definitions.map((d) => [d.name, d.type]).sort()).toEqual(
      [
        ["Channel", "dropdown"],
        ["Link", "link"],
        ["Posted", "date"],
        ["Status", "dropdown"],
        ["Topic", "dropdown"],
      ].sort(),
    );
    expect(byName.Status.options).toEqual(["Idea", "In progress", "Published"]);
    expect(byName.Channel.options).toEqual(["LinkedIn", "Newsletter", "Site"]);
    expect(byName.Topic.options).toEqual([]);

    const [flag] = await tableRows();
    expect(flag.projectId).toBe(created.id);
    expect(flag.groupFieldId).toBe(byName.Topic.id);
    expect(flag.statusFieldId).toBe(byName.Status.id);
    expect(flag.dateFieldId).toBe(byName.Posted.id);
    expect(flag.createdByUserId).toBe(owner.user.id);

    const announced = createdFor(created.id);
    expect(announced).toHaveLength(1);
    expect(announced[0].signatureOk).toBe(true);
    expect(
      (announced[0].body.data as Record<string, unknown>).operonTable,
    ).toBe(true);
    const [project] = await db
      .select()
      .from(projectTable)
      .where(eq(projectTable.id, created.id));
    expect(announced[0].body.timestamp).toBe(project.createdAt.toISOString());
    expect(
      await waitFor(async () => Boolean((await tableRows())[0]?.announcedAt)),
    ).toBe(true);

    const read = await app.request(`/api/operon/tables/${created.id}`);
    expect(read.status).toBe(200);
    const table = (await read.json()) as {
      columns: unknown[];
      isTable: boolean;
    };
    expect(table.isTable).toBe(true);
    expect(table.columns).toHaveLength(5);
  });

  it("lets a workspace admin and an instance admin create a table", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    const admin = await addMember(owner.workspace.id, "admin");
    const instanceAdmin = await addMember(
      owner.workspace.id,
      "member",
      "admin",
    );

    for (const user of [admin, instanceAdmin]) {
      mockAuthenticatedSession(user);
      const response = await postTable({
        workspaceId: owner.workspace.id,
        name: `Table by ${user.id}`,
        slug: "TBL",
      });
      expect(response.status).toBe(200);
    }
    expect(await tableRows()).toHaveLength(2);
  });

  it("refuses a member, a custom role granted project:update, and every API key", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    const member = await addMember(owner.workspace.id, "member");
    await db.insert(workspaceRoleTable).values({
      workspaceId: owner.workspace.id,
      role: "editor",
      permission: JSON.stringify({
        project: ["create", "read", "update", "delete"],
        task: ["create", "read", "update", "delete"],
      }),
    });
    const editor = await addMember(owner.workspace.id, "editor");
    const agent = await addMember(owner.workspace.id, "member");
    const body = { workspaceId: owner.workspace.id, name: "Nope", slug: "NO" };

    mockAuthenticatedSession(member);
    const asMember = await postTable(body);
    expect(asMember.status).toBe(403);
    expect(await asMember.json()).toMatchObject({ error: "admin_only" });

    mockAuthenticatedSession(editor);
    const asEditor = await postTable(body);
    expect(asEditor.status).toBe(403);
    expect(await asEditor.json()).toMatchObject({ error: "admin_only" });

    const ownerKey = await auth.api.createApiKey({
      body: { userId: owner.user.id, name: "owner-key" },
    });
    const serviceKey = await auth.api.createApiKey({
      body: {
        userId: owner.user.id,
        name: "service-key",
        permissions: OPERON_SERVICE_KEY_PERMISSIONS,
        metadata: { operonService: true },
      },
    });
    const agentKey = await auth.api.createApiKey({
      body: {
        userId: agent.id,
        name: "agent-key",
        metadata: { operonAgent: true },
      },
    });
    for (const key of [ownerKey.key, serviceKey.key, agentKey.key]) {
      const response = await postTable(body, { "x-api-key": key });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: "api_key_not_allowed",
      });
    }

    expect(await tableRows()).toHaveLength(0);
    expect(
      await db
        .select()
        .from(projectTable)
        .where(eq(projectTable.workspaceId, owner.workspace.id)),
    ).toHaveLength(0);
  });

  it("refuses a built-in admin role whose project:create an admin removed", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    const admin = await addMember(owner.workspace.id, "admin");
    await db.insert(workspaceRoleTable).values({
      workspaceId: owner.workspace.id,
      role: "admin",
      permission: JSON.stringify({ project: ["read", "update"] }),
    });
    mockAuthenticatedSession(admin);
    const response = await postTable({
      workspaceId: owner.workspace.id,
      name: "Nope",
      slug: "NO",
    });
    expect(response.status).toBe(403);
    expect(await tableRows()).toHaveLength(0);
  });

  it("refuses a workspace the project-create entitlement gate denies", async () => {
    const saved = {
      KANEO_CLOUD: process.env.KANEO_CLOUD,
      CREEM_API_KEY: process.env.CREEM_API_KEY,
      CREEM_WEBHOOK_SECRET: process.env.CREEM_WEBHOOK_SECRET,
    };
    setEnv("KANEO_CLOUD", "true");
    setEnv("CREEM_API_KEY", "creem_test_dummy");
    setEnv("CREEM_WEBHOOK_SECRET", "whsec_dummy");
    try {
      const owner = await createWorkspaceMember({ role: "owner" });
      await db.insert(workspaceBillingTable).values({
        workspaceId: owner.workspace.id,
        foundingFree: false,
        trialEndsAt: new Date(Date.now() - 60_000),
      });
      mockAuthenticatedSession(owner.user);
      const response = await postTable({
        workspaceId: owner.workspace.id,
        name: "Nope",
        slug: "NO",
      });
      expect(response.status).toBe(402);
      expect(await tableRows()).toHaveLength(0);
    } finally {
      for (const [key, value] of Object.entries(saved)) setEnv(key, value);
    }
  });

  it("rolls back project, flag and template on a failure after the template insert, and announces nothing", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(owner.user);
    createTableHooks.afterTemplateInsert = async () => {
      throw new Error("injected after template");
    };
    const response = await postTable({
      workspaceId: owner.workspace.id,
      name: "Doomed",
      slug: "DOOM",
    });
    expect(response.status).toBe(500);
    expect(await tableRows()).toHaveLength(0);
    expect(
      await db
        .select()
        .from(projectTable)
        .where(eq(projectTable.workspaceId, owner.workspace.id)),
    ).toHaveLength(0);
    expect(await db.select().from(customFieldDefinitionTable)).toHaveLength(0);
    expect(
      deliveries.filter((d) => d.body.event === "project.created"),
    ).toHaveLength(0);
  });

  it("leaves announced_at null when Operon refuses the announcement", async () => {
    webhookStatus = 500;
    const owner = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(owner.user);
    const response = await postTable({
      workspaceId: owner.workspace.id,
      name: "Refused",
      slug: "REF",
    });
    expect(response.status).toBe(200);
    const { id } = (await response.json()) as { id: string };
    expect(createdFor(id).length).toBeGreaterThanOrEqual(1);
    const [flag] = await tableRows();
    expect(flag.announcedAt).toBeNull();
  }, 15_000);

  it("re-announces with the same timestamp from committed rows, so a retry is the same event", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(owner.user);
    const response = await postTable({
      workspaceId: owner.workspace.id,
      name: "Stable",
      slug: "STB",
    });
    const { id } = (await response.json()) as { id: string };

    // A later reader (the outbox drain after a restart) rebuilds the announcement.
    const rebuilt = await tableAnnouncement(id);
    expect(rebuilt?.operonTable).toBe(true);
    await deliverOperonProjectCreated(
      rebuilt as NonNullable<typeof rebuilt>,
      new Date(Date.now() + 3_600_000),
    );

    const sent = createdFor(id);
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1].body)).toBe(JSON.stringify(sent[0].body));
  });

  it("never lets the ordinary project update set the table flag", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    const member = await addMember(owner.workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: owner.workspace.id,
    });
    const body = JSON.stringify({
      name: "Renamed",
      isTable: true,
      table: true,
    });
    const put = () =>
      app.request(`/api/project/${project.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      });
    mockAuthenticatedSession(member);
    expect((await put()).status).toBe(403);
    mockAuthenticatedSession(owner.user);
    expect((await put()).status).toBe(200);
    expect(await tableRows()).toHaveLength(0);
    const notATable = await app.request(`/api/operon/tables/${project.id}`);
    expect(notATable.status).toBe(404);
    expect(await notATable.json()).toMatchObject({ error: "not_a_table" });
  });
});
