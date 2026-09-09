import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";

/**
 * OPERON FORK TEST — the maintenance window's DEFERRAL and its ADMISSION ACCOUNTING
 * (Operon spec R25, R32, G10a, decisions 34, 50 and 54).
 *
 * Groups (i) and (ii) of G10a's fork tests. Group (iii) — the two signed routes — and the
 * pure half of the accounting are in `tests/api/utils/operon-maintenance-state.test.ts`,
 * which needs neither a database nor this file's OIDC-mode module graph.
 *
 * ── WHY THE IMPORTS ARE DYNAMIC ──────────────────────────────────────────────────────
 *
 * The same reason `operon-oidc-only.test.ts` gives: `auth.ts` reads `OPERON_OIDC_ONLY` ONCE
 * at module scope, and a static import is hoisted above every statement in this file, so it
 * would evaluate the module before the mode could be set and the whole suite would silently
 * exercise a non-Operon instance.
 *
 * ── THE REGRESSION CASES ARE THE POINT ───────────────────────────────────────────────
 *
 * Every deferral case below is paired with the SAME sign-in under an ack that carries no
 * `maintenance` field at all — which is what today's Operon sends and what an Operon that
 * has not been redeployed will keep sending. A fork that deferred on absence would stop
 * repairing service keys on every instance in the world, which is a far worse failure than
 * the one this window prevents.
 */

function setEnv(key: string, value: string) {
  process.env[key] = value;
}

const OIDC_ONLY = "OPERON_OIDC_ONLY";
const previousOidcOnly = process.env[OIDC_ONLY];
setEnv(OIDC_ONLY, "true");
setEnv("OPERON_INTERNAL_API_URL", "http://platform-service.test:3001");
setEnv("OPERON_KANEO_S2S_SECRET", "an-s2s-secret-for-the-maintenance-suite");

const { reconcileOperonSession, operonServiceKeyId } = await import(
  "../../apps/api/src/auth"
);
const { rememberOperonOidcClaims, __resetOperonOidcClaims } = await import(
  "../../apps/api/src/utils/custom-oauth-profile"
);
const {
  __resetOperonMaintenanceState,
  operonMaintenanceState,
  resolveOperonDeliveries,
} = await import("../../apps/api/src/operon-maintenance-state");

afterAll(() => {
  if (previousOidcOnly === undefined) delete process.env[OIDC_ONLY];
  else setEnv(OIDC_ONLY, previousOidcOnly);
});

type Delivery = {
  sub: string;
  kaneoUserId: string;
  workspaceId: string | null;
  apiKey?: string;
  enabledServiceKeyIds?: string[];
  deliveryId: string;
  timestamp: string;
};

let deliveries: Delivery[];
/** Operon's answer, as this suite wants it for the case in hand. */
let ackMaintenance: boolean | undefined;
let ackRetryAfterS: number | undefined;
/** Operon's side of the credential, modelled exactly as `operon-oidc-only.test.ts` does. */
let operonHeldKey: string | null;
let operonInstalledAtMs: number | null;
/** Run something on the Nth callback from now, before the receiver sees it. */
let beforeCallback: { countdown: number; run: () => void } | null;
/** What the stub does INSTEAD of answering: the seams the timeout cases need. */
let respondWith:
  | { kind: "ok" }
  | { kind: "status"; status: number }
  | { kind: "unparseable" }
  | { kind: "never" }
  | { kind: "throw" };
/** Every reading of the counter taken from INSIDE a delivery, in order. */
let countsDuringDelivery: number[];
let warnings: string[];

function operonReceive(delivery: Delivery) {
  if (!delivery.apiKey) return;
  const enabled = delivery.enabledServiceKeyIds;
  if (
    Array.isArray(enabled) &&
    !enabled.includes(operonServiceKeyId(delivery.apiKey))
  ) {
    return;
  }
  const at = Date.parse(delivery.timestamp);
  if (operonInstalledAtMs !== null && at < operonInstalledAtMs) return;
  operonHeldKey = delivery.apiKey;
  operonInstalledAtMs = at;
}

function operonServiceKeyValid(delivery: Delivery) {
  if (operonHeldKey === null) return false;
  const enabled = delivery.enabledServiceKeyIds;
  if (!Array.isArray(enabled)) return true;
  return enabled.includes(operonServiceKeyId(operonHeldKey));
}

