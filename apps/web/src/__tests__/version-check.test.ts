import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchVersionJson,
  formatStamp,
  getLoadedVersion,
  resetLoadedVersionForTests,
  sha7,
  useVersionStampText,
  type VersionInfo,
  versionKey,
} from "@/lib/version-check";

/**
 * version-check.ts — Stage 1 tasks 0.5/0.6's own assertions
 * (`docs/specs/operon-stabilization-plan.md` §3 rows 0.5, 0.6; `docs/fork-discipline.md`
 * row 2, Stabilization Stage 1 note).
 *
 * This file covers task 0.5's read/format primitives (mirroring
 * `app/src/shell/__tests__/version.test.ts` on the Operon side, case for case where the
 * contract is the same). Task 0.6 widens it with the forced-reload hook's own cases.
 */

const fetchMock =
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

const VALID: VersionInfo = {
  release: "2026.09.22-4",
  operon_sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  fork_sha: "f4e5d6c7b8a9f4e5d6c7b8a9f4e5d6c7b8a9f4e5",
  config_hash: "deadbeef",
  built_at: "2026-09-22T12:00:00.000Z",
};

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetLoadedVersionForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchVersionJson", () => {
  it("returns the parsed body on a valid 200", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(VALID));
    await expect(fetchVersionJson()).resolves.toEqual(VALID);
    expect(fetchMock).toHaveBeenCalledWith("/version.json", {
      cache: "no-store",
    });
  });

  it("returns null on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false));
    await expect(fetchVersionJson()).resolves.toBeNull();
  });

  it("returns null on a malformed body (missing field)", async () => {
    const malformed = {
      release: VALID.release,
      operon_sha: VALID.operon_sha,
      fork_sha: VALID.fork_sha,
      built_at: VALID.built_at,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(malformed));
    await expect(fetchVersionJson()).resolves.toBeNull();
  });

  it("returns null when fetch rejects (offline)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(fetchVersionJson()).resolves.toBeNull();
  });
});

describe("getLoadedVersion", () => {
  it("fetches exactly once no matter how many callers ask", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(VALID));
    const [a, b] = await Promise.all([getLoadedVersion(), getLoadedVersion()]);
    expect(a).toEqual(VALID);
    expect(b).toEqual(VALID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("sha7 / versionKey / formatStamp", () => {
  it("sha7 shortens to 7 characters", () => {
    expect(sha7("a1b2c3d4e5f6")).toBe("a1b2c3d");
    expect(sha7("unknown")).toBe("unknown");
  });

  it("versionKey combines release and config_hash only", () => {
    expect(versionKey(VALID)).toBe("2026.09.22-4::deadbeef");
    expect(versionKey({ ...VALID, fork_sha: "different" })).toBe(
      versionKey(VALID),
    );
    expect(versionKey({ ...VALID, config_hash: "different" })).not.toBe(
      versionKey(VALID),
    );
  });

  it('formatStamp renders "v<release> · <sha7>/<sha7>", or an em dash when null', () => {
    expect(formatStamp(VALID)).toBe("v2026.09.22-4 · a1b2c3d/f4e5d6c");
    expect(formatStamp(null)).toBe("—");
  });
});

describe("useVersionStampText", () => {
  it("renders an em dash until version.json resolves, then the formatted stamp", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(VALID));
    const { result } = renderHook(() => useVersionStampText());
    expect(result.current).toBe("—");

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current).toBe("v2026.09.22-4 · a1b2c3d/f4e5d6c");
  });
});
