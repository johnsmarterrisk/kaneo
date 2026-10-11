import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Operon fork checks — Tables task 4 (docs/fork-discipline.md row 18, spec 7.6 / R-F):
 * the image and link column kinds. An image value is checked with Operon's signed
 * `POST /internal/kaneo/stash-image` (stubbed here) for the writer, stored as the bare
 * UUID, and refused 422 `image_refused` or 503 `image_check_unavailable` (fail closed).
 * A link must be http(s).
 */
function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const S2S_SECRET = "tables-image-s2s-secret";
const LIVE = "11111111-1111-4111-8111-111111111111";
const SLOW = "99999999-9999-4999-8999-999999999999";
const REFUSED: Record<string, number> = {
  "22222222-2222-4222-8222-222222222222": 404,
  "33333333-3333-4333-8333-333333333333": 410,
  "44444444-4444-4444-8444-444444444444": 413,
  "55555555-5555-4555-8555-555555555555": 415,
  "66666666-6666-4666-8666-666666666666": 403,
  "77777777-7777-4777-8777-777777777777": 500,
};
const asked: { signatureOk: boolean; body: Record<string, unknown> }[] = [];

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
    if (req.url !== "/internal/kaneo/stash-image") {
      res.writeHead(404);
      return res.end();
    }
    const body = JSON.parse(raw) as Record<string, unknown>;
    asked.push({
      signatureOk:
        req.headers["x-operon-signature"] ===
        createHmac("sha256", S2S_SECRET).update(raw).digest("hex"),
      body,
    });
    const fileId = String(body.fileId);
    if (fileId === SLOW) return; // never answers: the fork's 2 s abort fires
    const status = REFUSED[fileId] ?? (fileId === LIVE ? 200 : 404);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(status === 200 ? '{"ok":true}' : '{"error":"x"}');
  });
});
const platformPort = await listen(platform);

setEnv("OPERON_INTERNAL_API_URL", `http://127.0.0.1:${platformPort}`);
setEnv("OPERON_KANEO_S2S_SECRET", S2S_SECRET);

