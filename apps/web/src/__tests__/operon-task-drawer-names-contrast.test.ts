// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for open-items 345 (2026-10-05): in the task drawer, under the navy theme,
// the actor's name on every activity line and the comment author's name were drawn white on
// white (computed rgb(255,255,255) on the drawer's rgb(255,255,255)). The drawer and its hover
// cards are bg-popover and the comment card is bg-card, white panels in navy, while
// text-foreground is the navy ground's white. Same pattern as
// operon-create-project-button-contrast.test.ts: surface ink (text-card-foreground) on the
// white panel; card-foreground equals popover-foreground in light, dark and navy.

const activitySource = readFileSync(
  fileURLToPath(new URL("../components/activity/index.tsx", import.meta.url)),
  "utf8",
);

const commentCardSource = readFileSync(
  fileURLToPath(
    new URL("../components/activity/comment-card.tsx", import.meta.url),
  ),
  "utf8",
);

const indexCss = readFileSync(
  fileURLToPath(new URL("../index.css", import.meta.url)),
  "utf8",
);

// The class list of the element that renders `marker` (the nearest className before it).
function classesBefore(source: string, marker: string): string[] {
  const at = source.indexOf(marker);
  expect(at, `marker ${marker} not found`).toBeGreaterThan(-1);
  const head = source.slice(0, at);
  const open = head.lastIndexOf('className="');
  expect(open).toBeGreaterThan(-1);
  const start = open + 'className="'.length;
  return head.slice(start, head.indexOf('"', start)).split(/\s+/);
}

describe("task drawer names are readable under navy (open-items 345)", () => {
  it("the activity actor name (with and without a member record) and its hover card use surface ink", () => {
    expect(classesBefore(activitySource, "{fallbackName}</span>")).toContain(
      "text-card-foreground",
    );
    expect(
      classesBefore(activitySource, "{user.user.name}\n        </span>"),
    ).toContain("text-card-foreground");
    expect(
      classesBefore(activitySource, "{user.user.name}\n            </p>"),
    ).toContain("text-card-foreground");
  });

  it("the activity line's own text colour is surface ink", () => {
    expect(
      classesBefore(activitySource, "<UserHoverName user={user || null}"),
    ).toContain("text-card-foreground");
  });

  it("the comment author name and its hover card use surface ink", () => {
    const name = classesBefore(
      commentCardSource,
      "{user?.name}\n                </span>",
    );
    expect(name).toContain("text-card-foreground/92");
    expect(name).toContain("hover:text-card-foreground");
    expect(
      classesBefore(commentCardSource, "{user?.name}\n                  </p>"),
    ).toContain("text-card-foreground");
  });

  it("no name in the two components falls back to the navy ground's text-foreground", () => {
    for (const source of [activitySource, commentCardSource]) {
      expect(source).not.toMatch(/font-medium text-foreground/);
    }
    expect(activitySource).not.toMatch(
      /<TimelineContent className="[^"]*\btext-foreground\b/,
    );
  });

  it("navy keeps the panels white and their ink dark (the pairing the fix relies on)", () => {
    const navy = indexCss.slice(indexCss.indexOf(".navy {"));
    const token = (name: string) =>
      navy.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
    expect(token("foreground")).toBe("#ffffff");
    expect(token("popover")).toBe("#ffffff");
    expect(token("card")).toBe("#ffffff");
    expect(token("card-foreground")).toBe("#0b1f3a");
    expect(token("popover-foreground")).toBe(token("card-foreground"));
  });
});
