import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Operon fork checks — Operon is the single authority on agent liveness (Operon
 * agent-initiative spec D20, D13's consent guard).
 *
 * Every path that accepts a verified agent key asks the platform, signed, on every
 * request, and FAILS CLOSED with exactly the answer a revoked key gets on that path. A
 * local HTTP server stands in for the platform's `POST /internal/kaneo/agent-active`
 * and records every request. Operon mode is set before the imports, as in
 * `operon-agent-key.test.ts`. See `docs/fork-discipline.md` in the Operon repository.
 */
function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const SECRET = "agent-liveness-suite-secret";

type Mode =
  | "active"
  | "inactive"
  | "404"
  | "500"
  | "redirect"
  | "non-json"
  | "string-true"
  | "empty"
  | "hang"
  | "stall-body";

let mode: Mode = "active";
/** Per-user override, for the two-agents case. */
const modeFor = new Map<string, Mode>();
const received: { signature: string; raw: string }[] = [];
const open = new Set<http.ServerResponse>();

const platform = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    received.push({
      signature: String(req.headers["x-operon-signature"] ?? ""),
      raw,
    });
    const kaneoUserId = (JSON.parse(raw) as { kaneoUserId: string })
      .kaneoUserId;
    // Where the redirect points: a vouching answer, so following it would be caught.
    const answer =
      req.url === "/followed" ? "active" : (modeFor.get(kaneoUserId) ?? mode);
    const json = (status: number, body: string) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    };
    if (answer === "active") return json(200, '{"active":true}');
    if (answer === "inactive") return json(200, '{"active":false}');
    if (answer === "404") return json(404, '{"active":true}');
    if (answer === "500") return json(500, '{"active":true}');
    if (answer === "non-json") return json(200, "active");
    if (answer === "string-true") return json(200, '{"active":"true"}');
    if (answer === "empty") return json(200, "{}");
    if (answer === "redirect") {
      res.writeHead(307, { Location: "/followed" });
      return res.end();
    }
    open.add(res);
    if (answer === "stall-body") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"active":');
    }
  });
});
const platformPort = await listen(platform);
const platformUrl = `http://127.0.0.1:${platformPort}`;

const reserve = http.createServer();
const appPort = await listen(reserve);
await new Promise((resolve) => reserve.close(resolve));
const closed = http.createServer();
const closedPort = await listen(closed);
await new Promise((resolve) => closed.close(resolve));

setEnv("OPERON_OIDC_ONLY", "true");
setEnv("OPERON_INTERNAL_API_URL", platformUrl);
setEnv("OPERON_KANEO_S2S_SECRET", SECRET);
setEnv("KANEO_INTERNAL_API_URL", `http://127.0.0.1:${appPort}`);

const { createApp } = await import("../../apps/api/src/index");
const { auth } = await import("../../apps/api/src/auth");
const { default: db, schema } = await import("../../apps/api/src/database");
const { resetTestDatabase } = await import("./helpers/database");
const { createProjectFixture, createWorkspaceMember } = await import(
  "./helpers/fixtures"
);

const { app, injectWebSocket } = createApp();
const server = serve({
  fetch: app.fetch,
  port: appPort,
  hostname: "127.0.0.1",
});
injectWebSocket(server);

/** A real WebSocket upgrade against the served app: 101, or the refusal's status. */
function upgrade(path: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: appPort,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

afterAll(() => {
  server.close();
  platform.close();
});

let holder: Awaited<ReturnType<typeof createWorkspaceMember>>;
let serviceKey: string;
let agentId: string;
let projectId: string;
let assetId: string;
let warn: ReturnType<typeof vi.spyOn>;

async function newAgent() {
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: `user-${randomUUID()}`,
      email: `agent-${randomUUID()}@example.com`,
      emailVerified: true,
      name: "Agent",
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
  return user.id;
}

async function mintAgentKey(kaneoUserId = agentId) {
  const response = await app.request("/api/internal/operon/agent-key", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": serviceKey },
    body: JSON.stringify({ kaneoUserId }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { key: string; keyId: string };
}

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
    token,
    bearer: `Bearer ${token}`,
    cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
  };
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const legacyInitialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "liveness-suite", version: "1.0.0" },
  },
});
const MODERN = "2026-07-28";
const modernToolsList = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN,
      "io.modelcontextprotocol/clientInfo": { name: "suite", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
});

