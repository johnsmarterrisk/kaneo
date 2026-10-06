import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
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
 * Operon fork checks — group mentions read from Operon (Operon group-mentions spec D10,
 * D11, D14; fork-discipline row 15).
 *
 * A local HTTP server stands in for Operon's signed `POST /internal/kaneo/groups`, checks
 * the signature and the exact body, and answers per asker. The fork's route answers a
 * browser session with a real Operon-workspace membership only, and every comment or
 * description save expands `group:<slug>` from a fresh read into the task workspace's
 * members before Kaneo's own notifications run.
 */
function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const SECRET = "group-mentions-suite-secret";

type Answer =
  | { status: number; body: string }
  | { groups: Record<string, unknown>[] };

/** What the platform answers, per asking Kaneo user (default: `defaultAnswer`). */
const answers = new Map<string, Answer>();
let defaultAnswer: Answer = { groups: [] };
const received: { signatureOk: boolean; body: Record<string, unknown> }[] = [];

const platform = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    const signature = String(req.headers["x-operon-signature"] ?? "");
    const expected = createHmac("sha256", SECRET).update(raw).digest("hex");
    const body = JSON.parse(raw) as Record<string, unknown>;
    received.push({ signatureOk: signature === expected, body });
    if (req.url !== "/internal/kaneo/groups" || signature !== expected) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end('{"error":"invalid signature"}');
    }
    const answer = answers.get(String(body.kaneoUserId)) ?? defaultAnswer;
    res.writeHead("status" in answer ? answer.status : 200, {
      "Content-Type": "application/json",
    });
    res.end("status" in answer ? answer.body : JSON.stringify(answer));
  });
});
const platformPort = await listen(platform);
const platformUrl = `http://127.0.0.1:${platformPort}`;
const closed = http.createServer();
const closedPort = await listen(closed);
await new Promise((resolve) => closed.close(resolve));

setEnv("OPERON_OIDC_ONLY", "true");
setEnv("OPERON_INTERNAL_API_URL", platformUrl);
setEnv("OPERON_KANEO_S2S_SECRET", SECRET);

const { createApp } = await import("../../apps/api/src/index");
const { auth } = await import("../../apps/api/src/auth");
const { default: db, schema } = await import("../../apps/api/src/database");
const { resetTestDatabase } = await import("./helpers/database");
const { createProjectFixture, createWorkspaceMember } = await import(
  "./helpers/fixtures"
);

const { app } = createApp();

afterAll(() => {
  platform.close();
});

let workspaceId: string;
let taskId: string;
let author: string;
let bea: string;
let cal: string;
let dee: string;
let outsider: string;
let warn: ReturnType<typeof vi.spyOn>;

async function newUser(name: string, role: string | null = null) {
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: `user-${randomUUID()}`,
      email: `${randomUUID()}@example.com`,
      emailVerified: true,
      name,
      ...(role ? { role } : {}),
    })
    .returning();
  return user.id;
}

async function join(userId: string, role = "member") {
  await db.insert(schema.workspaceUserTable).values({
    workspaceId,
    userId,
    role,
    joinedAt: new Date(),
  });
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
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

function group(slug: string, ids: string[], memberCount = ids.length) {
  return { slug, name: `${slug} name`, memberCount, kaneoUserIds: ids };
}

const mention = (id: string, label: string) =>
  `<kaneo-mention id="${id}" label="${label}"></kaneo-mention>`;

async function mentionRows() {
  const rows = await db
    .select({
      userId: schema.notificationTable.userId,
      type: schema.notificationTable.type,
    })
    .from(schema.notificationTable)
    .where(eq(schema.notificationTable.resourceId, taskId));
  return rows;
}

async function mentionedUsers() {
  return (await mentionRows())
    .filter((row) => row.type === "task_mention")
    .map((row) => row.userId)
    .sort();
}

async function comment(as: string, text: string) {
  const cookie = await humanSession(as);
  const response = await app.request("/api/activity/comment", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ taskId, comment: text }),
  });
  expect(response.status).toBe(200);
}

