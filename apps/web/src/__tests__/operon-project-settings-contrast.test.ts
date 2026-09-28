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

describe("project general settings page contrast (John, 2026-09-28: title/labels invisible, left column blank)", () => {
  it("the settings frame's h1 and the project general page's own h1 carry text-card-foreground", () => {
    expect(settingsSource).toMatch(
      /<h1 className="mt-4 hidden pl-1 text-2xl font-semibold text-card-foreground md:block">/,
    );
    expect(generalSource).toMatch(
      /<h1 className="text-2xl font-semibold text-card-foreground">/,
    );
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

  it("the left column's avatar, project switcher and settings menu use white-panel tokens", () => {
    // These were the exact broken tokens (verified white-on-white / dark-on-transparent
    // via computed style against the local stack): sidebar-accent assumes a navy ground,
    // text-sidebar-foreground assumes a navy ground, and a bare text-foreground resolves
    // to white in navy mode — all three are wrong on this white bg-card aside.
    expect(projectsSource).not.toMatch(/bg-sidebar-accent/);
    expect(projectsSource).not.toMatch(/text-sidebar-accent-foreground/);
    expect(projectsSource).not.toMatch(/text-sidebar-foreground/);
    expect(projectsSource).not.toMatch(/text-foreground"/);

    // The corrected white-panel equivalents are present at the sites that needed them.
    expect(projectsSource).toMatch(
      /<AvatarFallback className="border border-border\/70 text-xs font-medium">/,
    );
    expect(projectsSource).toMatch(
      /<p className="truncate text-sm text-card-foreground /,
    );
    expect(projectsSource).toMatch(
      /<SelectTrigger\s*\n\s*className="h-8 text-sm font-normal text-card-foreground"/,
    );
    expect(projectsSource).toMatch(
      /text-sm font-normal text-muted-foreground",\s*\n\s*isActive && "bg-accent text-accent-foreground",/,
    );
  });
});