const { createApp } = await import("../../apps/api/src/index");
const { auth, OPERON_SERVICE_KEY_PERMISSIONS } = await import(
  "../../apps/api/src/auth"
);
const { default: db } = await import("../../apps/api/src/database");
const { taskTable, userTable, workspaceUserTable } = await import(
  "../../apps/api/src/database/schema"
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

function json(method: string, path: string, body: unknown, headers = {}) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function seed() {
  const owner = await createWorkspaceMember({ role: "owner" });
  const { project } = await createProjectFixture({
    workspaceId: owner.workspace.id,
  });
  const [task] = await db
    .insert(taskTable)
    .values({ projectId: project.id, title: "Asset", number: 999 })
    .returning();
  mockAuthenticatedSession(owner.user);
  const image = (await (
    await json("POST", "/api/custom-field", {
      projectId: project.id,
      name: "Thumbnail",
      type: "image",
    })
  ).json()) as { id: string; type: string };
  const link = (await (
    await json("POST", "/api/custom-field", {
      projectId: project.id,
      name: "Link",
      type: "link",
    })
  ).json()) as { id: string; type: string };
  const [agent] = await db
    .insert(userTable)
    .values({
      id: `user-${randomUUID()}`,
      email: `${randomUUID()}@example.com`,
      emailVerified: true,
      name: "Agent",
    })
    .returning();
  await db.insert(workspaceUserTable).values({
    workspaceId: owner.workspace.id,
    userId: agent.id,
    role: "member",
    joinedAt: new Date(),
  });
  // Operon's service key marks the Operon workspace the agent-key ceiling reads.
  await auth.api.createApiKey({
    body: {
      userId: owner.user.id,
      name: "service",
      permissions: OPERON_SERVICE_KEY_PERMISSIONS,
      metadata: { operonService: true },
    },
  });
  const agentKey = await auth.api.createApiKey({
    body: { userId: agent.id, name: "agent", metadata: { operonAgent: true } },
  });
  return { owner, project, task, image, link, agent, agentKey: agentKey.key };
}

const setValue = (
  taskId: string,
  fieldId: string,
  value: string,
  headers: Record<string, string> = {},
) =>
  json("PUT", "/api/custom-field/value", { taskId, fieldId, value }, headers);

describe("API integration: Tables image and link kinds (task 4)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    asked.length = 0;
    setEnv("OPERON_KANEO_S2S_SECRET", S2S_SECRET);
  });

  it("creates image and link columns", async () => {
    const { image, link } = await seed();
    expect(image.type).toBe("image");
    expect(link.type).toBe("link");
  });

  it("stores a live image as its UUID — a pasted Stash link is normalised — and reads it back", async () => {
    const { task, image, owner } = await seed();
    const response = await setValue(
      task.id,
      image.id,
      `https://operon.example.test/#/files/${LIVE.toUpperCase()}`,
    );
    expect(response.status).toBe(200);
    expect(asked).toHaveLength(1);
    expect(asked[0].signatureOk).toBe(true);
    expect(asked[0].body).toMatchObject({
      kaneoUserId: owner.user.id,
      fileId: LIVE,
    });
    const values = (await (
      await app.request(`/api/custom-field/task/${task.id}`)
    ).json()) as { fieldId: string; value: string }[];
    expect(values.find((v) => v.fieldId === image.id)?.value).toBe(LIVE);
  });

  it("maps each Stash refusal to 422 image_refused with its reason, for a session and an agent key", async () => {
    const { task, image, agentKey } = await seed();
    const reasons: Record<number, string> = {
      404: "not_found",
      410: "deleted",
      413: "too_large",
      415: "not_image",
      403: "no_access",
    };
    for (const headers of [{}, { "x-api-key": agentKey }]) {
      for (const [fileId, status] of Object.entries(REFUSED)) {
        if (status === 500) continue;
        const response = await setValue(task.id, image.id, fileId, headers);
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({
          error: "image_refused",
          reason: reasons[status],
        });
      }
    }
    const values = (await (
      await app.request(`/api/custom-field/task/${task.id}`)
    ).json()) as unknown[];
    expect(values).toHaveLength(0);
  });

  it("refuses a value that is not a Stash file without asking Operon", async () => {
    const { task, image } = await seed();
    const response = await setValue(task.id, image.id, "holiday.png");
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      reason: "not_a_stash_file",
    });
    expect(asked).toHaveLength(0);
  });

  it("fails closed: an unexpected status, no channel or a timeout is 503", async () => {
    const { task, image } = await seed();
    const odd = await setValue(
      task.id,
      image.id,
      "77777777-7777-4777-8777-777777777777",
    );
    expect(odd.status).toBe(503);
    expect(await odd.json()).toMatchObject({
      error: "image_check_unavailable",
    });

    const slow = await setValue(task.id, image.id, SLOW);
    expect(slow.status).toBe(503);

    setEnv("OPERON_KANEO_S2S_SECRET", undefined);
    const unconfigured = await setValue(task.id, image.id, LIVE);
    expect(unconfigured.status).toBe(503);
  }, 15_000);

  it("accepts an http(s) link and refuses javascript: and ftp:", async () => {
    const { task, link } = await seed();
    expect(
      (await setValue(task.id, link.id, "https://example.com/post/1")).status,
    ).toBe(200);
    for (const bad of ["javascript:alert(1)", "ftp://example.com/x", "nope"]) {
      const response = await setValue(task.id, link.id, bad);
      expect(response.status).toBe(422);
      const answer = await response.json();
      expect(answer).toMatchObject({ error: "invalid_link" });
      expect(JSON.stringify(answer)).not.toContain("alert(1)");
    }
    const values = (await (
      await app.request(`/api/custom-field/task/${task.id}`)
    ).json()) as { fieldId: string; value: string }[];
    expect(values.find((v) => v.fieldId === link.id)?.value).toBe(
      "https://example.com/post/1",
    );
  });

  it("checks an image given on task create and stores the UUID", async () => {
    const { project, image } = await seed();
    const response = await json("POST", `/api/task/${project.id}`, {
      title: "With image",
      description: "",
      priority: "low",
      status: "to-do",
      customFields: [{ fieldId: image.id, value: `/#/files/${LIVE}` }],
    });
    expect(response.status).toBe(200);
    const { id } = (await response.json()) as { id: string };
    const values = (await (
      await app.request(`/api/custom-field/task/${id}`)
    ).json()) as { fieldId: string; value: string }[];
    expect(values.find((v) => v.fieldId === image.id)?.value).toBe(LIVE);
  });
});
