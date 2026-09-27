import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auth,
  ensureOperonServiceKeyCeiling,
  OPERON_SERVICE_KEY_PERMISSIONS,
} from "../../apps/api/src/auth";
import db, { getDatabase, schema } from "../../apps/api/src/database";
import { createApp, runStartupTasks } from "../../apps/api/src/index";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

/**
 * Operon fork checks (Smart Desk F0b, task T2: F8–F11, D4).
 *
 * At boot, the ONE enabled key carrying Operon's `operonService` marker has its stored
 * permissions set to `OPERON_SERVICE_KEY_PERMISSIONS` when they differ; its value, id and
 * metadata stay. Disabled keys are left alone; two enabled marked keys are both left alone
 * with an error naming them; a throwing read or write fails the boot. The change log names
 * permissions, never the key value or its hash.
 *
 * See `docs/fork-discipline.md` in the Operon repository.
 */

const OLD_CEILING = {
  workspace: ["manage_settings"],
  task: ["update"],
  operon: ["rekey"],
};

async function mintKey(
  userId: string,
  permissions: Record<string, string[]>,
  marked = true,
) {
  const created = await auth.api.createApiKey({
    body: {
      userId,
      name: `f0b-ceiling-${Date.now() % 100000}`,
      permissions,
      ...(marked ? { metadata: { operonService: true } } : {}),
    },
  });
  if (!created?.key || !created.id)
    throw new Error("failed to mint a test key");
  return { key: created.key, id: created.id };
}

async function row(id: string) {
  const [found] = await db
    .select()
    .from(schema.apikeyTable)
    .where(eq(schema.apikeyTable.id, id));
  if (!found) throw new Error(`no apikey row ${id}`);
  return found;
}

async function setStoredPermissions(id: string, text: string | null) {
  await db
    .update(schema.apikeyTable)
    .set({ permissions: text })
    .where(eq(schema.apikeyTable.id, id));
}

/** The exact text the mint path stores for the ceiling, read from a freshly minted row. */
async function mintedCeilingText(userId: string) {
  const minted = await mintKey(
    userId,
    { ...OPERON_SERVICE_KEY_PERMISSIONS },
    false,
  );
  const text = (await row(minted.id)).permissions;
  await db
    .delete(schema.apikeyTable)
    .where(eq(schema.apikeyTable.id, minted.id));
  return text;
}

function captureLogs() {
  const lines: Array<{ level: string; text: string }> = [];
  for (const level of ["debug", "info", "log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push({ level, text: args.map(String).join(" ") });
    });
  }
  const ceiling = () => lines.filter((line) => line.text.includes("ceiling"));
  return { lines, ceiling };
}

async function seed() {
  const owner = await createWorkspaceMember({ role: "owner" });
  return { owner, ceilingText: await mintedCeilingText(owner.user.id) };
}

