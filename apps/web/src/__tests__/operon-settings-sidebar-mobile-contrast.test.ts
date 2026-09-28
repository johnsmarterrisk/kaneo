// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for review finding B (fork/initiative-settings, round 2): the mobile
// settings sheet's "Back to workspace" button and the sheet's own close (X) button both
// use the shared ghost Button variant, whose default text color (text-card-foreground,
// dark — meant for a white bg-card panel) is invisible on this sheet's bg-sidebar navy
// surface. Same GUI-4 pattern the rest of the settings pages were already fixed for.
//
// Fix: SettingsSidebar.tsx overrides the back button's own className directly, and passes
// sheet.tsx's new optional `closeButtonClassName` prop to scope the close-button fix to
// this one sheet, WITHOUT changing sheet.tsx's shared default (which task-details-sheet.tsx
// and sidebar.tsx's mobile sheet still use unmodified).

const settingsSidebarSource = readFileSync(
  fileURLToPath(new URL("../components/SettingsSidebar.tsx", import.meta.url)),
  "utf8",
);

const sheetSource = readFileSync(
  fileURLToPath(new URL("../components/ui/sheet.tsx", import.meta.url)),
  "utf8",
);

const taskDetailsSheetSource = readFileSync(
  fileURLToPath(
    new URL("../components/task/task-details-sheet.tsx", import.meta.url),
  ),
  "utf8",
);

describe("mobile settings sheet contrast on navy (review finding B)", () => {
  it("the back-to-workspace button carries sidebar foreground and a sidebar hover fill", () => {
    const backButtonMatch = settingsSidebarSource.match(
      /<Button\s+variant="ghost"\s+size="sm"[\s\S]*?className="([^"]*)"/,
    );
    expect(backButtonMatch).not.toBeNull();
    const className = backButtonMatch?.[1] ?? "";
    expect(className).toContain("text-sidebar-foreground");
    expect(className).toContain("hover:bg-sidebar-accent/10");
    expect(className).toContain("hover:text-sidebar-foreground");
  });

  it("SettingsSidebar scopes the close-button fix via closeButtonClassName, not a shared default", () => {
    expect(settingsSidebarSource).toMatch(
      /closeButtonClassName="[^"]*text-sidebar-foreground[^"]*"/,
    );
  });

  it("sheet.tsx's shared close button stays parameterized, not hardcoded to a surface color", () => {
    // The prop must exist and default to unset (today's behavior for every other sheet).
    expect(sheetSource).toContain("closeButtonClassName?: string");
    expect(sheetSource).toMatch(
      /<Button\s+size="icon"\s+variant="ghost"\s+className=\{closeButtonClassName\}\s*\/>/,
    );
    // The shared file itself must never hardcode a sidebar/navy override.
    expect(sheetSource).not.toContain("text-sidebar-foreground");
  });

  it("another sheet consumer (task details) is untouched by the scoped override", () => {
    expect(taskDetailsSheetSource).not.toContain("closeButtonClassName");
  });
});
