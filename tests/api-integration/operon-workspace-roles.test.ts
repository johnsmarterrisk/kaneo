import { randomUUID } from "node:crypto";
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
 * Operon fork checks — workspace permissions in Operon mode (spec R13, R14, R15,
 * R16; decisions 114, 115 and 124).
 *
 * ── WHY THE IMPORTS BELOW ARE DYNAMIC ────────────────────────────────────────────
 *
 * `apps/api/src/auth.ts` reads its switches ONCE, at module scope, exactly as
 * upstream reads `DISABLE_REGISTRATION`. `import` statements are hoisted above every
 * other statement in a module, so a static import here would evaluate `auth.ts`
 * before this file could set `OPERON_OIDC_ONLY` and the whole suite would silently
 * test the wrong mode. `operon-oidc-only.test.ts` established the pattern; this file
 * follows it, and the mode-OFF control below is the one place it deviates — see the
 * comment on that describe.
 *
 * See `docs/fork-discipline.md` §3 row 6 in the Operon repository.
 */

/**
 * Written through an indexed helper rather than as `process.env.OPERON_OIDC_ONLY = …`
 * because biome's `noUndeclaredEnvVars` requires every literally-named variable to
 * appear in `turbo.json`, which fork discipline forbids this branch from editing.
 */
function setEnv(key: string, value: string) {
  process.env[key] = value;
}

const OIDC_ONLY = "OPERON_OIDC_ONLY";
const previousOidcOnly = process.env[OIDC_ONLY];
setEnv(OIDC_ONLY, "true");
setEnv("OPERON_INTERNAL_API_URL", "http://platform-service.test:3001");
setEnv("OPERON_KANEO_S2S_SECRET", "an-s2s-secret-for-the-suite");

// Imported by path, not by package name: `tests/` is not a workspace package and
// carries no dependency on `@kaneo/permissions`, so the bare specifier does not
// resolve here. Every other suite in this directory reaches into `apps/api/src`
// the same way.
const { defaultRolePayloads, operonMemberPayload } = await import(
  "../../packages/permissions/src/index"
);
const dbModule = await import("../../apps/api/src/database");
const db = dbModule.default;
const { schema } = dbModule;
const { auth, reconcileOperonSession } = await import(
  "../../apps/api/src/auth"
);
const { seedDefaultWorkspaceRoles } = await import(
  "../../apps/api/src/utils/seed-default-workspace-roles"
);
const { createApp } = await import("../../apps/api/src/index");
const { rememberOperonOidcClaims, __resetOperonOidcClaims } = await import(
  "../../apps/api/src/utils/custom-oauth-profile"
);
const { mockAuthenticatedSession } = await import("./helpers/auth");
const { resetTestDatabase } = await import("./helpers/database");
const { createProjectFixture } = await import("./helpers/fixtures");

const OPERON_SLUG = "operon";

afterAll(() => {
  if (previousOidcOnly === undefined) {
    delete process.env[OIDC_ONLY];
  } else {
    setEnv(OIDC_ONLY, previousOidcOnly);
  }
});

beforeEach(async () => {
  await resetTestDatabase();
  __resetOperonOidcClaims();
  // Operon's S2S callback, silenced. Its contents are `operon-oidc-only.test.ts`'s
  // assertion, not this file's — here it only has to not reach the network.
  vi.stubGlobal(
    "fetch",
    async () =>
      ({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          ok: true,
          serviceKeyOnFile: true,
          serviceKeyValid: true,
        }),
      }) as unknown as Response,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function createWorkspace(slug: string, name = "Operon") {
  const [workspace] = await db
    .insert(schema.workspaceTable)
    .values({ name, slug, createdAt: new Date() })
    .returning();
  return workspace;
}

async function seedRoleRow(
  workspaceId: string,
  role: string,
  permission: Record<string, string[]>,
) {
  const now = new Date();
  await db.insert(schema.workspaceRoleTable).values({
    workspaceId,
    role,
    permission: JSON.stringify(permission),
    createdAt: now,
    updatedAt: now,
  });
}

/** All three upstream default rows, exactly as upstream's seeder writes them. */
async function seedUpstreamDefaults(workspaceId: string) {
  await seedRoleRow(workspaceId, "viewer", defaultRolePayloads.viewer);
  await seedRoleRow(workspaceId, "member", defaultRolePayloads.member);
  await seedRoleRow(workspaceId, "admin", defaultRolePayloads.admin);
}

async function roleRowPayload(workspaceId: string, role: string) {
  const [row] = await db
    .select({ permission: schema.workspaceRoleTable.permission })
    .from(schema.workspaceRoleTable)
    .where(
      and(
        eq(schema.workspaceRoleTable.workspaceId, workspaceId),
        eq(schema.workspaceRoleTable.role, role),
      ),
    )
    .limit(1);
  return row ? (JSON.parse(row.permission) as Record<string, string[]>) : null;
}

async function seedUser(email: string) {
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: `user-${randomUUID()}`,
      email,
      emailVerified: true,
      name: email.split("@")[0],
    })
    .returning();
  return user;
}

