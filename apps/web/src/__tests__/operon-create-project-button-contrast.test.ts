// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard both the primary action and secondary controls against white-on-white regressions.

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

  it("outline controls use surface ink on the popover surface", () => {
    const outlineClasses = buttonSource.match(/outline:\s*\n\s*"([^"]*)"/)?.[1];
    expect(outlineClasses).toContain("bg-popover");
    expect(outlineClasses).toContain("text-card-foreground");
    expect(outlineClasses).not.toMatch(/(?:^|\s)text-foreground(?:\s|$)/);
  });
});
