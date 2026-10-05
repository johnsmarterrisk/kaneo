import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { operonMemberPayload } from "../../packages/permissions/src/index";

/**
 * Operon fork checks — an Operon agent's own Initiative key (Operon agent-initiative spec
 * D3, D4, D7, D8, D11, D13).
 *
 * The mint and revoke routes answer only the service key; an agent key reaches only two
 * Better Auth reads and never echoes itself; the hosted MCP endpoint admits it. Every
 * case here runs with Operon's liveness route (D20, `operon-agent-liveness.test.ts`)
 * stubbed to answer `{ active: true }`.
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
setEnv("OPERON_KANEO_S2S_SECRET", "agent-key-suite-secret");
setEnv("KANEO_INTERNAL_API_URL", `http://127.0.0.1:${appPort}`);

const { createApp } = await import("../../apps/api/src/index");
const { auth } = await import("../../apps/api/src/auth");
const { default: db, schema } = await import("../../apps/api/src/database");
const { resetTestDatabase } = await import("./helpers/database");
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

const D7_REFUSAL =
  "An Operon agent key may only read its own session and workspaces.";

let holder: Awaited<ReturnType<typeof createWorkspaceMember>>;
let serviceKey: string;
let agent: typeof schema.userTable.$inferSelect;

async function mintKey(
  userId: string,
  body: { permissions?: Record<string, string[]>; metadata?: object } = {},
) {
  const created = await auth.api.createApiKey({
    body: { userId, name: "test-key", ...body },
  });
  if (!created?.key) throw new Error("failed to mint a test api key");
  return created.key;
}

async function newUser({
  role,
  workspaceRole = "member",
  operon = true,
}: {
  role?: string;
  workspaceRole?: string | null;
  operon?: boolean;
} = {}) {
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: `user-${randomUUID()}`,
      email: `agent-${randomUUID()}@example.com`,
      emailVerified: true,
      name: "Agent Smith",
      ...(role ? { role } : {}),
    })
    .returning();
  if (workspaceRole) {
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: holder.workspace.id,
      userId: user.id,
      role: workspaceRole,
      joinedAt: new Date(),
    });
  }
  if (operon) {
    // How Operon's `POST /user` marks a person it manages.
    await db.insert(schema.accountTable).values({
      accountId: randomUUID().replace(/-/g, "").padEnd(64, "0"),
      providerId: "custom",
      userId: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  return user;
}

function post(path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function mintAgentKey(userId = agent.id) {
  const response = await post(
    "/api/internal/operon/agent-key",
    { kaneoUserId: userId },
    { "x-api-key": serviceKey },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    key: string;
    keyId: string;
    expiresAt: string;
  };
}

async function keyRowsOf(userId: string) {
  return db
    .select()
    .from(schema.apikeyTable)
    .where(eq(schema.apikeyTable.referenceId, userId));
}

/** A real Better Auth session row, presented as its raw Bearer token or a signed cookie. */
async function humanSession(userId: string) {
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
  return {
    bearer: `Bearer ${token}`,
    cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
  };
}

const forms = (key: string) =>
  [
    ["x-api-key", { "x-api-key": key }],
    ["Bearer", { authorization: `Bearer ${key}` }],
  ] as const;

beforeEach(async () => {
  await resetTestDatabase();
  livenessCalls.length = 0;
  holder = await createWorkspaceMember({ role: "owner" });
  serviceKey = await mintKey(holder.user.id, {
    permissions: {
      workspace: ["manage_settings"],
      task: ["create", "update"],
      operon: ["rekey"],
    },
    metadata: { operonService: true },
  });
  agent = await newUser();
});