/** One Operon sign-in: the OIDC profile capture, then the session reconciliation. */
async function signIn(
  user: { id: string; email: string },
  role: "admin" | "member",
) {
  rememberOperonOidcClaims({
    sub: randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64),
    email: user.email,
    name: user.email,
    role,
  });
  await reconcileOperonSession(user.id);
}

async function membershipRoleOf(userId: string) {
  const [row] = await db
    .select({ role: schema.workspaceUserTable.role })
    .from(schema.workspaceUserTable)
    .where(eq(schema.workspaceUserTable.userId, userId))
    .limit(1);
  return row?.role ?? null;
}

describe("the boot backfill upgrades the Operon workspace's member role", () => {
  it("upgrades an untouched member row even when all three rows already exist", async () => {
    // `rows.length === 0` — the insert-only early return decision 124 replaced with a
    // conditional. Below that return the upgrade never ran on an instance whose
    // workspace was already fully seeded, which is every instance that has booted once.
    const workspace = await createWorkspace(OPERON_SLUG);
    await seedUpstreamDefaults(workspace.id);

    await seedDefaultWorkspaceRoles();

    expect(await roleRowPayload(workspace.id, "member")).toEqual(
      operonMemberPayload,
    );
    // Nothing else moved.
    expect(await roleRowPayload(workspace.id, "viewer")).toEqual(
      defaultRolePayloads.viewer,
    );
    expect(await roleRowPayload(workspace.id, "admin")).toEqual(
      defaultRolePayloads.admin,
    );
  });

  it("inserts a MISSING member row and upgrades it in the same pass", async () => {
    // Round 3 finding 3: an upgrade running above the insert matches nothing here,
    // and the insert then writes upstream's payload — unrepairable by the creation
    // hook, because the workspace already exists.
    const workspace = await createWorkspace(OPERON_SLUG);
    await seedRoleRow(workspace.id, "viewer", defaultRolePayloads.viewer);
    await seedRoleRow(workspace.id, "admin", defaultRolePayloads.admin);

    await seedDefaultWorkspaceRoles();

    expect(await roleRowPayload(workspace.id, "member")).toEqual(
      operonMemberPayload,
    );
  });

  it("leaves a customised member row exactly as the operator set it", async () => {
    const workspace = await createWorkspace(OPERON_SLUG);
    const customised = { ...defaultRolePayloads.member, task: ["read"] };
    await seedRoleRow(workspace.id, "member", customised);

    await seedDefaultWorkspaceRoles();

    expect(await roleRowPayload(workspace.id, "member")).toEqual(customised);
  });

  it("is idempotent over a row that already carries the upgraded payload", async () => {
    // The dev instance's row was fixed by hand before this code existed; a second
    // boot must recognise it as current rather than as a customisation.
    const workspace = await createWorkspace(OPERON_SLUG);
    await seedRoleRow(workspace.id, "member", operonMemberPayload);

    await seedDefaultWorkspaceRoles();
    await seedDefaultWorkspaceRoles();

    expect(await roleRowPayload(workspace.id, "member")).toEqual(
      operonMemberPayload,
    );
  });

  it("leaves a NON-Operon workspace's member row byte-identical to upstream's", async () => {
    const operon = await createWorkspace(OPERON_SLUG);
    await seedUpstreamDefaults(operon.id);
    const other = await createWorkspace(`other-${randomUUID()}`, "Other");
    await seedUpstreamDefaults(other.id);

    await seedDefaultWorkspaceRoles();

    expect(await roleRowPayload(other.id, "member")).toEqual(
      defaultRolePayloads.member,
    );
    expect(await roleRowPayload(operon.id, "member")).toEqual(
      operonMemberPayload,
    );
  });
});

