/**
 * OPERON FORK TEST — the maintenance barrier's accounting and its two signed routes
 * (Operon spec R25, R32, G10a, decisions 34, 50 and 54).
 *
 * Group (ii)'s pure half and the whole of group (iii). The counter's behaviour ACROSS a
 * real sign-in — the early returns, the failed mint, the thrown error — needs `auth.ts`
 * and therefore a database, so it lives in
 * `tests/api-integration/operon-maintenance-window.test.ts`; what is asserted here is the
 * accounting module itself and the routes' verification, neither of which touches Postgres.
 *
 * NO NETWORK AND NO DATABASE. The router is mounted on a bare Hono app and driven through
 * `app.request`, exactly as a real request would reach it, so the path in the canonical
 * signature string is the path the handler really sees rather than one the test asserted
 * about itself.
 */

import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import operonMaintenanceState, {
  __resetOperonMaintenanceState,
  beginOperonCredentialOp,
  endOperonCredentialOp,
  OPERON_MAINTENANCE_DEFAULT_TTL_MS,
  OPERON_MAX_SIGNATURE_SKEW_MS,
  OPERON_SIGNATURE_HEADER,
  OPERON_TIMESTAMP_HEADER,
  observeOperonMaintenance,
  operonCanonicalRequest,
  operonMaintenanceDeferral,
  operonMaintenanceState as readOperonMaintenanceState,
  recordUnresolvedOperonDelivery,
  resolveOperonDeliveries,
  verifyOperonRequestSignature,
} from "../../../apps/api/src/operon-maintenance-state";

const SECRET_KEY = "OPERON_KANEO_S2S_SECRET";
const SECRET = "the-shared-s2s-secret-for-this-suite";

let savedSecret: string | undefined;

/** The app as `index.ts` mounts it: under `/api`, on the `/internal/operon` prefix. */
function mount() {
  const api = new Hono();
  api.route("/internal/operon", operonMaintenanceState);
  const app = new Hono();
  app.route("/api", api);
  return app;
}

function sign(
  method: string,
  path: string,
  body: string,
  at = new Date().toISOString(),
  secret = SECRET,
) {
  return {
    [OPERON_TIMESTAMP_HEADER]: at,
    [OPERON_SIGNATURE_HEADER]: createHmac("sha256", secret)
      .update(operonCanonicalRequest(method, path, at, body))
      .digest("hex"),
  };
}

beforeEach(() => {
  savedSecret = process.env[SECRET_KEY];
  process.env[SECRET_KEY] = SECRET;
  __resetOperonMaintenanceState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env[SECRET_KEY];
  else process.env[SECRET_KEY] = savedSecret;
  __resetOperonMaintenanceState();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── (ii) Admission accounting, the pure half ────────────────────────────────────

describe("the in-flight counter", () => {
  it("counts up and back down, and never below zero however it is called", () => {
    expect(readOperonMaintenanceState().credentialOpsInFlight).toBe(0);
    beginOperonCredentialOp();
    beginOperonCredentialOp();
    expect(readOperonMaintenanceState().credentialOpsInFlight).toBe(2);
    endOperonCredentialOp();
    endOperonCredentialOp();
    // A counter that could go negative would let ONE leaked decrement mask a genuinely
    // in-flight operation for ever after, which is a silent drain failure.
    endOperonCredentialOp();
    expect(readOperonMaintenanceState().credentialOpsInFlight).toBe(0);
  });
});

describe("the unresolved set — a delivery that ended without an HTTP status", () => {
  it("records the id, and records it once however many times it is reported", () => {
    recordUnresolvedOperonDelivery("delivery-a");
    recordUnresolvedOperonDelivery("delivery-a");
    expect(readOperonMaintenanceState().unresolvedDeliveries).toEqual([
      "delivery-a",
    ]);
  });

  it("is cleared ONLY by a posted verdict, never by time alone", () => {
    vi.useFakeTimers();
    recordUnresolvedOperonDelivery("delivery-a");
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(readOperonMaintenanceState().unresolvedDeliveries).toEqual([
      "delivery-a",
    ]);

    expect(
      resolveOperonDeliveries([
        { deliveryId: "delivery-a", verdict: "settled" },
      ]),
    ).toEqual(["delivery-a"]);
    expect(readOperonMaintenanceState().unresolvedDeliveries).toEqual([]);
  });

  it("logs a named line on `absent`, and stays quiet on `settled`", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordUnresolvedOperonDelivery("settled-one");
    recordUnresolvedOperonDelivery("absent-one");
    warn.mockClear();

    resolveOperonDeliveries([
      { deliveryId: "settled-one", verdict: "settled" },
      { deliveryId: "absent-one", verdict: "absent" },
    ]);

    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes("ABSENT"))).toHaveLength(1);
    expect(lines.some((l) => l.includes("absent-one"))).toBe(true);
    expect(lines.some((l) => l.includes("settled-one"))).toBe(false);
  });

  it("clears exactly the ids named, and an id it does not hold is not an error", () => {
    recordUnresolvedOperonDelivery("keep-me");
    recordUnresolvedOperonDelivery("clear-me");
    expect(
      resolveOperonDeliveries([
        { deliveryId: "clear-me", verdict: "settled" },
        { deliveryId: "never-seen", verdict: "absent" },
      ]),
    ).toEqual(["clear-me"]);
    expect(readOperonMaintenanceState().unresolvedDeliveries).toEqual([
      "keep-me",
    ]);
  });
});