function ackBody(delivery: Delivery) {
  return {
    ok: true,
    serviceKeyOnFile: operonHeldKey !== null,
    serviceKeyValid: operonServiceKeyValid(delivery),
    ...(ackMaintenance === undefined ? {} : { maintenance: ackMaintenance }),
    ...(ackRetryAfterS === undefined ? {} : { retry_after_s: ackRetryAfterS }),
  };
}

beforeEach(async () => {
  await resetTestDatabase();
  __resetOperonOidcClaims();
  __resetOperonMaintenanceState();
  deliveries = [];
  ackMaintenance = undefined;
  ackRetryAfterS = undefined;
  operonHeldKey = null;
  operonInstalledAtMs = null;
  beforeCallback = null;
  respondWith = { kind: "ok" };
  countsDuringDelivery = [];
  warnings = [];

  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  vi.stubGlobal(
    "fetch",
    async (_url: string, init: { body: string; signal?: AbortSignal }) => {
      if (beforeCallback) {
        beforeCallback.countdown -= 1;
        if (beforeCallback.countdown <= 0) {
          const { run } = beforeCallback;
          beforeCallback = null;
          run();
        }
      }

      const delivery = JSON.parse(init.body) as Delivery;
      deliveries.push(delivery);
      // Read from INSIDE the call: this is the only vantage point from which "the delivery
      // is inside the counted region" is observable at all.
      countsDuringDelivery.push(operonMaintenanceState().credentialOpsInFlight);

      if (respondWith.kind === "throw") {
        throw new Error("platform-service is down");
      }

      if (respondWith.kind === "never") {
        // THE ROUND-3 CASE, DRIVEN THROUGH THE REAL ABORT. The receiver never answers, so
        // `postOperonKaneoUser`'s own ten-second `AbortController` is what ends this call —
        // exactly as a platform commit held past the fork's HTTP timeout does in production.
        // It costs the suite ten real seconds once, which is cheaper than a stub that
        // rejected on its own and proved only that a rejection is caught.
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("This operation was aborted", "AbortError"),
            );
          });
        });
      }

      if (respondWith.kind === "status") {
        return {
          ok: false,
          status: respondWith.status,
          text: async () => "",
          json: async () => ({}),
        } as unknown as Response;
      }

      operonReceive(delivery);

      if (respondWith.kind === "unparseable") {
        return {
          ok: true,
          status: 200,
          text: async () => "not json",
          json: async () => {
            throw new Error("Unexpected token");
          },
        } as unknown as Response;
      }

      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ackBody(delivery),
      } as unknown as Response;
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetOperonMaintenanceState();
});

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

