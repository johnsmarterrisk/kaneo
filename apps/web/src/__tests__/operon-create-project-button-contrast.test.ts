// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Operon fork check (John, fix brief, GUI-pass rail rebuild): "the header's 'Create
 * project' button renders white on white in navy."
 *
 * `ui/button.tsx`'s `outline` variant pairs `bg-popover` with `text-foreground` — a
 * readable dark-ink-on-white pair in stock light/dark, but white-on-white in `.navy`,
 * where `--foreground` is white-on-CANVAS (theme-proposal.md §4a.1), not ink-on-card, and
 * `bg-popover` is a white card surface. `default` pairs `bg-primary`/`text-primary-
 * foreground` instead, which is a correct pair in all three themes (navy-600/white in
 * light+navy, signal-yellow/navy-ink in dark).
 *
 * This is a SOURCE-TEXT check, not a render test: the route
 * (`dashboard/workspace/$workspaceId/index.tsx`) pulls in workspace queries, permission
 * hooks and DnD context that would need extensive mocking to mount, and the actual defect
 * — which `variant` prop reaches `<Button>` — is fully determined by the source text, not
 * by anything only a render could reveal. `ui/button.tsx`'s own variant-to-token mapping
 * is asserted directly too, so this test would fail if a future edit changed what
 * `outline`/`default` resolve to, not only if the call sites regressed.
 */

const routeSource = readFileSync(
  fileURLToPath(
    new URL(
      "../routes/_layout/_authenticated/dashboard/workspace/$workspaceId/index.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);

const buttonSource = readFileSync(
  fileURLToPath(new URL("../components/ui/button.tsx", import.meta.url)),
  "utf8",
);

describe("the Create Project button's contrast (John: white-on-white in navy)", () => {
  it('no Create Project button uses variant="outline" (explicit "default" or no variant prop, which defaults to the same thing, are both fine)', () => {
    const createProjectBlocks = routeSource
      .split("handleCreateProject}")
      .slice(0, -1); // the text BEFORE each onClick={handleCreateProject}
    expect(createProjectBlocks.length).toBeGreaterThanOrEqual(4);

    for (const block of createProjectBlocks) {
      // The nearest preceding <Button ...> opening tag's variant prop.
      const buttonOpen = block.lastIndexOf("<Button");
      expect(buttonOpen).toBeGreaterThan(-1);
      const tag = block.slice(buttonOpen);
      expect(tag).not.toContain('variant="outline"');
    }
  });

  it("ui/button.tsx's default variant pairs bg-primary with text-primary-foreground (a correct pair in every theme)", () => {
    const defaultVariantMatch = buttonSource.match(/default:\s*\n\s*"([^"]*)"/);
    expect(defaultVariantMatch).not.toBeNull();
    const defaultClasses = defaultVariantMatch?.[1] ?? "";
    expect(defaultClasses).toContain("bg-primary");
    expect(defaultClasses).toContain("text-primary-foreground");
  });

  it("ui/button.tsx's outline variant pairs bg-popover with text-foreground (the pair that breaks in .navy — documented, not changed here)", () => {
    // This test does NOT ask for outline to be fixed globally — only the three named
    // Create Project buttons were in scope. It exists so a future reader who wonders "is
    // outline safe to use elsewhere in navy" finds the answer recorded, not re-discovers
    // the bug by eye.
    const outlineVariantMatch = buttonSource.match(/outline:\s*\n\s*"([^"]*)"/);
    expect(outlineVariantMatch).not.toBeNull();
    const outlineClasses = outlineVariantMatch?.[1] ?? "";
    expect(outlineClasses).toContain("bg-popover");
    expect(outlineClasses).toContain("text-foreground");
  });
});