async function describeTask(as: string, description: string) {
  const cookie = await humanSession(as);
  const response = await app.request(`/api/task/description/${taskId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ description }),
  });
  expect(response.status).toBe(200);
}

const expandWarnings = () =>
  warn.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes("operon_group_expand_failed"));

beforeEach(async () => {
  await resetTestDatabase();
  setEnv("OPERON_INTERNAL_API_URL", platformUrl);
  answers.clear();
  received.length = 0;
  warn = vi.spyOn(console, "warn");

  const [workspace] = await db
    .insert(schema.workspaceTable)
    .values({
      id: `workspace-${randomUUID()}`,
      createdAt: new Date(),
      name: "Operon",
      slug: "operon",
    })
    .returning();
  workspaceId = workspace.id;
  author = await newUser("Ann");
  bea = await newUser("Bea");
  cal = await newUser("Cal");
  dee = await newUser("Dee");
  for (const id of [author, bea, cal, dee]) await join(id);
  // A person Operon puts in the group who is not in this workspace.
  outsider = (await createWorkspaceMember({ userName: "Elsewhere" })).user.id;

  const { project, columns } = await createProjectFixture({ workspaceId });
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      title: "Launch",
      status: "to-do",
      columnId: columns.todo.id,
      priority: "medium",
      number: 1,
      position: 1,
    })
    .returning();
  taskId = task.id;
  defaultAnswer = { groups: [group("team", [author, bea, cal, outsider], 5)] };
});

afterEach(() => {
  warn.mockRestore();
});

describe("GET /api/operon/groups", () => {
  it("is 401 signed out", async () => {
    const response = await app.request("/api/operon/groups");
    expect(response.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it("is 403 for an API key, even one held by a workspace member", async () => {
    const created = await auth.api.createApiKey({
      body: { userId: author, name: "plain" },
    });
    const response = await app.request("/api/operon/groups", {
      headers: { "x-api-key": created.key },
    });
    expect(response.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("is 403 for a user outside the Operon workspace, and for a Kaneo admin without a membership row", async () => {
    const admin = await newUser("Instance admin", "admin");
    for (const userId of [outsider, admin]) {
      const response = await app.request("/api/operon/groups", {
        headers: { cookie: await humanSession(userId) },
      });
      expect(response.status).toBe(403);
    }
    expect(received).toHaveLength(0);
  });

  it("answers a member the counts only, from one signed read with exactly kaneoUserId and timestamp", async () => {
    const response = await app.request("/api/operon/groups", {
      headers: { cookie: await humanSession(bea) },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      groups: [
        { slug: "team", name: "team name", initiativeCount: 4, memberCount: 5 },
      ],
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.signatureOk).toBe(true);
    expect(Object.keys(received[0]?.body ?? {})).toEqual([
      "kaneoUserId",
      "timestamp",
    ]);
    expect(received[0]?.body.kaneoUserId).toBe(bea);
  });

  it("passes Operon's empty answer for a guest or agent asker through as []", async () => {
    answers.set(dee, { groups: [] });
    const response = await app.request("/api/operon/groups", {
      headers: { cookie: await humanSession(dee) },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ groups: [] });
  });

  it("is 503 when Operon fails, answers badly or is unreachable", async () => {
    const cookie = await humanSession(bea);
    for (const answer of [
      { status: 500, body: '{"groups":[]}' },
      { status: 200, body: '{"groups":[],"extra":1}' },
      {
        status: 200,
        body: '{"groups":[{"slug":"Bad_Slug","name":"x","memberCount":0,"kaneoUserIds":[]}]}',
      },
      {
        status: 200,
        body: '{"groups":[{"slug":"team","name":"x","memberCount":1,"kaneoUserIds":["a","b"]}]}',
      },
    ]) {
      answers.set(bea, answer);
      const response = await app.request("/api/operon/groups", {
        headers: { cookie },
      });
      expect(response.status).toBe(503);
    }
    setEnv("OPERON_INTERNAL_API_URL", `http://127.0.0.1:${closedPort}`);
    const response = await app.request("/api/operon/groups", {
      headers: { cookie },
    });
    expect(response.status).toBe(503);
  });
});