async function stageOidcLogin(
  user: { id: string; email: string },
  role: "admin" | "member",
  sub: string,
) {
  await db
    .insert(schema.accountTable)
    .values({
      id: `account-${randomUUID()}`,
      accountId: sub,
      providerId: "custom",
      userId: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  rememberOperonOidcClaims({ sub, email: user.email, name: user.email, role });
  return sub;
}

function freshSub() {
  return randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64);
}

async function signIn(
  user: { id: string; email: string },
  role: "admin" | "member",
  sub = freshSub(),
) {
  await stageOidcLogin(user, role, sub);
  await reconcileOperonSession(user.id);
}

/** Every key on this instance that carries the bootstrap's unforgeable marker. */
async function markedKeys() {
  const rows = await db.select().from(schema.apikeyTable);
  return rows.filter(
    (row) =>
      (
        JSON.parse(row.metadata ?? "null") as {
          operonService?: boolean;
        } | null
      )?.operonService === true,
  );
}

function warnedAbout(fragment: string) {
  return warnings.some((line) => line.includes(fragment));
}

// ─── (i) Deferral ────────────────────────────────────────────────────────────────

describe("(i) deferral — the ack says `maintenance: true`", () => {
  it("the FIRST-ADMIN BOOTSTRAP mints nothing and delivers nothing", async () => {
    // The window was observed on an earlier callback in this process — a member's login,
    // which crosses no store — and the admin's bootstrap then finds it. The genuinely
    // first login of a deployment is covered by ORDERING instead (decisions 52 and 56):
    // the `backup` profile is not enabled until after it.
    ackMaintenance = true;
    ackRetryAfterS = 120;
    const member = await seedUser(`member-${randomUUID()}@example.com`);
    await signIn(member, "member");

    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");

    expect(await db.select().from(schema.workspaceTable)).toHaveLength(1);
    // No key exists at all, and no callback carried one.
    expect(await markedKeys()).toHaveLength(0);
    expect(deliveries.filter((d) => d.apiKey)).toHaveLength(0);
    expect(
      warnedAbout(
        "maintenance window: the bootstrap service key was NOT minted",
      ),
    ).toBe(true);
    expect(warnedAbout("retry_after_s=120")).toBe(true);
  });

  it("the RE-MINT path revokes nothing and mints nothing", async () => {
    // First a real bootstrap, so there IS a credential a careless deferral could destroy.
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");
    const before = await markedKeys();
    expect(before).toHaveLength(1);
    expect(before[0]?.enabled).not.toBe(false);

    // Now Operon loses the key AND takes its flag: `serviceKeyValid: false` with
    // `maintenance: true` is exactly the pair that used to revoke and then defer.
    operonHeldKey = null;
    operonInstalledAtMs = null;
    ackMaintenance = true;
    ackRetryAfterS = 90;
    await signIn(admin, "admin");

    const after = await markedKeys();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    // NOTHING WAS REVOKED. Revoking and then deferring the delivery would leave Operon
    // with no credential at all for the length of the backup — strictly worse than doing
    // nothing, which is why the check sits before `revokeOperonServiceKeys`.
    expect(after[0]?.enabled).not.toBe(false);
    expect(deliveries.filter((d) => d.apiKey)).toHaveLength(1);
    expect(
      warnedAbout("maintenance window: the service key was NOT re-minted"),
    ).toBe(true);
  });

  it("a LATER sign-in, after the window, completes the work that was deferred", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");
    operonHeldKey = null;
    operonInstalledAtMs = null;

    ackMaintenance = true;
    await signIn(admin, "admin");
    expect(await markedKeys()).toHaveLength(1);

    // The window closes; the very next admin sign-in repairs.
    ackMaintenance = false;
    await signIn(admin, "admin");

    const keys = await markedKeys();
    expect(keys).toHaveLength(2);
    expect(keys.filter((k) => k.enabled !== false)).toHaveLength(1);
    expect(operonHeldKey).toBeTruthy();
  });
});

describe("(i) regression — no `maintenance` field, and an explicit `false`", () => {
  it("with the field ABSENT the bootstrap behaves exactly as it does today", async () => {
    ackMaintenance = undefined;
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");

    expect(await markedKeys()).toHaveLength(1);
    expect(deliveries.filter((d) => d.apiKey)).toHaveLength(1);
    expect(warnedAbout("maintenance window")).toBe(false);
  });

  it("with the field ABSENT the re-mint still repairs a lost credential", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");
    operonHeldKey = null;
    operonInstalledAtMs = null;

    await signIn(admin, "admin");

    const keys = await markedKeys();
    expect(keys).toHaveLength(2);
    // The old one IS revoked here — which is the behaviour the deferral suspends and
    // must not have broken.
    expect(keys.filter((k) => k.enabled === false)).toHaveLength(1);
  });

  it("an explicit `false` clears an earlier `true`, and the NEXT sign-in does the work", async () => {
    // The fork acts on the last thing Operon TOLD it, which is the only thing it can know:
    // the deferral below is decided before this login's own callback has gone out, so it
    // still sees the member login's `maintenance: true`. That is correct rather than a
    // miss — the callback that follows observes the `false`, and the next sign-in repairs.
    // It is also why the observation expires: a window that never reported closing must
    // not be able to defer for ever.
    ackMaintenance = true;
    const member = await seedUser(`member-${randomUUID()}@example.com`);
    await signIn(member, "member");
    expect(operonMaintenanceState().maintenance).toBe(true);

    ackMaintenance = false;
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");

    // Deferred on the stale reading, but the reading is now current.
    expect(await markedKeys()).toHaveLength(0);
    expect(operonMaintenanceState().maintenance).toBe(false);

    // And the very next admin sign-in repairs, through the re-mint path.
    await signIn(admin, "admin");
    expect(await markedKeys()).toHaveLength(1);
    expect(operonHeldKey).toBeTruthy();
  });
});

// ─── (ii) Admission accounting ───────────────────────────────────────────────────

