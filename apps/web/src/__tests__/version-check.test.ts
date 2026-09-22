import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so `vi.mock` factories below (themselves hoisted above these imports at
// execution time) can close over a MUTABLE mutation count each `useVersionCheck` test
// controls directly, instead of re-mocking the module per test.
const queryMock = vi.hoisted(() => ({ mutationCount: 0 }));
vi.mock("@tanstack/react-query", () => ({
  useIsMutating: () => queryMock.mutationCount,
}));

const toastMock = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import {
  CHECK_INTERVAL_MS,
  DRAIN_POLL_MS,
  fetchVersionJson,
  formatStamp,
  getLoadedVersion,
  isReloadScheduled,
  MAX_RELOAD_ATTEMPTS_PER_VERSION,
  RELOAD_ATTEMPTS_STORAGE_KEY,
  registerDirtyEditor,
  resetDirtyEditorsForTests,
  resetLoadedVersionForTests,
  resetReloadScheduledForTests,
  sha7,
  useVersionCheck,
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
  // Stage 1 finding 4: the document's OWN loaded version is now read from the
  // container-start-embedded `__KANEO_LOADED_VERSION_JSON__` constant, not fetched —
  // stub it to `VALID` as the default baseline every test compares the fetched
  // "latest" against.
  vi.stubGlobal("__KANEO_LOADED_VERSION_JSON__", JSON.stringify(VALID));
  resetLoadedVersionForTests();
  resetReloadScheduledForTests();
  resetDirtyEditorsForTests();
  queryMock.mutationCount = 0;
  toastMock.info.mockReset();
  sessionStorage.clear();
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetReloadScheduledForTests();
  resetDirtyEditorsForTests();
  sessionStorage.clear();
});

