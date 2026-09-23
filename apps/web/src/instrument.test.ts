import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIAGNOSTIC_CATALOGUE,
  redactEvent,
  releaseIdentity,
  sha1Hash8,
} from "./instrument";

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
    expect(result).toEqual({ tags: {} });
  });

  it("every entry in DIAGNOSTIC_CATALOGUE round-trips through redactEvent unchanged", async () => {
    for (const message of DIAGNOSTIC_CATALOGUE) {
      const event = exceptionEvent(message);
      // biome-ignore lint/suspicious/noExplicitAny: minimal Sentry.ErrorEvent shape for the test
      const result = await redactEvent(event as any);
      expect(result.exception?.values?.[0]?.value).toBe(message);
    }
  });

  it("a top-level message (an event with no exception) is redacted the same way (finding 2)", async () => {
    const sensitive = "draft: call jane@example.com about SECRETVALUE123";
    // biome-ignore lint/suspicious/noExplicitAny: minimal Sentry.ErrorEvent shape for the test
    const result = await redactEvent({ message: sensitive } as any);
    expect(result.message).toMatch(/^redacted:[0-9a-f]{8}$/);
    expect(JSON.stringify(result)).not.toContain("jane@example.com");
  });

  it("an arbitrary/spoofed exception type is normalized, never forwarded raw (finding 2)", async () => {
    const spoofed = "jane@example.com leaked here";
    const event = {
      exception: { values: [{ type: spoofed, value: "Failed to fetch" }] },
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal Sentry.ErrorEvent shape for the test
    const result = await redactEvent(event as any);
    expect(result.exception?.values?.[0]?.type).toBe("Error");
    expect(JSON.stringify(result)).not.toContain("jane@example.com");
  });

  it("a known exception type is forwarded verbatim", async () => {
    const event = {
      exception: { values: [{ type: "RangeError", value: "Failed to fetch" }] },
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal Sentry.ErrorEvent shape for the test
    const result = await redactEvent(event as any);
    expect(result.exception?.values?.[0]?.type).toBe("RangeError");
  });

  it("a stack frame's tokenized query string is stripped, the path kept for symbolication (finding 2)", async () => {
    const event = {
      exception: {
        values: [
          {
            value: "Failed to fetch",
            stacktrace: {
              frames: [
                {
                  filename: "/assets/index-abc.js?token=FAKE_TOKEN",
                  lineno: 1,
                  colno: 2,
                },
              ],
            },
          },
        ],
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal Sentry.ErrorEvent shape for the test
    const result = await redactEvent(event as any);
    const frame = result.exception?.values?.[0]?.stacktrace?.frames?.[0];
    expect(frame?.filename).toBe("/assets/index-abc.js");
    expect(JSON.stringify(result)).not.toContain("FAKE_TOKEN");
  });

  it("a request URL's query string is stripped, never forwarded with its tokenized value (finding 2)", async () => {
    const event = {
      request: { url: "https://operon.example/t?token=SECRETVALUE123" },
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal Sentry.ErrorEvent shape for the test
    const result = await redactEvent(event as any);
    expect(result.request?.url).toBe("/redacted");
    expect(JSON.stringify(result)).not.toContain("SECRETVALUE123");
  });

  it("breadcrumbs and extras are dropped entirely — no allowlist exists to sanitize them (finding 2)", async () => {
    const event = {
      exception: { values: [{ value: "Failed to fetch" }] },
      breadcrumbs: [
        { message: "user typed jane@example.com into the composer" },
      ],
      extra: { draft: "sensitive text" },
      contexts: { state: { pendingMessage: "sensitive text" } },
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal Sentry.ErrorEvent shape for the test
    const result = await redactEvent(event as any);
    expect(JSON.stringify(result)).not.toContain("jane@example.com");
    expect(JSON.stringify(result)).not.toContain("sensitive text");
    expect((result as { breadcrumbs?: unknown }).breadcrumbs).toBeUndefined();
    expect((result as { extra?: unknown }).extra).toBeUndefined();
    expect((result as { contexts?: unknown }).contexts).toBeUndefined();
  });
});

describe("releaseIdentity (Stage 1 round-1 finding 17)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries both deployment SHAs as validated tags alongside the immutable build release", async () => {
    vi.stubGlobal(
      "__KANEO_LOADED_VERSION_JSON__",
      JSON.stringify({
        release: "2026.09.22-4",
        operon_sha: "a".repeat(40),
        fork_sha: "b".repeat(40),
        config_hash: "deadbeef",
        built_at: "2026-09-22T00:00:00.000Z",
      }),
    );
    const result = await redactEvent({ type: undefined });
    expect(result.tags).toEqual({
      deployment_release: "2026.09.22-4",
      operon_sha: "a".repeat(40),
      fork_sha: "b".repeat(40),
    });
  });

  it("falls back to unknown when no build release is defined", () => {
    vi.stubGlobal(
      "__KANEO_LOADED_VERSION_JSON__",
      "KANEO_LOADED_VERSION_JSON_PLACEHOLDER",
    );
    expect(releaseIdentity()).toBe("unknown"); // __APP_VERSION__ is also undefined in this test env
  });

  it("falls back on malformed embedded JSON, never throws", () => {
    vi.stubGlobal("__KANEO_LOADED_VERSION_JSON__", "not json");
    expect(() => releaseIdentity()).not.toThrow();
  });

  it("falls back when the embedded constant is entirely absent", () => {
    vi.stubGlobal("__KANEO_LOADED_VERSION_JSON__", undefined);
    expect(() => releaseIdentity()).not.toThrow();
  });
});

it("drops arbitrary metadata, userinfo, functions and non-asset frames", async () => {
  const privateText = "private@example.invalid";
  const result = await redactEvent({
    type: undefined,
    event_id: privateText,
    timestamp: Number.NaN,
    platform: privateText,
    release: privateText,
    environment: privateText,
    tags: { area: privateText },
    request: { url: `https://${privateText}/private-path` },
    exception: {
      values: [
        {
          type: "TypeError",
          value: "Failed to fetch",
          stacktrace: {
            frames: [
              {
                filename: `https://${privateText}/assets/index-abc.js`,
                function: privateText,
                lineno: 1,
                colno: 2,
              },
              { filename: `/private/${privateText}.js`, function: privateText },
              ...Array.from({ length: 20 }, () => ({
                filename: "/assets/app-abc.js",
                lineno: 3,
                colno: 4,
              })),
            ],
          },
        },
      ],
    },
  });
  expect(JSON.stringify(result)).not.toContain(privateText);
  expect(result.exception?.values?.[0]?.stacktrace?.frames).toHaveLength(10);
  expect(result.platform).toBeUndefined();
  expect(result.release).toBeUndefined();
});

it("uses the same immutable build release as the source-map uploader", () => {
  vi.stubGlobal("__KANEO_SENTRY_RELEASE__", `initiative-${"a".repeat(32)}`);
  expect(releaseIdentity()).toBe(`initiative-${"a".repeat(32)}`);
  vi.unstubAllGlobals();
});