type Probe = { name: string; send: (key: string) => Promise<Response> };

/** Every path that accepts an agent key, each in every form it accepts one. */
function probes(): Probe[] {
  const list: Probe[] = [];
  for (const [form, headers] of [
    ["x-api-key", (key: string) => ({ "x-api-key": key })],
    ["Bearer", (key: string) => ({ authorization: `Bearer ${key}` })],
  ] as const) {
    list.push(
      {
        name: `REST ${form}`,
        send: (key) =>
          app.request(`/api/project?workspaceId=${holder.workspace.id}`, {
            headers: headers(key),
          }),
      },
      {
        name: `asset ${form}`,
        send: (key) =>
          app.request(`/api/asset/${assetId}`, { headers: headers(key) }),
      },
      {
        name: `get-session ${form}`,
        send: (key) =>
          app.request("/api/auth/get-session", { headers: headers(key) }),
      },
      {
        name: `organization/list ${form}`,
        send: (key) =>
          app.request("/api/auth/organization/list", { headers: headers(key) }),
      },
    );
  }
  list.push(
    {
      name: "MCP legacy initialize",
      send: (key) =>
        app.request("/api/mcp", {
          method: "POST",
          headers: { ...MCP_HEADERS, authorization: `Bearer ${key}` },
          body: legacyInitialize,
        }),
    },
    {
      name: "MCP modern tools/list",
      send: (key) =>
        app.request("/api/mcp", {
          method: "POST",
          headers: {
            ...MCP_HEADERS,
            authorization: `Bearer ${key}`,
            "mcp-method": "tools/list",
            "mcp-protocol-version": MODERN,
          },
          body: modernToolsList,
        }),
    },
  );
  return list;
}

async function snapshot(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    challenge: response.headers.get("www-authenticate"),
  };
}

/** What a REVOKED (row-disabled) agent key gets on each probe: the refusal to match. */
async function revokedAnswers() {
  const revoked = await mintAgentKey();
  await db
    .update(schema.apikeyTable)
    .set({ enabled: false })
    .where(eq(schema.apikeyTable.id, revoked.keyId));
  const answers = new Map<string, Awaited<ReturnType<typeof snapshot>>>();
  for (const probe of probes()) {
    answers.set(probe.name, await snapshot(await probe.send(revoked.key)));
  }
  return answers;
}

beforeEach(async () => {
  await resetTestDatabase();
  mode = "active";
  modeFor.clear();
  received.length = 0;
  setEnv("OPERON_INTERNAL_API_URL", platformUrl);
  setEnv("OPERON_KANEO_S2S_SECRET", SECRET);
  holder = await createWorkspaceMember({ role: "owner" });
  const created = await auth.api.createApiKey({
    body: {
      userId: holder.user.id,
      name: "service",
      permissions: {
        workspace: ["manage_settings"],
        task: ["create", "update"],
        operon: ["rekey"],
      },
      metadata: { operonService: true },
    },
  });
  serviceKey = created?.key ?? "";
  agentId = await newAgent();
  const { project } = await createProjectFixture({
    workspaceId: holder.workspace.id,
  });
  projectId = project.id;
  const [asset] = await db
    .insert(schema.assetTable)
    .values({
      workspaceId: holder.workspace.id,
      projectId,
      objectKey: `objects/${randomUUID()}`,
      filename: "a.png",
      mimeType: "image/png",
      size: 1,
    })
    .returning();
  assetId = asset.id;
  warn = vi.spyOn(console, "warn");
});

