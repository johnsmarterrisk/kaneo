import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeDefines } from "../../vite.config";

// Hoisted so `vi.mock` factories below (themselves hoisted above these imports at
// execution time) can close over a MUTABLE mutation count each `useVersionCheck` test
// controls directly, instead of re-mocking the module per test.
const queryMock = vi.hoisted(() => ({ mutationCount: 0 }));
vi.mock("@tanstack/react-query", () => ({
  useIsMutating: () => queryMock.mutationCount,
}));

const toastMock = vi.hoisted(() => ({ info: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import {
  CHECK_INTERVAL_MS,
  DRAIN_POLL_MS,
  fetchVersionJson,
  formatStamp,
  formatTooltip,
  getLoadedVersion,
  HARD_RELOAD_TIMEOUT_MS,
  hardReload,
  isReloadScheduled,
  MAX_RELOAD_ATTEMPTS_PER_VERSION,
  RELOAD_ATTEMPTS_STORAGE_KEY,
  registerDirtyEditor,
  resetDirtyEditorsForTests,
  resetLoadedVersionForTests,
  resetMutationAdmissionForTests,
  resetReloadScheduledForTests,
  sha7,
  useLoadedVersionInfo,
  useVersionCheck,
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

const targetKey = (configHash: string) =>
  versionKey({ ...VALID, config_hash: configHash });

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // Stage 1 finding 4: the document's OWN loaded version is now read from the
  // `window.__OPERON_LOADED_VERSION__` env.sh writes into index.html, not fetched —
  // stub it to `VALID` as the default baseline every test compares the fetched
  // "latest" against.
  vi.stubGlobal("__OPERON_LOADED_VERSION__", VALID);
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
  cleanup();
  resetMutationAdmissionForTests();
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

describe("getLoadedVersion — read from index.html's slot (open-items 458), never fetched", () => {
  it("reads window.__OPERON_LOADED_VERSION__ without ever calling fetch", async () => {
    const [a, b] = await Promise.all([getLoadedVersion(), getLoadedVersion()]);
    expect(a).toEqual(VALID);
    expect(b).toEqual(VALID);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the un-filled slot (null — vite dev, no env.sh run) resolves to null, never throws", async () => {
    vi.stubGlobal("__OPERON_LOADED_VERSION__", null);
    resetLoadedVersionForTests();
    await expect(getLoadedVersion()).resolves.toBeNull();
  });

  it("a malformed slot value resolves to null", async () => {
    vi.stubGlobal("__OPERON_LOADED_VERSION__", { ...VALID, config_hash: 7 });
    resetLoadedVersionForTests();
    await expect(getLoadedVersion()).resolves.toBeNull();
  });

  it("index.html carries the slot env.sh fills, and vite defines no bundle slot for it", () => {
    const html = readFileSync(
      resolve(import.meta.dirname, "../../index.html"),
      "utf8",
    );
    expect(html).toContain(
      '<script id="operon-loaded-version">window.__OPERON_LOADED_VERSION__ = null;</script>',
    );
    expect(
      Object.keys(runtimeDefines({ VITE_API_URL: "KANEO_API_URL" })),
    ).toEqual(["import.meta.env.VITE_API_URL"]);
  });
});

describe("sha7 / versionKey / formatStamp", () => {
  it("sha7 shortens to 7 characters", () => {
    expect(sha7("a1b2c3d4e5f6")).toBe("a1b2c3d");
    expect(sha7("unknown")).toBe("unknown");
  });

  it("versionKey combines release, Initiative's own fork SHA and config_hash", () => {
    expect(versionKey(VALID)).toBe(
      "2026.09.22-4::f4e5d6c7b8a9f4e5d6c7b8a9f4e5d6c7b8a9f4e5::deadbeef",
    );
    expect(versionKey({ ...VALID, operon_sha: "different" })).toBe(
      versionKey(VALID),
    );
    expect(versionKey({ ...VALID, fork_sha: "different" })).not.toBe(
      versionKey(VALID),
    );
    expect(versionKey({ ...VALID, config_hash: "different" })).not.toBe(
      versionKey(VALID),
    );
  });

  it("versionKey changes across dev builds when Initiative's own fork SHA changes", () => {
    expect(
      versionKey({ ...VALID, release: "unknown", fork_sha: "a".repeat(40) }),
    ).not.toBe(
      versionKey({ ...VALID, release: "unknown", fork_sha: "b".repeat(40) }),
    );
  });

  it('formatStamp renders "v<release>" alone, or an em dash when null', () => {
    expect(formatStamp(VALID)).toBe("v2026.09.22-4");
    expect(formatStamp(null)).toBe("—");
  });

  it("formatStamp does not double-prefix a release already carrying its own v (vMAJOR.MINOR)", () => {
    expect(formatStamp({ ...VALID, release: "v1.0" })).toBe("v1.0");
  });

  it('formatStamp renders "dev" for an empty, unset or "unknown" release', () => {
    expect(formatStamp({ ...VALID, release: "" })).toBe("dev");
    expect(formatStamp({ ...VALID, release: "unknown" })).toBe("dev");
  });

  it('formatTooltip renders "Operon <sha7> · Initiative <sha7>", or "dev build" when both SHAs are unset', () => {
    expect(formatTooltip(VALID)).toBe("Operon a1b2c3d · Initiative f4e5d6c");
    expect(
      formatTooltip({ ...VALID, operon_sha: "unknown", fork_sha: "unknown" }),
    ).toBe("dev build");
    expect(formatTooltip(null)).toBe("dev build");
  });
});

describe("useLoadedVersionInfo", () => {
  it("resolves to null until the embedded constant resolves, then the raw VersionInfo — never fetching", async () => {
    const { result } = renderHook(() => useLoadedVersionInfo());
    expect(result.current).toBeNull();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current).toEqual(VALID);
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
    const boundedTargetKey = targetKey("hash-2");
    sessionStorage.setItem(
      RELOAD_ATTEMPTS_STORAGE_KEY,
      JSON.stringify({
        perTarget: { [boundedTargetKey]: MAX_RELOAD_ATTEMPTS_PER_VERSION },
        loadedKey: versionKey(VALID),
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
      perTarget: { [targetKey("hash-2")]: 1 },
      loadedKey: versionKey(VALID),
    });
  });

  describe("Stage 1 round-1 finding 11: bounded across target changes and storage failure", () => {
    it("alternating between two flapping targets still hits a bound", async () => {
      const reloader = vi.fn();
      const targetB = targetKey("hash-b");
      const targetC = targetKey("hash-c");
      sessionStorage.setItem(
        RELOAD_ATTEMPTS_STORAGE_KEY,
        JSON.stringify({
          perTarget: {
            [targetB]: MAX_RELOAD_ATTEMPTS_PER_VERSION,
            [targetC]: MAX_RELOAD_ATTEMPTS_PER_VERSION,
          },
          loadedKey: versionKey(VALID),
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
            [targetKey("h1")]: 1,
            [targetKey("h2")]: 1,
            [targetKey("h3")]: 1,
            [targetKey("h4")]: 1,
          },
          loadedKey: versionKey(VALID),
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
      expect(stored.perTarget[targetKey("hash-3")]).toBe(1);
      expect(stored.perTarget[targetKey("hash-2")]).toBeUndefined();
    });
  });
});

describe("round 2 reload safety", () => {
  it.each([
    { perTarget: { bad: -1 } },
    { perTarget: { bad: 0.5 } },
    { perTarget: { bad: "1" } },
    { perTarget: [] },
    {},
  ])(
    "corrupt counters stop automatic reload and expose manual recovery: %j",
    async (ledger) => {
      sessionStorage.setItem(
        RELOAD_ATTEMPTS_STORAGE_KEY,
        JSON.stringify(ledger),
      );
      fetchMock.mockResolvedValue(
        jsonResponse({ ...VALID, config_hash: "new" }),
      );
      const reloader = vi.fn();
      renderHook(() => useVersionCheck({ reloader }));
      await act(async () => {});
      expect(reloader).not.toHaveBeenCalled();
      expect(isReloadScheduled()).toBe(true);
      expect(toastMock.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          duration: Number.POSITIVE_INFINITY,
          action: expect.objectContaining({ onClick: expect.any(Function) }),
        }),
      );
      const action = toastMock.info.mock.calls.at(-1)?.[1]?.action;
      act(() => action.onClick());
      expect(reloader).toHaveBeenCalledTimes(1);
    },
  );

  it("convergence resets the episode budget", async () => {
    sessionStorage.setItem(
      RELOAD_ATTEMPTS_STORAGE_KEY,
      JSON.stringify({ perTarget: { old: 4 }, loadedKey: versionKey(VALID) }),
    );
    fetchMock.mockResolvedValue(jsonResponse(VALID));
    renderHook(() => useVersionCheck());
    await act(async () => {});
    expect(
      JSON.parse(sessionStorage.getItem(RELOAD_ATTEMPTS_STORAGE_KEY) ?? "null"),
    ).toEqual({ perTarget: {}, loadedKey: versionKey(VALID) });
  });

  it("going offline while the manifest resolves cannot trigger reload", async () => {
    let finish: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const reloader = vi.fn();
    renderHook(() => useVersionCheck({ reloader }));
    await act(async () => {});
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    await act(async () => {
      finish(jsonResponse({ ...VALID, config_hash: "new" }));
    });
    expect(reloader).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RELOAD_ATTEMPTS_STORAGE_KEY)).toBeNull();
  });

  it("refuses new writes to every origin while an update is pending, keeping reads available", async () => {
    registerDirtyEditor(() => true);
    fetchMock.mockResolvedValue(jsonResponse({ ...VALID, config_hash: "new" }));
    renderHook(() => useVersionCheck());
    await act(async () => {});
    fetchMock.mockClear();
    await expect(
      fetch("https://uploads.example.invalid/blob", { method: "PUT" }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    await fetch("/api/task");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

it("keeps a direct upload protected until it settles and blocks a second write", async () => {
  fetchMock.mockResolvedValue(jsonResponse(VALID));
  const reloader = vi.fn();
  renderHook(() => useVersionCheck({ reloader }));
  await act(async () => {});
  let finishUpload: (response: Response) => void = () => {};
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishUpload = resolve;
      }),
  );
  const upload = fetch("https://storage.example.invalid/upload", {
    method: "PUT",
  });
  fetchMock.mockResolvedValue(jsonResponse({ ...VALID, config_hash: "new" }));
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(reloader).not.toHaveBeenCalled();
  expect(isReloadScheduled()).toBe(true);
  const calls = fetchMock.mock.calls.length;
  await expect(
    fetch(
      new Request("https://api.example.invalid/task", { method: "DELETE" }),
    ),
  ).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(calls);
  await act(async () => {
    finishUpload(jsonResponse({}));
    await upload;
  });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(reloader).toHaveBeenCalledOnce();
});

it("storage write failure exposes recovery without an unaccounted reload", async () => {
  const storageWrite = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("storage unavailable");
    });
  try {
    fetchMock.mockResolvedValue(jsonResponse({ ...VALID, config_hash: "new" }));
    const reloader = vi.fn();
    renderHook(() => useVersionCheck({ reloader }));
    await act(async () => {});
    expect(reloader).not.toHaveBeenCalled();
    expect(isReloadScheduled()).toBe(true);
    expect(toastMock.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        action: expect.objectContaining({ onClick: expect.any(Function) }),
      }),
    );
  } finally {
    storageWrite.mockRestore();
  }
});

// ─── open-items 458: convergence, honest copy, cache-busting reload ────────────────

describe("open-items 458: the reload converges and the copy is honest", () => {
  const settle = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const lastToast = () => toastMock.info.mock.calls.at(-1);
  const ledger = () =>
    JSON.parse(sessionStorage.getItem(RELOAD_ATTEMPTS_STORAGE_KEY) ?? "null");

  it("an exhausted ledger from a DIFFERENT loaded document is reset: the new document reloads", async () => {
    const reloader = vi.fn();
    sessionStorage.setItem(
      RELOAD_ATTEMPTS_STORAGE_KEY,
      JSON.stringify({
        perTarget: { [targetKey("hash-2")]: MAX_RELOAD_ATTEMPTS_PER_VERSION },
        loadedKey: targetKey("previous-document"),
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...VALID, config_hash: "hash-2" }),
    );
    renderHook(() => useVersionCheck({ reloader }));
    await settle();
    expect(reloader).toHaveBeenCalledTimes(1);
    expect(ledger()).toEqual({
      perTarget: { [targetKey("hash-2")]: 1 },
      loadedKey: versionKey(VALID),
    });
  });

  it("a pre-458 ledger (no loadedKey) no longer pins the document at the paused state", async () => {
    const reloader = vi.fn();
    sessionStorage.setItem(
      RELOAD_ATTEMPTS_STORAGE_KEY,
      JSON.stringify({ perTarget: { [targetKey("hash-2")]: 2, x: 2 } }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...VALID, config_hash: "hash-2" }),
    );
    renderHook(() => useVersionCheck({ reloader }));
    await settle();
    expect(reloader).toHaveBeenCalledTimes(1);
  });

  it("flapping stays bounded: the count for the key just left survives the reset", async () => {
    // Document was hash-b, now VALID, and version.json points back at hash-b.
    const reloader = vi.fn();
    const left = targetKey("hash-b");
    sessionStorage.setItem(
      RELOAD_ATTEMPTS_STORAGE_KEY,
      JSON.stringify({
        perTarget: { [left]: MAX_RELOAD_ATTEMPTS_PER_VERSION, other: 1 },
        loadedKey: left,
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...VALID, config_hash: "hash-b" }),
    );
    renderHook(() => useVersionCheck({ reloader }));
    await settle();
    expect(reloader).not.toHaveBeenCalled();
    expect(ledger()).toEqual({
      perTarget: { [left]: MAX_RELOAD_ATTEMPTS_PER_VERSION },
      loadedKey: versionKey(VALID),
    });
  });

  it("the exhausted state shows the Reload copy, never the unsaved-edits copy", async () => {
    const reloader = vi.fn();
    sessionStorage.setItem(
      RELOAD_ATTEMPTS_STORAGE_KEY,
      JSON.stringify({
        perTarget: { [targetKey("hash-2")]: MAX_RELOAD_ATTEMPTS_PER_VERSION },
        loadedKey: versionKey(VALID),
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...VALID, config_hash: "hash-2" }),
    );
    renderHook(() => useVersionCheck({ reloader }));
    await settle();
    const [message, options] = lastToast() ?? [];
    expect(message).toBe("Couldn't update automatically.");
    expect(options.action.label).toBe("Reload");
    expect(JSON.stringify(lastToast())).not.toMatch(/unsaved/i);
  });

  it("the Reload button clears the ledger and performs the reload", async () => {
    const reloader = vi.fn();
    sessionStorage.setItem(
      RELOAD_ATTEMPTS_STORAGE_KEY,
      JSON.stringify({
        perTarget: { [targetKey("hash-2")]: MAX_RELOAD_ATTEMPTS_PER_VERSION },
        loadedKey: versionKey(VALID),
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...VALID, config_hash: "hash-2" }),
    );
    renderHook(() => useVersionCheck({ reloader }));
    await settle();
    act(() => lastToast()?.[1].action.onClick());
    expect(reloader).toHaveBeenCalledTimes(1);
    expect(ledger()).toEqual({ perTarget: {}, loadedKey: versionKey(VALID) });
  });

  it("the dirty path keeps the unsaved-edits copy, and its button also clears the ledger", async () => {
    registerDirtyEditor(() => true);
    const reloader = vi.fn();
    sessionStorage.setItem(
      RELOAD_ATTEMPTS_STORAGE_KEY,
      JSON.stringify({ perTarget: { stale: 1 }, loadedKey: versionKey(VALID) }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...VALID, config_hash: "hash-2" }),
    );
    renderHook(() => useVersionCheck({ reloader }));
    await settle();
    expect(reloader).not.toHaveBeenCalled();
    const [message, options] = lastToast() ?? [];
    expect(message).toBe(
      "A new version is available. Automatic reload is paused. Reloading now discards unsaved edits.",
    );
    expect(options.action.label).toBe("Discard unsaved edits and reload");
    act(() => options.action.onClick());
    expect(reloader).toHaveBeenCalledTimes(1);
    expect(ledger()).toEqual({ perTarget: {}, loadedKey: versionKey(VALID) });
  });
});

