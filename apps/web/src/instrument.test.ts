import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_CATALOGUE, redactEvent, sha1Hash8 } from "./instrument";

/**
 * instrument.ts — Stage 1 task 0.7's own assertions (Operon stabilization plan §3 row 0.7;
 * `docs/fork-discipline.md` row 2, task 0.7's own widening note).
 *
 * Leak-test parity with `platform-service/src/client-errors/__tests__/client-errors.test.js`
 * on the Operon side — same claims, against this side's `beforeSend` instead of the
 * server's Pino line.
 */

function exceptionEvent(message: string): {
  exception: { values: { value?: string }[] };
} {
  return { exception: { values: [{ value: message }] } };
}

describe("sha1Hash8", () => {
  it("is deterministic and matches a known vector (sha1('') )", async () => {
    expect(await sha1Hash8("")).toBe("da39a3ee");
    expect(await sha1Hash8("abc")).toBe("a9993e36");
  });

  it("is stable for the same input, across calls", async () => {
    const a = await sha1Hash8("the same unknown message");
    const b = await sha1Hash8("the same unknown message");
    expect(a).toBe(b);
  });
});

describe("redactEvent", () => {
  it("passes a catalogued message through verbatim", async () => {
    const event = exceptionEvent("Failed to fetch");
    // biome-ignore lint/suspicious/noExplicitAny: minimal Sentry.ErrorEvent shape for the test
    const result = await redactEvent(event as any);
    expect(result.exception?.values?.[0]?.value).toBe("Failed to fetch");
  });

  it("redacts an unknown message to redacted:<sha1-8>, never leaving the raw text", async () => {
    const sensitive =
      "can't save: draft was 'call me at jane@example.com, token=SECRETVALUE123'";
    const event = exceptionEvent(sensitive);
    // biome-ignore lint/suspicious/noExplicitAny: minimal Sentry.ErrorEvent shape for the test
    const result = await redactEvent(event as any);
    const value = result.exception?.values?.[0]?.value ?? "";
    expect(value).toMatch(/^redacted:[0-9a-f]{8}$/);
    expect(value).not.toContain("jane@example.com");
    expect(value).not.toContain("SECRETVALUE123");
    expect(JSON.stringify(result)).not.toContain("jane@example.com");
    expect(JSON.stringify(result)).not.toContain(sensitive);
  });

  it("a fake private key never survives redaction", async () => {
    const fakeKey = `nsec1${"q".repeat(58)}`;
    const event = exceptionEvent(`decrypt failed for key ${fakeKey}`);
    // biome-ignore lint/suspicious/noExplicitAny: minimal Sentry.ErrorEvent shape for the test
    const result = await redactEvent(event as any);
    expect(JSON.stringify(result)).not.toContain(fakeKey);
  });

  it("two different unknown messages redact to two different tags", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal Sentry.ErrorEvent shape for the test
    const a = await redactEvent(exceptionEvent("unknown one") as any);
    // biome-ignore lint/suspicious/noExplicitAny: minimal Sentry.ErrorEvent shape for the test
    const b = await redactEvent(exceptionEvent("unknown two") as any);
    expect(a.exception?.values?.[0]?.value).not.toBe(
      b.exception?.values?.[0]?.value,
    );
  });

  it("an event with no exception values is returned unchanged", async () => {
    const event = {};
    // biome-ignore lint/suspicious/noExplicitAny: minimal Sentry.ErrorEvent shape for the test
    const result = await redactEvent(event as any);
    expect(result).toEqual({});
  });

  it("every entry in DIAGNOSTIC_CATALOGUE round-trips through redactEvent unchanged", async () => {
    for (const message of DIAGNOSTIC_CATALOGUE) {
      const event = exceptionEvent(message);
      // biome-ignore lint/suspicious/noExplicitAny: minimal Sentry.ErrorEvent shape for the test
      const result = await redactEvent(event as any);
      expect(result.exception?.values?.[0]?.value).toBe(message);
    }
  });
});