// ─── (i)'s state half — what the fork believes about the window ──────────────────

describe("the observed maintenance state", () => {
  it("an ack saying `maintenance: true` defers, and carries the retry hint", () => {
    observeOperonMaintenance({ maintenance: true, retry_after_s: 90 });
    expect(operonMaintenanceDeferral()).toEqual({
      deferred: true,
      retryAfterS: 90,
    });
    expect(readOperonMaintenanceState().maintenance).toBe(true);
  });

  it("an ack saying `false`, or an older Operon with no field at all, does not defer", () => {
    observeOperonMaintenance({ maintenance: true, retry_after_s: 90 });
    observeOperonMaintenance({ maintenance: false });
    expect(operonMaintenanceDeferral().deferred).toBe(false);

    observeOperonMaintenance({ maintenance: true });
    observeOperonMaintenance({ serviceKeyValid: true } as {
      maintenance?: boolean;
    });
    expect(operonMaintenanceDeferral().deferred).toBe(false);
  });

  it("a `null` ack changes nothing — silence is not evidence a window closed", () => {
    observeOperonMaintenance({ maintenance: true, retry_after_s: 30 });
    observeOperonMaintenance(null);
    expect(operonMaintenanceDeferral().deferred).toBe(true);
  });

  it("the deferral EXPIRES, so a killed Operon cannot wedge this fork for ever", () => {
    vi.useFakeTimers();
    observeOperonMaintenance({ maintenance: true, retry_after_s: 60 });
    vi.advanceTimersByTime(59_000);
    expect(operonMaintenanceDeferral().deferred).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(operonMaintenanceDeferral().deferred).toBe(false);
  });

  it("with no hint it still expires, on the default ttl", () => {
    vi.useFakeTimers();
    observeOperonMaintenance({ maintenance: true });
    expect(operonMaintenanceDeferral()).toEqual({
      deferred: true,
      retryAfterS: null,
    });
    vi.advanceTimersByTime(OPERON_MAINTENANCE_DEFAULT_TTL_MS + 1);
    expect(operonMaintenanceDeferral().deferred).toBe(false);
  });
});

// ─── (iii) The two S2S routes ────────────────────────────────────────────────────

describe("GET /api/internal/operon/maintenance-state", () => {
  const PATH = "/api/internal/operon/maintenance-state";

  it("answers the three fields for a request whose HMAC verifies", async () => {
    observeOperonMaintenance({ maintenance: true, retry_after_s: 45 });
    beginOperonCredentialOp();
    recordUnresolvedOperonDelivery("d-1");

    const res = await mount().request(PATH, {
      headers: sign("GET", PATH, ""),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      maintenance: true,
      credentialOpsInFlight: 1,
      unresolvedDeliveries: ["d-1"],
    });
  });

  it("refuses an UNSIGNED request", async () => {
    const res = await mount().request(PATH);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature" });
  });

  it("refuses one signed with the WRONG secret", async () => {
    const res = await mount().request(PATH, {
      headers: sign(
        "GET",
        PATH,
        "",
        new Date().toISOString(),
        "not-the-secret",
      ),
    });
    expect(res.status).toBe(401);
  });

  it("refuses one whose signature was made over ANOTHER path", async () => {
    // The path is in the canonical string precisely so a `resolve-deliveries`
    // signature cannot be lifted onto this route.
    const res = await mount().request(PATH, {
      headers: sign("GET", "/api/internal/operon/resolve-deliveries", ""),
    });
    expect(res.status).toBe(401);
  });

  it("refuses one REPLAYED outside the tolerated window, in either direction", async () => {
    const stale = new Date(
      Date.now() - OPERON_MAX_SIGNATURE_SKEW_MS - 1_000,
    ).toISOString();
    const ahead = new Date(
      Date.now() + OPERON_MAX_SIGNATURE_SKEW_MS + 1_000,
    ).toISOString();

    expect(
      (await mount().request(PATH, { headers: sign("GET", PATH, "", stale) }))
        .status,
    ).toBe(401);
    expect(
      (await mount().request(PATH, { headers: sign("GET", PATH, "", ahead) }))
        .status,
    ).toBe(401);
  });

  it("answers 503 — not 401 — when the secret is not configured at all", async () => {
    delete process.env[SECRET_KEY];
    const res = await mount().request(PATH, {
      headers: sign("GET", PATH, ""),
    });
    // Fail CLOSED and say whose fault it is: an unset secret is this instance's
    // misconfiguration, not the caller's.
    expect(res.status).toBe(503);
  });
});