describe("(ii) admission accounting — the counter", () => {
  it("is 1 across the DELIVERY, and back to 0 once the sign-in returns", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");

    // One callback, made from inside the lock, and the count was 1 while it was open —
    // which is what "delivery is inside the counted region" means.
    expect(countsDuringDelivery).toEqual([1]);
    expect(operonMaintenanceState().credentialOpsInFlight).toBe(0);
  });

  it("returns to 0 on the `no workspace` early return", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");
    operonHeldKey = null;
    operonInstalledAtMs = null;

    // The re-mint takes the lock, re-checks, and finds the workspace gone.
    await db.delete(schema.workspaceTable);
    await signIn(admin, "admin");

    expect(operonMaintenanceState().credentialOpsInFlight).toBe(0);
  });

  it("returns to 0 when the re-check says no re-mint is needed", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");

    // `serviceKeyValid: false` on the outer ack, then Operon recovers before the
    // re-check inside the lock — the stale-answer case the re-check exists for.
    const held = operonHeldKey;
    operonHeldKey = null;
    beforeCallback = {
      countdown: 2,
      run: () => {
        operonHeldKey = held;
      },
    };
    await signIn(admin, "admin");

    expect(await markedKeys()).toHaveLength(1);
    expect(operonMaintenanceState().credentialOpsInFlight).toBe(0);
  });

  it("returns to 0 when the callback inside the lock THROWS", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    respondWith = { kind: "throw" };
    await signIn(admin, "admin");

    // A counter that leaked here would 503 Operon's reissues for ever after one bad
    // network moment, which is why the decrement is a `finally` and not a return site.
    expect(operonMaintenanceState().credentialOpsInFlight).toBe(0);
  });

  it("two concurrent first-admin logins do not double-count past the lock", async () => {
    const a = await seedUser(`admin-a-${randomUUID()}@example.com`);
    const b = await seedUser(`admin-b-${randomUUID()}@example.com`);
    await stageOidcLogin(a, "admin", "a".repeat(64));
    await stageOidcLogin(b, "admin", "b".repeat(64));

    await Promise.all([
      reconcileOperonSession(a.id),
      reconcileOperonSession(b.id),
    ]);

    // Only the login that WON the advisory lock is admitted, so no reading ever exceeds
    // one — the loser skips rather than queueing, and a skip must not be counted.
    expect(Math.max(0, ...countsDuringDelivery)).toBe(1);
    expect(operonMaintenanceState().credentialOpsInFlight).toBe(0);
  });
});

describe("(ii) the timeout cases — a status is an answer, silence is not", () => {
  it("a receiver held past the fork's own timeout leaves the id UNRESOLVED", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    respondWith = { kind: "never" };
    await signIn(admin, "admin");

    const delivery = deliveries.at(-1);
    expect(delivery?.deliveryId).toBeTruthy();
    // NOT merely decremented to zero: the counter is back at zero AND the id is named,
    // because the transaction Operon opened on receipt is still on its way to a commit
    // and only Operon can say whether it landed.
    expect(operonMaintenanceState().credentialOpsInFlight).toBe(0);
    expect(operonMaintenanceState().unresolvedDeliveries).toEqual([
      delivery?.deliveryId,
    ]);

    // And it is cleared only by a posted verdict.
    resolveOperonDeliveries([
      { deliveryId: delivery?.deliveryId ?? "", verdict: "settled" },
    ]);
    expect(operonMaintenanceState().unresolvedDeliveries).toEqual([]);
  }, 30_000);

  it("a 4xx decrements normally and records NOTHING unresolved", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    // Operon's replay 409 at `internal-kaneo.js` — an answer, and an answer that says
    // nothing was written.
    respondWith = { kind: "status", status: 409 };
    await signIn(admin, "admin");

    expect(operonMaintenanceState().credentialOpsInFlight).toBe(0);
    expect(operonMaintenanceState().unresolvedDeliveries).toEqual([]);
  });

  it("a 2xx with an UNPARSEABLE body decrements normally and records nothing", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    respondWith = { kind: "unparseable" };
    await signIn(admin, "admin");

    // A 2xx wrote everything, whatever its body says, so there is nothing to reconcile.
    expect(operonMaintenanceState().credentialOpsInFlight).toBe(0);
    expect(operonMaintenanceState().unresolvedDeliveries).toEqual([]);
    expect(await markedKeys()).toHaveLength(1);
  });
});
