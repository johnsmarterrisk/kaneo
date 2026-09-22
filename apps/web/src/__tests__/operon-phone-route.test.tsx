import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { phoneBackTarget, phoneScreenForPath } from "@/store/phone-nav";

/**
 * The phone Navigate/Work model, now DERIVED FROM THE ROUTE (John, real iPhone
 * 2026-09-22).
 *
 * This replaces `operon-phone-nav-history.test.tsx`, which encoded the model this build
 * removed: a back arrow calling `history.back()`, a `popstate` listener reading stamped
 * entries, seeded `replaceState`/`pushState` pairs and a `traversing` flag to suppress the
 * route effect for one render. On a real iPhone that combination could loop and hang
 * Safari hard enough to need force-quitting, and headless WebKit never reproduced it —
 * which is exactly how it shipped. Nothing is intercepted now, so the tests are about one
 * question: what does this URL mean?
 */

describe("which screen a path is", () => {
  it("the workspace ROOT is Navigate — the list is the point there", () => {
    expect(phoneScreenForPath("/dashboard/workspace/ws-1")).toBe("navigate");
    expect(phoneScreenForPath("/dashboard/workspace/ws-1/")).toBe("navigate");
  });

  it("anything deeper is Work — the address named a thing", () => {
    for (const path of [
      "/dashboard/workspace/ws-1/project/p-1",
      "/dashboard/workspace/ws-1/project/p-1/board",
      "/dashboard/workspace/ws-1/project/p-1/task/t-9",
    ]) {
      expect(phoneScreenForPath(path), path).toBe("work");
    }
  });

  it("a path outside the workspace tree falls back to Navigate, never a dead end", () => {
    expect(phoneScreenForPath("/dashboard/settings/account")).toBe("navigate");
    expect(phoneScreenForPath("/")).toBe("navigate");
  });
});

describe("where back goes — one step up the route, never history.back()", () => {
  it("task detail closes to its project board", () => {
    expect(
      phoneBackTarget("/dashboard/workspace/ws-1/project/p-1/task/t-9"),
    ).toEqual({ to: "/dashboard/workspace/ws-1/project/p-1/board" });
  });

  it("a project or board closes to the workspace root", () => {
    expect(
      phoneBackTarget("/dashboard/workspace/ws-1/project/p-1/board"),
    ).toEqual({
      to: "/dashboard/workspace/ws-1",
    });
    expect(phoneBackTarget("/dashboard/workspace/ws-1/project/p-1")).toEqual({
      to: "/dashboard/workspace/ws-1",
    });
  });

  it("the workspace root leaves for the Operon apex", () => {
    // The only location assignment left in the fork's phone code, and it is a FORWARD
    // navigation to another origin rather than a traversal of this one's history.
    expect(phoneBackTarget("/dashboard/workspace/ws-1")).toEqual({
      apex: true,
    });
  });
});

describe("no history interception survives anywhere in the phone code", () => {
  const files = [
    "src/components/common/layout.tsx",
    "src/store/phone-nav.ts",
    "src/components/common/workspace-layout.tsx",
    "src/components/common/project-layout.tsx",
    "src/components/common/task-layout.tsx",
  ];

  it("no pushState, replaceState, popstate listener or history.back() in executable code", () => {
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      // Comments explaining the removal are expected and welcome; CODE is not. Strip block
      // and line comments before looking.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${file} still pushes history`).not.toMatch(
        /history\.pushState/,
      );
      expect(code, `${file} still replaces history`).not.toMatch(
        /history\.replaceState/,
      );
      expect(code, `${file} still goes back`).not.toMatch(/history\.back\(/);
      expect(code, `${file} still listens for popstate`).not.toMatch(
        /"popstate"|'popstate'/,
      );
    }
  });
});