describe("POST /api/internal/operon/agent-key", () => {
  it("answers a key that lists the workspace's projects as the agent", async () => {
    await createProjectFixture({ workspaceId: holder.workspace.id });
    const response = await post(
      "/api/internal/operon/agent-key",
      { kaneoUserId: agent.id },
      { "x-api-key": serviceKey },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const minted = (await response.json()) as { key: string };
    expect(minted.key.startsWith("operon_agt_")).toBe(true);

    const projects = await app.request(
      `/api/project?workspaceId=${holder.workspace.id}`,
      { headers: { authorization: `Bearer ${minted.key}` } },
    );
    expect(projects.status).toBe(200);
    expect(await projects.json()).toHaveLength(1);
  });

  it("stores the prefix, the marker, the member ceiling and a 7-day expiry", async () => {
    const minted = await mintAgentKey();
    const [row] = await keyRowsOf(agent.id);
    expect(row?.id).toBe(minted.keyId);
    expect(row?.prefix).toBe("operon_agt_");
    expect(JSON.parse(row?.metadata ?? "null")).toEqual({ operonAgent: true });
    expect(JSON.parse(row?.permissions ?? "null")).toEqual(operonMemberPayload);
    expect(row?.rateLimitMax).toBe(100);
    expect(row?.rateLimitTimeWindow).toBe(60_000);
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const expiresIn = (row?.expiresAt?.getTime() ?? 0) - Date.now();
    expect(Math.abs(expiresIn - sevenDays)).toBeLessThan(60_000);
  });

  it("refuses everyone but the service key, and every target but a plain Operon member", async () => {
    const session = await humanSession(holder.user.id);
    const ordinary = await mintKey(holder.user.id);
    const callers: [string, Record<string, string>, number][] = [
      ["no credential", {}, 401],
      ["a session", { authorization: session.bearer }, 403],
      ["a non-service key", { "x-api-key": ordinary }, 403],
    ];
    for (const [label, headers, status] of callers) {
      const response = await post(
        "/api/internal/operon/agent-key",
        { kaneoUserId: agent.id },
        headers,
      );
      expect([label, response.status]).toEqual([label, status]);
    }

    const targets: [string, string, number][] = [
      ["the holder", holder.user.id, 409],
      [
        "an admin-role member",
        (await newUser({ workspaceRole: "admin" })).id,
        409,
      ],
      ["an instance admin", (await newUser({ role: "admin" })).id, 409],
      ["a non-Operon user", (await newUser({ operon: false })).id, 404],
      [
        "a user with no membership",
        (await newUser({ workspaceRole: null })).id,
        404,
      ],
    ];
    for (const [label, kaneoUserId, status] of targets) {
      const response = await post(
        "/api/internal/operon/agent-key",
        { kaneoUserId },
        { "x-api-key": serviceKey },
      );
      expect([label, response.status]).toEqual([label, status]);
      const agentRows = (await keyRowsOf(kaneoUserId)).filter(
        (row) => row.prefix === "operon_agt_",
      );
      expect([label, agentRows.length]).toEqual([label, 0]);
    }
  });
});

describe("POST /api/internal/operon/agent-key/revoke", () => {
  it("disables every enabled key of the user, then answers revoked 0", async () => {
    const first = await mintAgentKey();
    await mintAgentKey();
    const revoke = () =>
      post(
        "/api/internal/operon/agent-key/revoke",
        { kaneoUserId: agent.id },
        { "x-api-key": serviceKey },
      );

    const response = await revoke();
    expect(response.status).toBe(200);
    expect((await response.json()).revoked).toBe(2);
    expect((await keyRowsOf(agent.id)).every((row) => !row.enabled)).toBe(true);
    expect((await (await revoke()).json()).revoked).toBe(0);

    const after = await app.request(
      `/api/project?workspaceId=${holder.workspace.id}`,
      { headers: { authorization: `Bearer ${first.key}` } },
    );
    expect(after.status).toBe(401);
  });

  it("answers only the service key and refuses the holder", async () => {
    const ordinary = await mintKey(holder.user.id);
    const refused = await post(
      "/api/internal/operon/agent-key/revoke",
      { kaneoUserId: agent.id },
      { "x-api-key": ordinary },
    );
    expect(refused.status).toBe(403);
    const holderRevoke = await post(
      "/api/internal/operon/agent-key/revoke",
      { kaneoUserId: holder.user.id },
      { "x-api-key": serviceKey },
    );
    expect(holderRevoke.status).toBe(409);
    expect((await keyRowsOf(holder.user.id)).every((row) => row.enabled)).toBe(
      true,
    );
  });
});

describe("whoami: /api/auth/get-session never echoes an agent key (D8)", () => {
  it("answers only the agent's id, name, user id and expiry, in either header", async () => {
    const { key } = await mintAgentKey();
    for (const [label, headers] of forms(key)) {
      const response = await app.request("/api/auth/get-session", { headers });
      const raw = await response.text();
      expect([label, response.status]).toEqual([label, 200]);
      expect(raw).not.toContain(key);
      const body = JSON.parse(raw);
      expect(Object.keys(body.user)).toEqual(["id", "name"]);
      expect(Object.keys(body.session)).toEqual(["userId", "expiresAt"]);
      expect(body.user).toEqual({ id: agent.id, name: "Agent Smith" });
      expect(body.session.userId).toBe(agent.id);
    }
    expect(livenessCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("leaves a human session's answer as Better Auth builds it", async () => {
    const session = await humanSession(holder.user.id);
    const response = await app.request("/api/auth/get-session", {
      headers: { authorization: session.bearer },
    });
    const body = await response.json();
    expect(body.user.email).toBe(holder.user.email);
    expect(body.session.token).toBe(session.bearer.slice("Bearer ".length));
  });
});

describe("an agent key stays out of Better Auth (D7)", () => {
  const refusedCalls: [string, string][] = [
    ["POST", "update-user"],
    ["POST", "api-key/create"],
    ["POST", "api-key/verify"],
    ["POST", "delete-user"],
    ["GET", "list-sessions"],
    ["POST", "admin/set-role"],
    ["GET", "admin/list-users"],
    ["POST", "device/approve"],
    ["POST", "get-session"],
    ["GET", "get-session/"],
  ];

  async function call(method: string, path: string, headers: object) {
    return app.request(`/api/auth/${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(method === "POST"
        ? { body: JSON.stringify({ name: "Renamed", userId: agent.id }) }
        : {}),
    });
  }

  it("refuses every other path with 403, in either header", async () => {
    const { key } = await mintAgentKey();
    for (const [label, headers] of forms(key)) {
      for (const [method, path] of refusedCalls) {
        const response = await call(method, path, headers);
        expect([label, method, path, response.status]).toEqual([
          label,
          method,
          path,
          403,
        ]);
        expect((await response.json()).error).toBe(D7_REFUSAL);
      }
    }
    const [row] = await db
      .select({ name: schema.userTable.name })
      .from(schema.userTable)
      .where(eq(schema.userTable.id, agent.id));
    expect(row?.name).toBe("Agent Smith");
  });

  it("answers the two allowed reads, in either header", async () => {
    const { key } = await mintAgentKey();
    for (const [label, headers] of forms(key)) {
      const workspaces = await app.request("/api/auth/organization/list", {
        headers,
      });
      expect([label, workspaces.status]).toEqual([label, 200]);
      const body = (await workspaces.json()) as { id: string }[];
      expect(body.map((workspace) => workspace.id)).toEqual([
        holder.workspace.id,
      ]);
      const session = await app.request("/api/auth/get-session", { headers });
      expect([label, session.status]).toEqual([label, 200]);
    }
  });

  it("never lets a second credential carry an agent key past the allowlist", async () => {
    const { key } = await mintAgentKey();
    const human = await humanSession(holder.user.id);
    const mixes: [string, Record<string, string>][] = [
      [
        "agent x-api-key + junk Bearer",
        { "x-api-key": key, authorization: "Bearer junk" },
      ],
      [
        "agent Bearer + junk x-api-key",
        { authorization: `Bearer ${key}`, "x-api-key": "junk" },
      ],
      [
        "agent x-api-key + human Bearer",
        { "x-api-key": key, authorization: human.bearer },
      ],
      [
        "agent Bearer + human cookie",
        { authorization: `Bearer ${key}`, cookie: human.cookie },
      ],
      [
        "agent x-api-key + human cookie",
        { "x-api-key": key, cookie: human.cookie },
      ],
    ];
    for (const [label, headers] of mixes) {
      for (const path of ["update-user", "list-sessions"]) {
        const method = path === "update-user" ? "POST" : "GET";
        const response = await call(method, path, headers);
        expect([label, path, response.status]).toEqual([label, path, 403]);
      }
    }
    // The human cookie on its own does work, so the refusals above are the guard.
    const humanOnly = await call("GET", "list-sessions", {
      cookie: human.cookie,
    });
    expect(humanOnly.status).toBe(200);
  });

  it("gives an invalid, a revoked and an expired agent key no user, token or workspace", async () => {
    const revoked = await mintAgentKey();
    const expired = await mintAgentKey();
    await db
      .update(schema.apikeyTable)
      .set({ enabled: false })
      .where(eq(schema.apikeyTable.id, revoked.keyId));
    await db
      .update(schema.apikeyTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.apikeyTable.id, expired.keyId));
    const dead: [string, string][] = [
      ["invalid", `operon_agt_${"x".repeat(64)}`],
      ["revoked", revoked.key],
      ["expired", expired.key],
    ];
    for (const [kind, key] of dead) {
      for (const [label, headers] of forms(key)) {
        const session = await app.request("/api/auth/get-session", { headers });
        const sessionBody = await session.text();
        expect([kind, label, sessionBody.includes(agent.id)]).toEqual([
          kind,
          label,
          false,
        ]);
        expect(sessionBody).not.toContain(key);
        const workspaces = await app.request("/api/auth/organization/list", {
          headers,
        });
        expect([kind, label, workspaces.status]).toEqual([kind, label, 401]);
        const rename = await call("POST", "update-user", headers);
        expect([kind, label, rename.status === 200]).toEqual([
          kind,
          label,
          false,
        ]);
      }
    }
  });

  it("leaves a human session's update-user and list-sessions unchanged", async () => {
    const human = await humanSession(holder.user.id);
    const sessions = await call("GET", "list-sessions", {
      authorization: human.bearer,
    });
    expect(sessions.status).toBe(200);
    const rename = await call("POST", "update-user", { cookie: human.cookie });
    expect(rename.status).toBe(200);
  });

  it("is refused update_project's route with Insufficient API key scope", async () => {
    const { project } = await createProjectFixture({
      workspaceId: holder.workspace.id,
    });
    const { key } = await mintAgentKey();
    const response = await app.request(`/api/project/${project.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ name: "Renamed by an agent" }),
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Insufficient API key scope");
  });
});

describe("the hosted MCP endpoint admits an agent key (D13)", () => {
  const ACCEPT = "application/json, text/event-stream";

  function mcp(
    token: string | null,
    body: object,
    sessionId?: string,
  ): Promise<Response> {
    return app.request("/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: ACCEPT,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function rpc(response: Response) {
    const text = await response.text();
    const data = text
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice(6);
    return JSON.parse(data ?? text);
  }

  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "agent-key-suite", version: "1.0.0" },
    },
  };

  function expectChallenge(response: Response) {
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(
      /^Bearer resource_metadata=".*\/api\/\.well-known\/oauth-protected-resource\/api\/mcp"$/,
    );
  }

  it("completes initialize and tools/list, and whoami answers D8's shape", async () => {
    const { key } = await mintAgentKey();
    const init = await mcp(key, initialize);
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id") ?? "";
    expect(sessionId).not.toBe("");
    await rpc(init);

    const list = await rpc(
      await mcp(
        key,
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        sessionId,
      ),
    );
    expect(list.result.tools).toHaveLength(36);

    const whoami = await rpc(
      await mcp(
        key,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "whoami", arguments: {} },
        },
        sessionId,
      ),
    );
    const text = whoami.result.content[0].text as string;
    expect(text).not.toContain(key);
    const answer = JSON.parse(text);
    expect(answer.user).toEqual({ id: agent.id, name: "Agent Smith" });
    expect(answer.session.userId).toBe(agent.id);
  });

  it("keeps the 401 and challenge for every other credential", async () => {
    const revoked = await mintAgentKey();
    const expired = await mintAgentKey();
    await db
      .update(schema.apikeyTable)
      .set({ enabled: false })
      .where(eq(schema.apikeyTable.id, revoked.keyId));
    await db
      .update(schema.apikeyTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.apikeyTable.id, expired.keyId));
    const userKey = await mintKey(agent.id, {
      permissions: { workspace: ["read"] },
    });
    for (const token of [serviceKey, userKey, revoked.key, expired.key, null]) {
      expectChallenge(await mcp(token, initialize));
    }
  });

  it("refuses a key revoked between two requests of one MCP session", async () => {
    const { key } = await mintAgentKey();
    const init = await mcp(key, initialize);
    const sessionId = init.headers.get("mcp-session-id") ?? "";
    await rpc(init);
    await post(
      "/api/internal/operon/agent-key/revoke",
      { kaneoUserId: agent.id },
      { "x-api-key": serviceKey },
    );
    expectChallenge(
      await mcp(
        key,
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        sessionId,
      ),
    );
  });
});
