// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for the operator's 2026-09-28 report: on the project general
// settings page (/dashboard/settings/projects/<id>/general), the page title and the
// "Project name"/"Key"/"Description" labels were invisible (dark-on-navy or
// white-on-white), and the left column's avatar and project switcher were blank.
// Root cause: this whole area was styled with tokens meant for the OTHER surface it
// sits on now (a white bg-card settings frame, or — for the FormLabels — a navy
// bg-sidebar card upstream never anticipated being paired with the shared Label
// primitive's own text-card-foreground default). Same GUI-4 pattern as
// operon-create-project-button-contrast.test.ts; this file guards the settings
// pages that test did not cover.
//
// This is a SOURCE-TEXT tripwire, not proof of what actually renders: it matches
// className strings, so it would still pass if a class computed to the wrong color at
// runtime, and it can't see the mobile Sheet vs. desktop <aside> the same markup
// renders into (round-1 review finding 7). The rendered proof is
// <scratchpad>/settings-contrast-check.mjs, run by hand against the local stack.

const generalSource = readFileSync(
  fileURLToPath(
    new URL(
      "../routes/_layout/_authenticated/dashboard/settings/projects/$projectId/general.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);

const settingsSource = readFileSync(
  fileURLToPath(
    new URL(
      "../routes/_layout/_authenticated/dashboard/settings.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);

const projectsSource = readFileSync(
  fileURLToPath(
    new URL(
      "../routes/_layout/_authenticated/dashboard/settings/projects.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);

const projectPageSources = [
  generalSource,
  ...["visibility", "workflow", "integrations"].map((page) =>
    readFileSync(
      fileURLToPath(
        new URL(
          `../routes/_layout/_authenticated/dashboard/settings/projects/$projectId/${page}.tsx`,
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ),
];

describe("project general settings page contrast (John, 2026-09-28: title/labels invisible, left column blank)", () => {
  it("section headings on the card frame use card foreground in every project page", () => {
    for (const source of projectPageSources) {
      const headings = [...source.matchAll(/<h2 className="([^"]*)"/g)];
      for (const [, className] of headings) {
        expect(className).toContain("text-card-foreground");
      }
    }
  });

  it("the settings frame's h1 and the project general page's own h1 carry text-card-foreground", () => {
    expect(settingsSource).toMatch(
      /<h1 className="mt-4 hidden pl-1 text-2xl font-semibold text-card-foreground md:block">/,
    );
    expect(generalSource).toMatch(
      /<h1 className="text-2xl font-semibold text-card-foreground">/,
    );
  });

  it("the settings frame's mobile-only title also carries text-card-foreground (finding 6)", () => {
    expect(settingsSource).toMatch(
      /<span className="text-lg font-semibold text-card-foreground">/,
    );
  });

  it("inactive settings tabs on the sidebar surface carry sidebar foreground", () => {
    expect(settingsSource).toContain(
      '<TabsList className="bg-sidebar gap-2 text-sidebar-foreground/70">',
    );
    expect(
      settingsSource.match(
        /hover:text-sidebar-foreground \[&\[data-active\]:hover\]:text-card-foreground/g,
      )?.length,
    ).toBe(3);
  });

  it("the bg-sidebar cards' plain labels and muted hints use text-sidebar-foreground (finding 4)", () => {
    // Icon, Import/Export and Delete Project — the plain <p> labels (no color class
    // before this fix) and the text-xs hints beside them, all inside a bg-sidebar card.
    expect(generalSource).not.toMatch(/<p className="text-sm font-medium">/);
    expect(generalSource).not.toMatch(
      /<p className="text-xs text-muted-foreground">\s*\n\s*\{t\("settings:projectGeneral\.(iconHint|importExportTasksDescription|deleteProjectDescription)"\)\}/,
    );
    const sidebarHints = [
      ...generalSource.matchAll(
        /<p className="text-xs text-sidebar-foreground\/70">/g,
      ),
    ];
    expect(sidebarHints.length).toBeGreaterThanOrEqual(6);
  });

  it("every FormLabel on the navy Project Information card is readable (text-sidebar-foreground)", () => {
    const formLabelOpenTags = [
      ...generalSource.matchAll(/<FormLabel className="([^"]*)">/g),
    ];
    // Project name, Key, Description — the three FormField labels on the bg-sidebar card.
    expect(formLabelOpenTags.length).toBe(3);
    for (const match of formLabelOpenTags) {
      expect(match[1]).toContain("text-sidebar-foreground");
    }
  });

  it("the left column's avatar, project switcher and settings menu are surface-paired", () => {
    // SettingsSidebar renders this exact markup into BOTH a desktop <aside> (white
    // bg-card, md and up) and a mobile Sheet (bg-sidebar navy, every theme) — see
    // account.tsx's comment on the same pattern. Every text/active-state token here must
    // therefore be a bg-sidebar-safe base class (correct on the mobile Sheet, the only
    // visible instance below md) plus an md: override (correct on the desktop aside).
    expect(projectsSource).not.toMatch(/text-foreground"/);

    expect(projectsSource).toMatch(
      /<AvatarFallback className="border border-border\/70 text-xs font-medium">/,
    );
    expect(projectsSource).toMatch(
      /<p className="truncate text-sm text-sidebar-foreground md:text-card-foreground /,
    );
    expect(projectsSource).toMatch(
      /<SelectTrigger\s*\n\s*className="h-8 text-sm font-normal text-sidebar-foreground md:text-card-foreground"/,
    );
    expect(projectsSource).toMatch(
      /text-sm font-normal text-sidebar-foreground\/70 md:text-muted-foreground",\s*\n\s*isActive &&\s*\n?\s*"bg-sidebar-accent text-sidebar-accent-foreground md:bg-accent md:text-accent-foreground",/,
    );
  });
});