describe("POST /api/internal/operon/resolve-deliveries", () => {
  const PATH = "/api/internal/operon/resolve-deliveries";

  async function post(body: string, headers?: Record<string, string>) {
    return mount().request(PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(headers ?? sign("POST", PATH, body)),
      },
      body,
    });
  }

  it("accepts `settled` and `absent` verdicts and clears exactly those ids", async () => {
    recordUnresolvedOperonDelivery("d-settled");
    recordUnresolvedOperonDelivery("d-absent");
    recordUnresolvedOperonDelivery("d-untouched");

    const body = JSON.stringify({
      verdicts: [
        { deliveryId: "d-settled", verdict: "settled" },
        { deliveryId: "d-absent", verdict: "absent" },
      ],
    });
    const res = await post(body);

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      cleared: string[];
      unresolvedDeliveries: string[];
    };
    expect(payload.cleared.sort()).toEqual(["d-absent", "d-settled"]);
    expect(payload.unresolvedDeliveries).toEqual(["d-untouched"]);
  });

  it("refuses an UNSIGNED body and clears nothing", async () => {
    recordUnresolvedOperonDelivery("d-1");
    const body = JSON.stringify({
      verdicts: [{ deliveryId: "d-1", verdict: "settled" }],
    });
    const res = await post(body, { "content-type": "application/json" });
    expect(res.status).toBe(401);
    expect(readOperonMaintenanceState().unresolvedDeliveries).toEqual(["d-1"]);
  });

  it("refuses a body that does not match the signature it arrived with", async () => {
    recordUnresolvedOperonDelivery("d-1");
    const signed = JSON.stringify({ verdicts: [] });
    const tampered = JSON.stringify({
      verdicts: [{ deliveryId: "d-1", verdict: "settled" }],
    });
    const res = await post(tampered, {
      "content-type": "application/json",
      ...sign("POST", PATH, signed),
    });
    expect(res.status).toBe(401);
    expect(readOperonMaintenanceState().unresolvedDeliveries).toEqual(["d-1"]);
  });

  it("refuses a REPLAY outside the window", async () => {
    const body = JSON.stringify({ verdicts: [] });
    const stale = new Date(
      Date.now() - OPERON_MAX_SIGNATURE_SKEW_MS - 1_000,
    ).toISOString();
    const res = await post(body, {
      "content-type": "application/json",
      ...sign("POST", PATH, body, stale),
    });
    expect(res.status).toBe(401);
  });

  it("400s a body that is not json, and one whose `verdicts` is not an array", async () => {
    expect((await post("not json at all")).status).toBe(400);
    expect((await post(JSON.stringify({ verdicts: "all" }))).status).toBe(400);
  });

  it("ignores an entry whose verdict is neither `settled` nor `absent`", async () => {
    recordUnresolvedOperonDelivery("d-1");
    const body = JSON.stringify({
      verdicts: [{ deliveryId: "d-1", verdict: "probably" }],
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    // A verdict this fork does not understand must not clear an entry: the entry is what
    // keeps Operon from dumping over an open transaction.
    expect(readOperonMaintenanceState().unresolvedDeliveries).toEqual(["d-1"]);
  });
});

describe("the verifier itself", () => {
  it("reports each refusal by its own reason, so a log line is diagnosable", () => {
    const at = new Date().toISOString();
    const base = { method: "GET", path: "/p", body: "", timestamp: at };

    expect(
      verifyOperonRequestSignature({
        ...base,
        signature: "aa",
        secret: undefined,
      }),
    ).toEqual({ ok: false, reason: "secret_not_configured", status: 503 });

    expect(
      verifyOperonRequestSignature({
        ...base,
        signature: undefined,
        secret: SECRET,
      }),
    ).toEqual({ ok: false, reason: "signature_missing", status: 401 });

    expect(
      verifyOperonRequestSignature({
        ...base,
        timestamp: undefined,
        signature: "aa",
        secret: SECRET,
      }),
    ).toEqual({ ok: false, reason: "timestamp_missing", status: 401 });

    expect(
      verifyOperonRequestSignature({
        ...base,
        timestamp: "the day before yesterday",
        signature: "aa",
        secret: SECRET,
      }),
    ).toEqual({ ok: false, reason: "timestamp_unparseable", status: 401 });

    expect(
      verifyOperonRequestSignature({
        ...base,
        signature: "aa",
        secret: SECRET,
      }),
    ).toEqual({ ok: false, reason: "signature_mismatch", status: 401 });

    const good = createHmac("sha256", SECRET)
      .update(operonCanonicalRequest("GET", "/p", at, ""))
      .digest("hex");
    expect(
      verifyOperonRequestSignature({
        ...base,
        signature: good,
        secret: SECRET,
      }),
    ).toEqual({ ok: true });
  });
});