describe("a workspace created after boot is upgraded in the SAME process", () => {
  it("upgrades the member row of a workspace created through the organization endpoint", async () => {
    // Decision 124's whole point: on an empty install the backfill returns before any
    // workspace exists, so without the creation hook a fresh install's members could
    // not assign or delete until somebody restarted the API. No restart happens here.
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);

    const organization = await auth.api.createOrganization({
      body: { name: "Operon", slug: OPERON_SLUG, userId: admin.id },
    });

    expect(organization?.id).toBeTruthy();
    expect(await roleRowPayload(organization?.id ?? "", "member")).toEqual(
      operonMemberPayload,
    );
  });

  it("does not upgrade a workspace created under a different slug", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);

    const organization = await auth.api.createOrganization({
      body: {
        name: "Somewhere Else",
        slug: `other-${randomUUID()}`,
        userId: admin.id,
      },
    });

    expect(await roleRowPayload(organization?.id ?? "", "member")).toEqual(
      defaultRolePayloads.member,
    );
  });
});

describe("the workspace membership role follows the Operon claim", () => {
  it("lands an Operon admin as a workspace admin", async () => {
    const bootstrap = await seedUser(`boot-${randomUUID()}@example.com`);
    await signIn(bootstrap, "admin");

    const later = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(later, "admin");

    expect(await membershipRoleOf(later.id)).toBe("admin");
  });

  it("reconciles a role that disagrees with the claim, in both directions", async () => {
    const bootstrap = await seedUser(`boot-${randomUUID()}@example.com`);
    await signIn(bootstrap, "admin");

    const person = await seedUser(`person-${randomUUID()}@example.com`);
    await signIn(person, "admin");
    expect(await membershipRoleOf(person.id)).toBe("admin");

    await signIn(person, "member");
    expect(await membershipRoleOf(person.id)).toBe("member");

    await signIn(person, "admin");
    expect(await membershipRoleOf(person.id)).toBe("admin");
  });

  it("never demotes the bootstrap creator's owner row, in either claim", async () => {
    // Decision 115. `createOrganization` makes the bootstrap admin the workspace
    // OWNER and no OIDC claim will ever say `owner`, so an unconditional reconcile
    // would demote them on their very next login and leave the workspace ownerless.
    const bootstrap = await seedUser(`boot-${randomUUID()}@example.com`);
    await signIn(bootstrap, "admin");
    expect(await membershipRoleOf(bootstrap.id)).toBe("owner");

    await signIn(bootstrap, "admin");
    expect(await membershipRoleOf(bootstrap.id)).toBe("owner");

    // Even a demotion of their INSTANCE role leaves the ownership alone.
    await signIn(bootstrap, "member");
    expect(await membershipRoleOf(bootstrap.id)).toBe("owner");

    const [userRow] = await db
      .select({ role: schema.userTable.role })
      .from(schema.userTable)
      .where(eq(schema.userTable.id, bootstrap.id));
    expect(userRow?.role).toBe("user");
  });
});

describe("an Operon member can assign and delete a task", () => {
  it("accepts both calls once the member row carries the upgraded payload", async () => {
    const workspace = await createWorkspace(OPERON_SLUG);
    await seedUpstreamDefaults(workspace.id);
    await seedDefaultWorkspaceRoles();

    const person = await seedUser(`member-${randomUUID()}@example.com`);
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: workspace.id,
      userId: person.id,
      role: "member",
      joinedAt: new Date(),
    });

    const { project, columns } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Assignable",
        description: "",
        priority: "medium",
        status: "to-do",
        columnId: columns.todo.id,
        number: 1,
        position: 1,
      })
      .returning();

    mockAuthenticatedSession(person as never);
    const { app } = createApp();

    const assigned = await app.request(`/api/task/assignee/${task.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: person.id }),
    });
    expect(assigned.status).toBe(200);

    const deleted = await app.request(`/api/task/${task.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);

    const [gone] = await db
      .select({ id: schema.taskTable.id })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    expect(gone).toBeUndefined();
  });
});

describe("OUTSIDE Operon mode nothing is upgraded", () => {
  /**
   * The negative control, and the one place this file cannot use its top-level
   * imports: the mode is read at `auth.ts` module scope, so proving "flag off
   * changes nothing" means a SECOND module graph, loaded with the flag cleared.
   * `operon-api-key-metadata.test.ts` gets its mode-off graph by being a different
   * file; a case that has to compare the same seeder in both modes cannot.
   */
  it("leaves the Operon workspace's member row at upstream's payload", async () => {
    const workspace = await createWorkspace(OPERON_SLUG);
    await seedUpstreamDefaults(workspace.id);

    delete process.env[OIDC_ONLY];
    vi.resetModules();
    try {
      const modeOff = await import(
        "../../apps/api/src/utils/seed-default-workspace-roles"
      );
      await modeOff.seedDefaultWorkspaceRoles();
    } finally {
      setEnv(OIDC_ONLY, "true");
      vi.resetModules();
    }

    expect(await roleRowPayload(workspace.id, "member")).toEqual(
      defaultRolePayloads.member,
    );
  });
});
