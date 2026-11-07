import { afterEach, describe, expect, it } from "vitest";
import {
  readScriptSource,
  registerScriptSource,
  resetScriptSourcesForTests,
} from "./script-source";

afterEach(() => resetScriptSourcesForTests());

describe("script source registry", () => {
  it("reads the registered source for its task only", () => {
    registerScriptSource("task-1", () => "live one");
    expect(readScriptSource("task-1")).toBe("live one");
    expect(readScriptSource("task-2")).toBeUndefined();
  });

  it("lets the last registration win", () => {
    registerScriptSource("task-1", () => "first");
    registerScriptSource("task-1", () => "second");
    expect(readScriptSource("task-1")).toBe("second");
  });

  it("unregisters only its own entry", () => {
    const unregisterFirst = registerScriptSource("task-1", () => "first");
    const unregisterSecond = registerScriptSource("task-1", () => "second");
    unregisterFirst();
    expect(readScriptSource("task-1")).toBe("second");
    unregisterSecond();
    expect(readScriptSource("task-1")).toBeUndefined();
  });

  it("propagates a throwing reader", () => {
    registerScriptSource("task-1", () => {
      throw new Error("editor gone");
    });
    expect(() => readScriptSource("task-1")).toThrow("editor gone");
  });

  it("answers undefined when the reader does, so callers fall back to the cache", () => {
    registerScriptSource("task-1", () => undefined);
    const cached = "cached description";
    expect(readScriptSource("task-1") ?? cached).toBe(cached);
  });
});
