import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalLink } from "@/types/external-link";

/**
 * Operon fork check (spec R16, task B12).
 *
 * One claim: a `telegraph` external link on a task renders as a link to the Telegraph
 * deep-link route on the apex host taken from CONFIGURATION —
 * `${OPERON_APEX_URL}/#/telegraph/msg/<event id>` — and NOT to the `url` column the
 * row happens to carry. The test stores a decoy `url` that appears nowhere else and
 * configures an apex host that appears in no source file, so both a hard-coded literal
 * and a lazy `href={link.url}` fail it.
 *
 * A github link is rendered alongside, so the test also proves the change did not
 * redirect every other provider's link through the apex.
 *
 * See `docs/fork-discipline.md` in the Operon repository.
 */

vi.mock("@/hooks/use-user-websocket", () => ({
  useUserWebSocket: vi.fn(),
}));

const { ExternalLinksAccordion } = await import(
  "@/components/external-links/external-links-accordion"
);

const EVENT_ID =
  "9f1c2d3e4a5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";

const telegraphLink: ExternalLink = {
  id: "link-telegraph",
  taskId: "task-1",
  integrationId: "integration-telegraph",
  resourceType: "message",
  externalId: EVENT_ID,
  // A decoy: nothing may render this. See the header comment.
  url: "https://stale-host.invalid/whatever",
  title: "Ship the relay patch",
  metadata: null,
  integration: { id: "integration-telegraph", type: "telegraph" },
};

const githubLink: ExternalLink = {
  id: "link-github",
  taskId: "task-1",
  integrationId: "integration-github",
  resourceType: "issue",
  externalId: "412",
  url: "https://github.com/example/repo/issues/412",
  title: "Upstream issue",
  metadata: null,
  integration: { id: "integration-github", type: "github" },
};

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("ExternalLinksAccordion — telegraph links", () => {
  it("renders a telegraph link as the apex deep link, from configuration", () => {
    // A host that exists in no source file, so only a configured read produces it.
    vi.stubEnv("VITE_OPERON_APEX_URL", "https://apex.b12.test:9443/");

    render(
      <ExternalLinksAccordion externalLinks={[telegraphLink, githubLink]} />,
    );

    const telegraph = screen.getByTestId("telegraph-external-link");
    expect(telegraph.getAttribute("href")).toBe(
      `https://apex.b12.test:9443/#/telegraph/msg/${EVENT_ID}`,
    );
    expect(telegraph.getAttribute("href")).not.toContain("stale-host.invalid");
    expect(telegraph.getAttribute("href")).not.toContain("lvh.me");

    // Every other provider keeps the url the row carries.
    const github = screen.getByText("Upstream issue").closest("a");
    expect(github?.getAttribute("href")).toBe(
      "https://github.com/example/repo/issues/412",
    );
    expect(github?.getAttribute("data-testid")).toBeNull();
  });
});
