import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
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

describe("route edge cases", () => {
  it.each(["members", "settings", "search", "unknown/child"])(
    "%s stays in Work and backs up to the workspace",
    (suffix) => {
      const path = `/dashboard/workspace/ws-1/${suffix}`;
      expect(phoneScreenForPath(path)).toBe("work");
      expect(phoneBackTarget(path)).toEqual({
        to: "/dashboard/workspace/ws-1",
      });
    },
  );

  it.each([
    "/",
    "/unknown",
    "/dashboard",
    "/dashboard/settings/account",
    "/dashboard/workspace/create",
  ])("%s cannot leave for the apex", (path) =>
    expect(phoneBackTarget(path)).toEqual({ to: "/dashboard" }),
  );

  it("preserves encoded ids and tolerates a trailing slash", () => {
    expect(
      phoneBackTarget("/dashboard/workspace/w%20s/project/p%20x/task/t/"),
    ).toEqual({ to: "/dashboard/workspace/w%20s/project/p%20x/board" });
    expect(phoneBackTarget("/dashboard/workspace/ws-1/")).toEqual({
      apex: true,
    });
  });
});

// Compile away comments with a real parser, rather than deleting comment-like text
// inside string literals. Scan all production web sources, including new phone files.
function executable(source: string): string {
  return (
    transformSync(source, {
      configFile: false,
      babelrc: false,
      comments: false,
      parserOpts: { plugins: ["typescript", "jsx"] },
    })?.code ?? ""
  );
}
const historyInterception =
  /\b(?:pushState|replaceState|popstate|onpopstate)\b|\bhistory\s*(?:\?\.)?\s*(?:\.\s*back|\[\s*["']back["']\s*\])/;
function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    return /\.tsx?$/.test(path) &&
      !/\.test\.|routeTree\.gen|\.d\.ts$/.test(path)
      ? [path]
      : [];
  });
}

describe("no history interception in reachable web source", () => {
  it("checks executable source, including new files and the Navigate subtree", () => {
    for (const file of productionFiles(join(process.cwd(), "src"))) {
      // This unused upstream component predates the phone fork and is outside the
      // permitted edit fence. Keep it unreachable until its fallback is repaired.
      if (file.endsWith("/components/settings-layout.tsx")) continue;
      const code = executable(readFileSync(file, "utf8"));
      expect(code, file).not.toMatch(historyInterception);
      expect(
        code,
        `${file} imports the unused history-back component`,
      ).not.toMatch(/["'][^"']*settings-layout(?:\.[tj]sx?)?["']/);
    }
  });

  it.each([
    "window.history.pushState({}, '')",
    "window.history /* comment */ .replaceState({}, '')",
    "const { pushState } = window.history",
    "window.history['back']()",
    "window.addEventListener(`popstate`, handler)",
    "const url = 'https://example.test'; window.history.back()",
  ])("rejects a restored history operation: %s", (source) => {
    expect(executable(source)).toMatch(historyInterception);
  });

  it("allows comments documenting the removed operations", () => {
    expect(
      executable("/* history.back(); popstate */ const x = 1; // pushState"),
    ).not.toMatch(historyInterception);
  });

  it("keeps router pending delays at their defaults", () => {
    const code = executable(
      readFileSync(join(process.cwd(), "src/main.tsx"), "utf8"),
    );
    expect(code).toContain("defaultPendingComponent: RoutePending");
    expect(code).not.toMatch(/\bdefaultPending(?:Min)?Ms\s*:/);
  });
});
