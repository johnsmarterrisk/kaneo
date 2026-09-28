// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for the operator's 2026-09-28 report: the same fault the first writer
// fixed on the project general settings page (operon-project-settings-contrast.test.ts,
// commit ab04823) — dark-on-navy FormLabels/Labels and white-on-white page titles/left
// columns — also existed, unfixed, on the Account and Workspace settings surfaces and
// every one of their sub-pages. Root cause, same as the project page: the shared
// Label/FormLabel primitive defaults to text-card-foreground (dark, correct only on a
// white bg-card panel); a page's own <h1> and the left column's rail text inherit
// text-foreground (white in navy mode, correct only on the navy ground) — so each is
// invisible on the OTHER surface it actually sits on here.

function readRoute(path: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(
        `../routes/_layout/_authenticated/dashboard/${path}`,
        import.meta.url,
      ),
    ),
    "utf8",
  );
}

const accountSource = readRoute("settings/account.tsx");
const workspaceSource = readRoute("settings/workspace.tsx");
const informationSource = readRoute("settings/account/information.tsx");
const notificationsSource = readRoute("settings/account/notifications.tsx");
const preferencesSource = readRoute("settings/account/preferences.tsx");
const developerSource = readRoute("settings/account/developer.tsx");
const workspaceGeneralSource = readRoute("settings/workspace/general.tsx");
const rolesSource = readRoute("settings/workspace/roles.tsx");
const labelsSource = readRoute("settings/workspace/labels.tsx");
const billingSource = readRoute("settings/workspace/billing.tsx");

describe("Account settings left column (settings/account.tsx) — white-panel tokens", () => {
  it("does not use navy-only sidebar tokens on the white settings frame", () => {
    expect(accountSource).not.toMatch(/text-sidebar-foreground/);
    expect(accountSource).not.toMatch(/bg-sidebar-accent/);
    expect(accountSource).not.toMatch(/text-sidebar-accent-foreground/);
  });

  it("the account name and menu items use the white-panel equivalents", () => {
    expect(accountSource).toMatch(
      /<p className="truncate text-sm text-card-foreground /,
    );
    expect(accountSource).toMatch(
      /"h-8 w-full justify-start gap-2 rounded-lg px-2 text-sm font-normal text-muted-foreground",\s*\n\s*isActivePath\(item\.url\) &&\s*\n\s*"bg-accent text-accent-foreground",/,
    );
  });
});

describe("Workspace settings left column (settings/workspace.tsx) — white-panel tokens", () => {
  it("does not use navy-only sidebar tokens on the white settings frame", () => {
    expect(workspaceSource).not.toMatch(/text-sidebar-foreground/);
    expect(workspaceSource).not.toMatch(/bg-sidebar-accent/);
    expect(workspaceSource).not.toMatch(/text-sidebar-accent-foreground/);
    expect(workspaceSource).not.toMatch(/text-sidebar-accent-foreground/);
  });

  it("the workspace avatar has no navy override (relies on AvatarFallback's own bg-muted/text-card-foreground default)", () => {
    expect(workspaceSource).toMatch(
      /<AvatarFallback className="border border-border\/70 text-xs font-medium">/,
    );
  });

  it("the workspace name and menu items use the white-panel equivalents", () => {
    expect(workspaceSource).toMatch(
      /<p className="truncate text-sm text-card-foreground /,
    );
    expect(workspaceSource).toMatch(
      /"h-8 w-full justify-start gap-2 rounded-lg px-2 text-sm font-normal text-muted-foreground",\s*\n\s*isActivePath\(item\.url\) &&\s*\n\s*"bg-accent text-accent-foreground",/,
    );
  });
});

describe("Account/Workspace sub-pages — page <h1> carries text-card-foreground", () => {
  it.each([
    ["account/information.tsx", informationSource],
    ["account/notifications.tsx", notificationsSource],
    ["account/preferences.tsx", preferencesSource],
    ["account/developer.tsx", developerSource],
    ["workspace/general.tsx", workspaceGeneralSource],
    ["workspace/labels.tsx", labelsSource],
  ])("%s", (_name, source) => {
    const h1Tags = [...source.matchAll(/<h1 className="([^"]*)"/g)];
    expect(h1Tags.length).toBeGreaterThan(0);
    for (const match of h1Tags) {
      expect(match[1]).toContain("text-card-foreground");
    }
  });

  it("workspace/roles.tsx — both the no-access and normal h1 carry text-card-foreground", () => {
    const h1Tags = [...rolesSource.matchAll(/<h1 className="([^"]*)"/g)];
    expect(h1Tags.length).toBe(2);
    for (const match of h1Tags) {
      expect(match[1]).toContain("text-card-foreground");
    }
  });

  it("workspace/billing.tsx — both the billing-disabled and normal h1 carry text-card-foreground", () => {
    const h1Tags = [...billingSource.matchAll(/<h1 className="([^"]*)"/g)];
    expect(h1Tags.length).toBe(2);
    for (const match of h1Tags) {
      expect(match[1]).toContain("text-card-foreground");
    }
  });
});

describe("Account/Workspace sub-pages — FormLabel/Label on a bg-sidebar card carries text-sidebar-foreground", () => {
  it("account/information.tsx — Full name and Email FormLabels", () => {
    const formLabelTags = [
      ...informationSource.matchAll(/<FormLabel className="([^"]*)">/g),
    ];
    expect(formLabelTags.length).toBe(2);
    for (const match of formLabelTags) {
      expect(match[1]).toContain("text-sidebar-foreground");
    }
  });

  it("account/preferences.tsx — every Label in the two bg-sidebar cards", () => {
    const labelTags = [
      ...preferencesSource.matchAll(/<Label className="([^"]*)">/g),
    ];
    expect(labelTags.length).toBe(10);
    for (const match of labelTags) {
      expect(match[1]).toContain("text-sidebar-foreground");
    }
  });

  it("workspace/general.tsx — Name and Description FormLabels", () => {
    const formLabelTags = [
      ...workspaceGeneralSource.matchAll(/<FormLabel className="([^"]*)">/g),
    ];
    expect(formLabelTags.length).toBe(2);
    for (const match of formLabelTags) {
      expect(match[1]).toContain("text-sidebar-foreground");
    }
  });

  it("workspace/roles.tsx — the permission-list and draft-role name Labels", () => {
    const labelTags = [...rolesSource.matchAll(/<Label className="([^"]*)">/g)];
    expect(labelTags.length).toBe(2);
    for (const match of labelTags) {
      expect(match[1]).toContain("text-sidebar-foreground");
    }
  });
});