describe("fetchVersionJson", () => {
  it("returns the parsed body on a valid 200", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(VALID));
    await expect(fetchVersionJson()).resolves.toEqual(VALID);
    expect(fetchMock).toHaveBeenCalledWith("/version.json", {
      cache: "no-store",
      signal: expect.any(AbortSignal),
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

describe("getLoadedVersion — Stage 1 finding 4: read from the embedded constant, never fetched", () => {
  it("reads the embedded __KANEO_LOADED_VERSION_JSON__ constant without ever calling fetch", async () => {
    const [a, b] = await Promise.all([getLoadedVersion(), getLoadedVersion()]);
    expect(a).toEqual(VALID);
    expect(b).toEqual(VALID);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an un-substituted placeholder (a dev build with no env.sh run) resolves to null, never throws", async () => {
    vi.stubGlobal(
      "__KANEO_LOADED_VERSION_JSON__",
      "KANEO_LOADED_VERSION_JSON_PLACEHOLDER",
    );
    resetLoadedVersionForTests();
    await expect(getLoadedVersion()).resolves.toBeNull();
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
  it("renders an em dash until the embedded constant resolves, then the formatted stamp — never fetching", async () => {
    const { result } = renderHook(() => useVersionStampText());
    expect(result.current).toBe("—");

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current).toBe("v2026.09.22-4 · a1b2c3d/f4e5d6c");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("useVersionCheck", () => {
  async function mountWithLoaded(_loaded: VersionInfo, reloader: () => void) {
    const result = renderHook(() => useVersionCheck({ reloader }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return result;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("no mismatch: never reloads", async () => {
    const reloader = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse(VALID));
    renderHook(() => useVersionCheck({ reloader }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reloader).not.toHaveBeenCalled();
  });

  it("mismatch, no mutation in flight: reloads exactly once", async () => {
    const reloader = vi.fn();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...VALID, config_hash: "hash-2" }),
    );
    renderHook(() => useVersionCheck({ reloader }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reloader).toHaveBeenCalledTimes(1);
  });

  it("mismatch while a mutation is in flight (useIsMutating > 0): defers, schedules, toasts", async () => {
    queryMock.mutationCount = 1;
    const reloader = vi.fn();
    await mountWithLoaded(VALID, reloader);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...VALID, config_hash: "hash-2" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    });

    expect(reloader).not.toHaveBeenCalled();
    expect(isReloadScheduled()).toBe(true);
    expect(toastMock.info).toHaveBeenCalledTimes(1);
  });

  it("mutation drains: the deferred reload fires on the next drain poll", async () => {
    queryMock.mutationCount = 1;
    const reloader = vi.fn();
    const { rerender } = await mountWithLoaded(VALID, reloader);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...VALID, config_hash: "hash-2" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    });
    expect(reloader).not.toHaveBeenCalled();

    // `useIsMutating()` is a SUBSCRIPTION in production — react-query re-renders every
    // subscriber when the mutation finishes, which is what actually refreshes
    // `mutationCountRef.current`. The mock above is a static function, so this test
    // stands in for that re-render the same way real "the mutation finished" would
    // trigger one.
    queryMock.mutationCount = 0;
    rerender();
    // Finding 12: the drain poll now re-runs a full `check()` (fresh fetch) rather than
    // blindly reloading a captured target, so it needs its OWN queued response.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...VALID, config_hash: "hash-2" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAIN_POLL_MS);
    });
    expect(reloader).toHaveBeenCalledTimes(1);
  });

  describe("dirty-editor registry (Stage 1 round-1 finding 6)", () => {
    it("mismatch while a dirty editor is registered (no mutation in flight): defers, schedules, toasts", async () => {
      const unregister = registerDirtyEditor(() => true);
      const reloader = vi.fn();
      await mountWithLoaded(VALID, reloader);

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...VALID, config_hash: "hash-2" }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      });

      expect(reloader).not.toHaveBeenCalled();
      expect(isReloadScheduled()).toBe(true);
      unregister();
    });

    it("the dirty editor clearing (unsaved text went away) lets the deferred reload fire on the next drain poll", async () => {
      let dirty = true;
      registerDirtyEditor(() => dirty);
      const reloader = vi.fn();
      await mountWithLoaded(VALID, reloader);

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...VALID, config_hash: "hash-2" }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      });
      expect(reloader).not.toHaveBeenCalled();

      dirty = false; // e.g. task-title.tsx's debounce handed off to the mutation
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...VALID, config_hash: "hash-2" }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DRAIN_POLL_MS);
      });
      expect(reloader).toHaveBeenCalledTimes(1);
    });

    it("an unregistered predicate (unmounted editor) no longer protects anything", async () => {
      const unregister = registerDirtyEditor(() => true);
      unregister();
      const reloader = vi.fn();
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...VALID, config_hash: "hash-2" }),
      );
      renderHook(() => useVersionCheck({ reloader }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(reloader).toHaveBeenCalledTimes(1);
    });

    it("a throwing predicate is treated as false, and never crashes the check", async () => {
      registerDirtyEditor(() => {
        throw new Error("boom");
      });
      const reloader = vi.fn();
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...VALID, config_hash: "hash-2" }),
      );
      renderHook(() => useVersionCheck({ reloader }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(reloader).toHaveBeenCalledTimes(1);
    });
  });

  it("malformed version.json: no reload, no throw", async () => {
    const reloader = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse({ release: VALID.release }));
    renderHook(() => useVersionCheck({ reloader }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reloader).not.toHaveBeenCalled();
  });

  it("offline: skips before even fetching a baseline — no reload", async () => {
    const reloader = vi.fn();
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    renderHook(() => useVersionCheck({ reloader }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reloader).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no loop: a mismatch already at the attempt bound in sessionStorage is not retried", async () => {
    const reloader = vi.fn();
    const targetKey = `${VALID.release}::hash-2`;
    sessionStorage.setItem(
      RELOAD_ATTEMPTS_STORAGE_KEY,
      JSON.stringify({
        perTarget: { [targetKey]: MAX_RELOAD_ATTEMPTS_PER_VERSION },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...VALID, config_hash: "hash-2" }),
    );
    renderHook(() => useVersionCheck({ reloader }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reloader).not.toHaveBeenCalled();
  });

  it("writes the bumped attempt count to sessionStorage before reloading", async () => {
    const reloader = vi.fn();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...VALID, config_hash: "hash-2" }),
    );
    renderHook(() => useVersionCheck({ reloader }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const stored = JSON.parse(
      sessionStorage.getItem(RELOAD_ATTEMPTS_STORAGE_KEY) ?? "null",
    );
    expect(stored).toEqual({
      perTarget: { [`${VALID.release}::hash-2`]: 1 },
    });
  });

  describe("Stage 1 round-1 finding 11: bounded across target changes and storage failure", () => {
    it("alternating between two flapping targets still hits a bound", async () => {
      const reloader = vi.fn();
      const targetB = `${VALID.release}::hash-b`;
      const targetC = `${VALID.release}::hash-c`;
      sessionStorage.setItem(
        RELOAD_ATTEMPTS_STORAGE_KEY,
        JSON.stringify({
          perTarget: {
            [targetB]: MAX_RELOAD_ATTEMPTS_PER_VERSION,
            [targetC]: MAX_RELOAD_ATTEMPTS_PER_VERSION,
          },
        }),
      );
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...VALID, config_hash: "hash-b" }),
      );
      renderHook(() => useVersionCheck({ reloader }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(reloader).not.toHaveBeenCalled();
    });

    it("a session-wide bound stops a nonconverging episode even when no single target hit its own cap", async () => {
      const reloader = vi.fn();
      sessionStorage.setItem(
        RELOAD_ATTEMPTS_STORAGE_KEY,
        JSON.stringify({
          perTarget: {
            [`${VALID.release}::h1`]: 1,
            [`${VALID.release}::h2`]: 1,
            [`${VALID.release}::h3`]: 1,
            [`${VALID.release}::h4`]: 1,
          },
        }),
      );
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...VALID, config_hash: "h5" }),
      );
      renderHook(() => useVersionCheck({ reloader }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(reloader).not.toHaveBeenCalled();
    });

    it("a broken sessionStorage refuses to reload rather than reload unbounded", async () => {
      const reloader = vi.fn();
      const originalGetItem = Storage.prototype.getItem;
      Storage.prototype.getItem = () => {
        throw new Error("storage disabled");
      };
      try {
        fetchMock.mockResolvedValueOnce(
          jsonResponse({ ...VALID, config_hash: "hash-2" }),
        );
        renderHook(() => useVersionCheck({ reloader }));
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(reloader).not.toHaveBeenCalled();
      } finally {
        Storage.prototype.getItem = originalGetItem;
      }
    });
  });

  describe("Stage 1 round-1 finding 12: deferred reloads revalidate before firing", () => {
    it("a withdrawn update cancels the deferred reload — the drain poll never fires it", async () => {
      queryMock.mutationCount = 1;
      const reloader = vi.fn();
      const { rerender } = await mountWithLoaded(VALID, reloader);

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...VALID, config_hash: "hash-2" }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      });
      expect(isReloadScheduled()).toBe(true);
      queryMock.mutationCount = 0;
      rerender();

      // The server reverted: the drain poll's revalidation sees the SAME version this
      // document already has.
      fetchMock.mockResolvedValueOnce(jsonResponse(VALID));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DRAIN_POLL_MS);
      });
      expect(reloader).not.toHaveBeenCalled();
      expect(isReloadScheduled()).toBe(false);
    });

    it("a replaced target reloads against the NEW target, not the stale one", async () => {
      queryMock.mutationCount = 1;
      const reloader = vi.fn();
      const { rerender } = await mountWithLoaded(VALID, reloader);

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...VALID, config_hash: "hash-2" }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      });
      queryMock.mutationCount = 0;
      rerender();

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...VALID, config_hash: "hash-3" }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DRAIN_POLL_MS);
      });
      expect(reloader).toHaveBeenCalledTimes(1);

      const stored = JSON.parse(
        sessionStorage.getItem(RELOAD_ATTEMPTS_STORAGE_KEY) ?? "null",
      );
      expect(stored.perTarget[`${VALID.release}::hash-3`]).toBe(1);
      expect(stored.perTarget[`${VALID.release}::hash-2`]).toBeUndefined();
    });
  });
});