describe("API integration: Operon service-key ceiling at boot (Smart Desk F0b T2)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("F8/F9: a lower key is raised to the ceiling, value, id and metadata unchanged, one change log by name", async () => {
    const { owner, ceilingText } = await seed();
    const minted = await mintKey(owner.user.id, OLD_CEILING);
    const before = await row(minted.id);
    const logs = captureLogs();

    expect(await ensureOperonServiceKeyCeiling()).toBe("synced");

    const after = await row(minted.id);
    // The pinned serialisation: exactly what the mint path writes for the ceiling.
    expect(after.permissions).toBe(ceilingText);
    expect(after.permissions).toBe(
      JSON.stringify(OPERON_SERVICE_KEY_PERMISSIONS),
    );
    expect(after.id).toBe(before.id);
    expect(after.key).toBe(before.key);
    expect(after.metadata).toBe(before.metadata);
    expect(after.enabled).toBe(true);

    const changes = logs.ceiling();
    expect(changes).toHaveLength(1);
    expect(changes[0].level).toBe("log");
    expect(changes[0].text).toContain("operon_service_key_ceiling_synced");
    expect(changes[0].text).toContain(minted.id);
    expect(changes[0].text).toContain(
      "operon:rekey,task:update,workspace:manage_settings -> operon:rekey,task:create,task:update,workspace:manage_settings",
    );
    for (const line of logs.lines) {
      expect(line.text).not.toContain(minted.key);
      expect(line.text).not.toContain(before.key);
    }
  });

  it("F8/F9: an equal key (in any action order) is not written and logs nothing", async () => {
    const { owner } = await seed();
    const minted = await mintKey(owner.user.id, {
      operon: ["rekey"],
      task: ["update", "create"],
      workspace: ["manage_settings"],
    });
    const before = await row(minted.id);
    const update = vi.spyOn(getDatabase(), "update");
    const logs = captureLogs();

    expect(await ensureOperonServiceKeyCeiling()).toBe("equal");

    expect(update).not.toHaveBeenCalled();
    expect((await row(minted.id)).permissions).toBe(before.permissions);
    expect(logs.lines.filter((line) => line.level !== "debug")).toEqual([]);
  });

  it("F8: a higher key is lowered to the ceiling", async () => {
    const { owner, ceilingText } = await seed();
    const minted = await mintKey(owner.user.id, {
      ...OPERON_SERVICE_KEY_PERMISSIONS,
      task: ["create", "update", "delete"],
      project: ["delete"],
    });
    const logs = captureLogs();

    expect(await ensureOperonServiceKeyCeiling()).toBe("synced");

    expect((await row(minted.id)).permissions).toBe(ceilingText);
    expect(logs.ceiling()).toHaveLength(1);
    expect(logs.ceiling()[0].text).toContain(
      "project:delete,task:create,task:delete",
    );
  });

  it("F9: an unparseable value is overwritten with one warning that does not carry the raw text", async () => {
    const { owner, ceilingText } = await seed();
    const minted = await mintKey(owner.user.id, OLD_CEILING);
    const raw = "{not-json SENTINEL-RAW-TEXT";
    await setStoredPermissions(minted.id, raw);
    const logs = captureLogs();

    expect(await ensureOperonServiceKeyCeiling()).toBe("synced");

    expect((await row(minted.id)).permissions).toBe(ceilingText);
    const changes = logs.ceiling();
    expect(changes).toHaveLength(1);
    expect(changes[0].level).toBe("warn");
    expect(changes[0].text).toContain("(unparseable)");
    expect(changes[0].text).toContain(minted.id);
    for (const line of logs.lines) expect(line.text).not.toContain("SENTINEL");
  });

  it("F8: a disabled marked key is untouched, and with no enabled marked key nothing is written", async () => {
    const { owner } = await seed();
    const disabled = await mintKey(owner.user.id, OLD_CEILING);
    await db
      .update(schema.apikeyTable)
      .set({ enabled: false })
      .where(eq(schema.apikeyTable.id, disabled.id));
    const plain = await mintKey(owner.user.id, OLD_CEILING, false);
    const update = vi.spyOn(getDatabase(), "update");
    const logs = captureLogs();

    expect(await ensureOperonServiceKeyCeiling()).toBe("none");

    expect(update).not.toHaveBeenCalled();
    expect((await row(disabled.id)).permissions).toBe(
      JSON.stringify(OLD_CEILING),
    );
    expect((await row(plain.id)).permissions).toBe(JSON.stringify(OLD_CEILING));
    expect(logs.ceiling()).toEqual([]);
  });

  it("F8: with no key at all the step writes nothing and returns", async () => {
    const update = vi.spyOn(getDatabase(), "update");

    await expect(ensureOperonServiceKeyCeiling()).resolves.toBe("none");
    expect(update).not.toHaveBeenCalled();
  });

  it("F8a: two enabled marked keys are both left alone, one error names both ids, and the step returns", async () => {
    const { owner } = await seed();
    const first = await mintKey(owner.user.id, OLD_CEILING);
    const second = await mintKey(owner.user.id, OLD_CEILING);
    const logs = captureLogs();

    await expect(ensureOperonServiceKeyCeiling()).resolves.toBe("ambiguous");

    expect((await row(first.id)).permissions).toBe(JSON.stringify(OLD_CEILING));
    expect((await row(second.id)).permissions).toBe(
      JSON.stringify(OLD_CEILING),
    );
    const changes = logs.ceiling();
    expect(changes).toHaveLength(1);
    expect(changes[0].level).toBe("error");
    expect(changes[0].text).toContain("operon_service_key_ceiling_ambiguous");
    expect(changes[0].text).toContain(first.id);
    expect(changes[0].text).toContain(second.id);
  });

  it("F8: a legacy enabled-NULL marked row beside one live marked key: the live key is corrected, the NULL row untouched, no ambiguity", async () => {
    const { owner, ceilingText } = await seed();
    const legacy = await mintKey(owner.user.id, OLD_CEILING);
    await db
      .update(schema.apikeyTable)
      .set({ enabled: null })
      .where(eq(schema.apikeyTable.id, legacy.id));
    const live = await mintKey(owner.user.id, OLD_CEILING);
    const logs = captureLogs();

    // `verifyApiKey` accepts only `enabled = true`, so the NULL row is not a key Operon
    // can be holding and must not count toward "more than one enabled key".
    expect(await ensureOperonServiceKeyCeiling()).toBe("synced");

    expect((await row(live.id)).permissions).toBe(ceilingText);
    const untouched = await row(legacy.id);
    expect(untouched.permissions).toBe(JSON.stringify(OLD_CEILING));
    expect(untouched.enabled).toBeNull();
    const changes = logs.ceiling();
    expect(changes).toHaveLength(1);
    expect(changes[0].text).toContain("operon_service_key_ceiling_synced");
    expect(changes[0].text).toContain(live.id);
    expect(changes[0].text).not.toContain(legacy.id);
  });

  it("F8b: a throwing read fails the boot", async () => {
    captureLogs();
    // Only a read of `apikey` throws, so a later startup step's own reads cannot be the
    // reason the boot rejects.
    const database = getDatabase();
    const original = database.select.bind(database);
    vi.spyOn(database, "select").mockImplementation(((
      ...args: Parameters<typeof original>
    ) => {
      const builder = original(...args);
      const from = builder.from.bind(builder);
      return Object.assign(builder, {
        from: (table: unknown) => {
          if (table === schema.apikeyTable) {
            throw new Error("ceiling read failed");
          }
          return from(table as Parameters<typeof from>[0]);
        },
      });
    }) as typeof database.select);

    await expect(runStartupTasks()).rejects.toThrow("ceiling read failed");
  });

  it("F8b: a throwing write fails the boot", async () => {
    const { owner } = await seed();
    await mintKey(owner.user.id, OLD_CEILING);
    captureLogs();
    const database = getDatabase();
    const original = database.update.bind(database);
    vi.spyOn(database, "update").mockImplementation(((table: unknown) => {
      if (table === schema.apikeyTable) throw new Error("ceiling write failed");
      return original(table as Parameters<typeof original>[0]);
    }) as typeof database.update);

    await expect(runStartupTasks()).rejects.toThrow("ceiling write failed");
  });

  it("F10/F11: a key stored at the old ceiling is refused, corrected by the step, then creates a task", async () => {
    const owner = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: owner.workspace.id,
    });
    const minted = await mintKey(owner.user.id, OLD_CEILING);
    const { app } = createApp();
    const create = () =>
      app.request(`/api/task/${project.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": minted.key,
          "X-Operon-On-Behalf-Of": owner.user.id,
        },
        body: JSON.stringify({
          title: "After the ceiling sync",
          description: "",
          priority: "low",
          status: "to-do",
        }),
      });

    // F11: the per-request refusal is unchanged for a key the step has not seen yet.
    const refused = await create();
    expect(refused.status).toBe(403);

    captureLogs();
    expect(await ensureOperonServiceKeyCeiling()).toBe("synced");

    const accepted = await create();
    expect(accepted.status).toBe(200);
    const created = await accepted.json();
    const [task] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, created.id));
    expect(task?.title).toBe("After the ceiling sync");
  });
});