afterEach(() => {
  for (const res of open) res.destroy();
  open.clear();
});

describe("a live agent passes every path", () => {
  it("answers on REST, assets, both auth reads and both MCP transports", async () => {
    const { key } = await mintAgentKey();
    for (const probe of probes()) {
      const response = await probe.send(key);
      // The asset has no stored object here, so a passed check ends in that 404.
      expect([probe.name, response.status]).toEqual([
        probe.name,
        probe.name.startsWith("asset") ? 404 : 200,
      ]);
    }
    expect(received.length).toBeGreaterThanOrEqual(probes().length);
  });

  it("signs a body of exactly {kaneoUserId, timestamp} with the shared secret", async () => {
    const { key } = await mintAgentKey();
    await app.request(`/api/project?workspaceId=${holder.workspace.id}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const [request] = received;
    expect(request?.signature).toBe(
      createHmac("sha256", SECRET)
        .update(request?.raw ?? "")
        .digest("hex"),
    );
    const body = JSON.parse(request?.raw ?? "{}");
    expect(Object.keys(body)).toEqual(["kaneoUserId", "timestamp"]);
    expect(body.kaneoUserId).toBe(agentId);
    expect(Math.abs(Date.parse(body.timestamp) - Date.now())).toBeLessThan(
      10_000,
    );
  });
});

describe("every failure refuses exactly as a revoked key is refused", () => {
  const failures: [string, () => void][] = [
    ["{active: false}", () => (mode = "inactive")],
    ["a 404", () => (mode = "404")],
    ["a 500", () => (mode = "500")],
    ["a redirect", () => (mode = "redirect")],
    ["a non-JSON body", () => (mode = "non-json")],
    ['{active: "true"}', () => (mode = "string-true")],
    ["{}", () => (mode = "empty")],
    [
      "a closed port",
      () => setEnv("OPERON_INTERNAL_API_URL", `http://127.0.0.1:${closedPort}`),
    ],
    ["an unset URL", () => setEnv("OPERON_INTERNAL_API_URL", undefined)],
    ["an unset secret", () => setEnv("OPERON_KANEO_S2S_SECRET", undefined)],
  ];

  for (const [label, arrange] of failures) {
    it(`refuses on ${label}`, async () => {
      const expected = await revokedAnswers();
      const { key } = await mintAgentKey();
      arrange();
      for (const probe of probes()) {
        const answer = await snapshot(await probe.send(key));
        expect([probe.name, answer]).toEqual([
          probe.name,
          expected.get(probe.name),
        ]);
        expect(answer.body).not.toContain(key);
      }
    });
  }

  for (const [label, stall] of [
    ["no answer within 2 s", "hang"],
    ["headers that arrive with a body that stalls", "stall-body"],
  ] as const) {
    it(`refuses on ${label}, by about 2 s`, async () => {
      const expected = await revokedAnswers();
      const { key } = await mintAgentKey();
      mode = stall;
      for (const probe of probes().filter((p) =>
        [
          "REST Bearer",
          "get-session x-api-key",
          "MCP legacy initialize",
        ].includes(p.name),
      )) {
        const started = Date.now();
        const answer = await snapshot(await probe.send(key));
        const elapsed = Date.now() - started;
        expect([probe.name, answer]).toEqual([
          probe.name,
          expected.get(probe.name),
        ]);
        expect(elapsed).toBeGreaterThanOrEqual(1900);
        expect(elapsed).toBeLessThan(3500);
      }
    });
  }

  it("logs the reason and ids on a refusal, and never the key", async () => {
    const { key, keyId } = await mintAgentKey();
    mode = "inactive";
    await app.request(`/api/project?workspaceId=${holder.workspace.id}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const lines = warn.mock.calls.map((call) => call.map(String).join(" "));
    expect(lines).toContain(
      `[operon] operon.agent_key_not_alive: kaneo user ${agentId} key ${keyId} reason not_active`,
    );
    expect(lines.some((line) => line.includes(key))).toBe(false);
  });
});

describe("nothing is cached, and sockets are refused", () => {
  it("refuses the second request of one MCP session once Operon says inactive", async () => {
    const { key } = await mintAgentKey();
    const init = await app.request("/api/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: `Bearer ${key}` },
      body: legacyInitialize,
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id") ?? "";
    await init.text();
    mode = "inactive";
    const next = await app.request("/api/mcp", {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        authorization: `Bearer ${key}`,
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(next.status).toBe(401);
  });

  it("refuses a live agent key at both WebSocket upgrades", async () => {
    const { key } = await mintAgentKey();
    const human = await humanSession(holder.user.id);
    for (const path of ["/api/ws/user", `/api/ws/${projectId}`]) {
      for (const headers of [
        { authorization: `Bearer ${key}` },
        { "x-api-key": key },
      ]) {
        expect([path, await upgrade(path, headers)]).toEqual([path, 401]);
      }
      // A human session on the same socket upgrades, so the refusal is the agent rule.
      expect([path, await upgrade(path, { cookie: human.cookie })]).toEqual([
        path,
        101,
      ]);
    }
  });
});

describe("humans and the service key never ask Operon", () => {
  it("makes no liveness request for a session, a human OAuth Bearer or the service key", async () => {
    mode = "inactive";
    const human = await humanSession(holder.user.id);
    const rest = await app.request(
      `/api/project?workspaceId=${holder.workspace.id}`,
      { headers: { cookie: human.cookie } },
    );
    expect(rest.status).toBe(200);
    const bearer = await app.request(
      `/api/project?workspaceId=${holder.workspace.id}`,
      { headers: { authorization: human.bearer } },
    );
    expect(bearer.status).toBe(200);
    // A human OAuth token on /api/mcp is a session row's raw token (`exchangeCode`).
    const mcp = await app.request("/api/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: human.bearer },
      body: legacyInitialize,
    });
    expect(mcp.status).toBe(200);
    await app.request(`/api/project?workspaceId=${holder.workspace.id}`, {
      headers: { "x-api-key": serviceKey },
    });
    expect(received).toHaveLength(0);
  });
});

describe("mixed headers never let a dead agent key through", () => {
  it("refuses a disabled agent beside junk, a live human Bearer or a human cookie", async () => {
    const { key } = await mintAgentKey();
    mode = "inactive";
    const human = await humanSession(holder.user.id);
    const mixes: Record<string, string>[] = [
      { "x-api-key": key, authorization: "Bearer junk" },
      { authorization: `Bearer ${key}`, "x-api-key": "junk" },
      { "x-api-key": key, authorization: human.bearer },
      { "x-api-key": key, cookie: human.cookie },
      { authorization: `Bearer ${key}`, cookie: human.cookie },
    ];
    for (const headers of mixes) {
      const label = Object.keys(headers).join("+");
      const rest = await app.request(
        `/api/project?workspaceId=${holder.workspace.id}`,
        { headers },
      );
      expect([label, "rest", rest.status]).toEqual([label, "rest", 401]);
      const asset = await app.request(`/api/asset/${assetId}`, { headers });
      expect([label, "asset", asset.status]).toEqual([label, "asset", 401]);
      for (const path of ["get-session", "organization/list"]) {
        const read = await app.request(`/api/auth/${path}`, { headers });
        const body = await read.text();
        expect([label, path, read.status]).toEqual([label, path, 401]);
        expect(body).not.toContain(agentId);
        expect(body).not.toContain(holder.user.id);
      }
    }
  });

  it("never turns a live agent key beside a bad Bearer into an unscoped session", async () => {
    const { key } = await mintAgentKey();
    const headers = { "x-api-key": key, authorization: "Bearer junk" };
    const rest = await app.request(
      `/api/project?workspaceId=${holder.workspace.id}`,
      { headers },
    );
    expect(rest.status).toBe(401);
    const asset = await app.request(`/api/asset/${assetId}`, { headers });
    expect(asset.status).toBe(401);
  });

  it("refuses two agent keys for different users on an auth read", async () => {
    const live = await mintAgentKey();
    const otherId = await newAgent();
    const other = await mintAgentKey(otherId);
    for (const disabled of [true, false]) {
      if (disabled) modeFor.set(otherId, "inactive");
      else modeFor.clear();
      for (const headers of [
        { "x-api-key": live.key, authorization: `Bearer ${other.key}` },
        { "x-api-key": other.key, authorization: `Bearer ${live.key}` },
      ]) {
        const read = await app.request("/api/auth/get-session", { headers });
        const body = await read.text();
        expect(read.status).toBe(401);
        expect(body).not.toContain(agentId);
        expect(body).not.toContain(otherId);
      }
    }
  });
});

describe("an agent key never approves MCP consent (D13)", () => {
  const CLIENT_ORIGIN = "http://localhost:5173";
  const REDIRECT = "http://127.0.0.1:9/callback";
  const VERIFIER = "v".repeat(64);

  async function pendingRequest() {
    const registered = await app.request("/api/mcp/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "suite" }),
    });
    const { client_id } = (await registered.json()) as { client_id: string };
    const challenge = createHash("sha256").update(VERIFIER).digest("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const begun = await app.request(`/api/mcp/authorize?${query}`);
    const requestId =
      new URL(begun.headers.get("location") ?? "http://x").searchParams.get(
        "request_id",
      ) ?? "";
    expect(requestId).not.toBe("");
    return { client_id, requestId };
  }

  function decide(requestId: string, headers: Record<string, string>) {
    return app.request(`/api/mcp/authorize/request/${requestId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: CLIENT_ORIGIN,
        ...headers,
      },
      body: JSON.stringify({ approved: true }),
    });
  }

  async function sessionCount() {
    return (await db.select().from(schema.sessionTable)).length;
  }

  it("refuses a live or an Operon-disabled agent key before any code or session", async () => {
    const { key } = await mintAgentKey();
    const human = await humanSession(holder.user.id);
    const before = await sessionCount();
    for (const disabled of [false, true]) {
      mode = disabled ? "inactive" : "active";
      for (const headers of [
        { "x-api-key": key },
        { authorization: `Bearer ${key}` },
        { "x-api-key": key, cookie: human.cookie },
        { authorization: `Bearer ${key}`, cookie: human.cookie },
      ]) {
        const { requestId } = await pendingRequest();
        const response = await decide(requestId, headers);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: "agent_key_cannot_authorize",
        });
        // Still pending: nothing was consumed, so no code exists.
        const pending = await app.request(
          `/api/mcp/authorize/request/${requestId}`,
        );
        expect(pending.status).toBe(200);
      }
    }
    expect(await sessionCount()).toBe(before);
    const codes = await db
      .select()
      .from(schema.mcpOauthStateTable)
      .where(eq(schema.mcpOauthStateTable.kind, "code"));
    expect(codes).toHaveLength(0);
  });

  it("still issues and exchanges a code for a human while the platform is down", async () => {
    setEnv("OPERON_INTERNAL_API_URL", `http://127.0.0.1:${closedPort}`);
    const human = await humanSession(holder.user.id);
    const { client_id, requestId } = await pendingRequest();
    const response = await decide(requestId, { cookie: human.cookie });
    expect(response.status).toBe(200);
    const { redirect } = (await response.json()) as { redirect: string };
    const code = new URL(redirect).searchParams.get("code") ?? "";
    expect(code).not.toBe("");
    const token = await app.request("/api/mcp/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id,
        code_verifier: VERIFIER,
        redirect_uri: REDIRECT,
      }).toString(),
    });
    expect(token.status).toBe(200);
    expect(
      ((await token.json()) as { access_token: string }).access_token,
    ).toBeTruthy();
    expect(received).toHaveLength(0);
  });
});