describe("comment saves expand groups (D11)", () => {
  it("notifies each workspace member of the group once, never the author or a non-member", async () => {
    await comment(author, `${mention("group:team", "team")} launch at 3`);
    expect(await mentionedUsers()).toEqual([bea, cal].sort());
    expect(received.map((r) => r.body.kaneoUserId)).toEqual([author]);
  });

  it("gives a person named directly and through the group one notification", async () => {
    await comment(
      author,
      `${mention(bea, "Bea")} and ${mention("group:team", "team")}`,
    );
    expect(await mentionedUsers()).toEqual([bea, cal].sort());
  });

  it("drops an unknown slug and still notifies direct mentions", async () => {
    await comment(
      author,
      `${mention("group:nope", "nope")} ${mention(dee, "Dee")}`,
    );
    expect(await mentionedUsers()).toEqual([dee]);
  });

  it("an assignee reached through the group gets the mention, not the comment alert", async () => {
    await db
      .update(schema.taskTable)
      .set({ userId: cal })
      .where(eq(schema.taskTable.id, taskId));
    await comment(author, mention("group:team", "team"));
    const rows = await mentionRows();
    expect(rows.filter((r) => r.userId === cal).map((r) => r.type)).toEqual([
      "task_mention",
    ]);
  });

  it("with Operon unreachable the comment saves, the group notifies nobody, one WARN, direct mentions still go", async () => {
    setEnv("OPERON_INTERNAL_API_URL", `http://127.0.0.1:${closedPort}`);
    await comment(
      author,
      `${mention("group:team", "team")} ${mention(dee, "Dee")}`,
    );
    const stored = await db
      .select({ content: schema.activityTable.content })
      .from(schema.activityTable)
      .where(
        and(
          eq(schema.activityTable.taskId, taskId),
          eq(schema.activityTable.type, "comment"),
        ),
      );
    expect(stored).toHaveLength(1);
    expect(await mentionedUsers()).toEqual([dee]);
    expect(expandWarnings()).toEqual([
      JSON.stringify({
        evt: "operon_group_expand_failed",
        count: 1,
        reason: "unreachable",
      }),
    ]);
  });

  it("expands from its own read at each save: a membership change between saves is followed", async () => {
    await comment(author, mention("group:team", "team"));
    expect(await mentionedUsers()).toEqual([bea, cal].sort());
    defaultAnswer = { groups: [group("team", [dee])] };
    await comment(author, mention("group:team", "team"));
    expect(await mentionedUsers()).toEqual([bea, cal, dee].sort());
    expect(received).toHaveLength(2);
  });
});

describe("description saves expand newly added groups (D11)", () => {
  it("notifies the members when the group is newly added, and nobody when it is kept", async () => {
    await describeTask(author, `Plan: ${mention("group:team", "team")}`);
    expect(await mentionedUsers()).toEqual([bea, cal].sort());
    await describeTask(
      author,
      `Plan, revised: ${mention("group:team", "team")}`,
    );
    expect(await mentionedUsers()).toEqual([bea, cal].sort());
    // The kept group was not new, so Operon was not even asked the second time.
    expect(received).toHaveLength(1);
  });

  it("with Operon unreachable the save succeeds and a direct mention still notifies", async () => {
    setEnv("OPERON_INTERNAL_API_URL", `http://127.0.0.1:${closedPort}`);
    await describeTask(
      author,
      `${mention("group:team", "team")} ${mention(dee, "Dee")}`,
    );
    expect(await mentionedUsers()).toEqual([dee]);
    expect(expandWarnings()).toHaveLength(1);
  });
});