describe("hardReload (open-items 458)", () => {
  it("re-fetches the document and this document's same-origin /assets/*.js with cache: reload, then reloads", async () => {
    const reload = vi.fn();
    const origin = window.location.origin;
    vi.stubGlobal("location", {
      href: `${origin}/dashboard?x=1`,
      origin,
      reload,
    });
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { name: `${origin}/assets/index-CRCX_rbg.js` },
      { name: `${origin}/assets/index-abc.css` },
      { name: `${origin}/api/task` },
      { name: "https://cdn.example.invalid/assets/x.js" },
    ] as unknown as PerformanceEntryList);
    fetchMock.mockImplementation(async () => {
      expect(reload).not.toHaveBeenCalled();
      return jsonResponse({});
    });
    await hardReload();
    expect(
      fetchMock.mock.calls.map(([url, init]) => [url, init?.cache]),
    ).toEqual([
      [`${origin}/dashboard?x=1`, "reload"],
      [`${origin}/assets/index-CRCX_rbg.js`, "reload"],
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("still reloads when a refresh fetch hangs (bounded) or fails", async () => {
    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      vi.stubGlobal("location", {
        href: `${window.location.origin}/`,
        origin: window.location.origin,
        reload,
      });
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
      const done = hardReload();
      await vi.advanceTimersByTimeAsync(HARD_RELOAD_TIMEOUT_MS);
      await done;
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
