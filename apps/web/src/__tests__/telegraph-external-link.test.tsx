import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
 * A SECOND claim (spec R12, task T9): the telegraph link carries NO `target`, so it
 * navigates the tab it was clicked in, while the github link keeps `target="_blank"`.
 * That asymmetry is the claim — Operon's session-restore profile lives in
 * `sessionStorage`, which a tab opened from this cross-origin document does not inherit,
 * so a `_blank` telegraph link lands on Operon's login rather than on the message.
 * Asserting only the absence would also pass if the attribute had been dropped from
 * EVERY link, which would silently change GitHub and Gitea too, so both halves are
 * asserted. `rel` is asserted on both because it stays on both.
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

  it("opens a telegraph link in the current tab and every other link in a new one", () => {
    vi.stubEnv("VITE_OPERON_APEX_URL", "https://apex.b12.test:9443/");

    render(
      <ExternalLinksAccordion externalLinks={[telegraphLink, githubLink]} />,
    );

    // No `target` at all — not `_self`, which would be an equally same-tab but
    // needlessly explicit spelling; React renders `undefined` as an absent attribute.
    const telegraph = screen.getByTestId("telegraph-external-link");
    expect(telegraph.getAttribute("target")).toBeNull();
    expect(telegraph.getAttribute("rel")).toBe("noopener noreferrer");

    // The negative control: a third-party host has no Operon session to keep, so it
    // still opens away from the board the reader is working on.
    const github = screen.getByText("Upstream issue").closest("a");
    expect(github?.getAttribute("target")).toBe("_blank");
    expect(github?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

/**
 * S10/S11: a `file` resourceType takes the Stash route, and the target is
 * resolved through `GET /files/:id/meta` on the apex so a deleted pointer names
 * what used to be there and an unavailable service never reads as "deleted".
 */
const FILE_ID = "11111111-1111-4111-8111-111111111111";

const fileLink: ExternalLink = {
  id: "link-file",
  taskId: "task-1",
  integrationId: "integration-telegraph",
  resourceType: "file",
  externalId: FILE_ID,
  // A decoy: the apex route is configured, never the stored url.
  url: "https://stale-host.invalid/files/whatever",
  title: "Quarterly brief",
  metadata: null,
  integration: { id: "integration-telegraph", type: "telegraph" },
};

function stubMeta(responder: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes(`/api/files/${FILE_ID}/meta`))
        return responder();
      throw new TypeError("Failed to fetch");
    }),
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("ExternalLinksAccordion — Stash file links", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes a file link to the apex #/files/<id> and a message link to #/telegraph/msg/<id>", async () => {
    vi.stubEnv("VITE_OPERON_APEX_URL", "https://apex.s11.test:9443/");
    stubMeta(() =>
      jsonResponse(200, {
        id: FILE_ID,
        name: "Quarterly brief",
        size: 10,
        mime: "application/pdf",
        parentId: null,
        deletedAt: null,
      }),
    );

    render(
      <ExternalLinksAccordion externalLinks={[fileLink, telegraphLink]} />,
    );

    const file = await screen.findByTestId("file-external-link");
    expect(file.getAttribute("href")).toBe(
      `https://apex.s11.test:9443/#/files/${FILE_ID}`,
    );
    expect(file.getAttribute("href")).not.toContain("stale-host.invalid");

    const message = screen.getByTestId("telegraph-external-link");
    expect(message.getAttribute("href")).toBe(
      `https://apex.s11.test:9443/#/telegraph/msg/${EVENT_ID}`,
    );
  });

  it("renders a tombstone as a NAMED dead reference, not a broken link", async () => {
    vi.stubEnv("VITE_OPERON_APEX_URL", "https://apex.s11.test:9443/");
    stubMeta(() =>
      jsonResponse(200, {
        id: FILE_ID,
        name: "Quarterly brief",
        deletedAt: "2026-09-13T10:00:00.000Z",
        tombstone: true,
      }),
    );

    render(<ExternalLinksAccordion externalLinks={[fileLink]} />);

    const dead = await screen.findByTestId("file-external-link-deleted");
    expect(dead.textContent).toContain("Quarterly brief");
    expect(dead.textContent).toContain("deleted");
    expect(screen.queryByTestId("file-external-link")).toBeNull();
  });

  it("renders a 5xx as temporarily unavailable, never as deleted", async () => {
    vi.stubEnv("VITE_OPERON_APEX_URL", "https://apex.s11.test:9443/");
    stubMeta(() => jsonResponse(500, { error: "internal_error" }));

    render(<ExternalLinksAccordion externalLinks={[fileLink]} />);

    const unavailable = await screen.findByTestId(
      "file-external-link-unavailable",
    );
    expect(unavailable.textContent).toContain("temporarily unavailable");
    expect(screen.queryByText(/deleted/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("renders a 404 as a broken link", async () => {
    vi.stubEnv("VITE_OPERON_APEX_URL", "https://apex.s11.test:9443/");
    stubMeta(() => jsonResponse(404, { error: "not_found" }));

    render(<ExternalLinksAccordion externalLinks={[fileLink]} />);

    await waitFor(() =>
      expect(screen.getByTestId("file-external-link-not-found")).toBeTruthy(),
    );
  });
});
