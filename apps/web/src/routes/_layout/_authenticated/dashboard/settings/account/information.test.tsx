import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "./information";

/**
 * Codex round 1 (versioning-v1 qc), finding 11: a PARENT-level test proving
 * `OperonVersionAbout` is actually mounted and reachable from the account/information
 * settings page. Without this, `operon-version-about.test.tsx` renders the leaf component
 * directly and would stay green even if the `<OperonVersionAbout />` mount line in this
 * route were deleted — this test fails in exactly that case, because it renders the route's
 * own `component`.
 *
 * Mocking pattern (`createFileRoute` returning `options` so `Route.component` is directly
 * renderable) copied from `members.test.tsx`/`gantt.test.tsx`, the established shape for
 * testing a TanStack file-route component directly rather than through a full router.
 */

// STABLE mock return values, `vi.hoisted` so the SAME object comes back on every render —
// a fresh object literal per call (the first draft of this file returned one) gives `user`
// a new identity every render, `useEffect(() => { ... }, [user, profileForm])` fires on
// every single render as a result, and — because that effect calls `profileForm.reset`,
// which itself triggers a re-render — the component render-loops until the stack overflows
// the whole worker process (observed: a native crash, not a clean test failure).
const authMock = vi.hoisted(() => ({
  user: { name: "Jane Rivera", email: "jane@example.test", image: null },
  refetchUser: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useNavigate: () => vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ clear: vi.fn() }),
}));

vi.mock("@/components/providers/auth-provider/hooks/use-auth", () => ({
  default: () => authMock,
}));

vi.mock("@/hooks/mutations/use-update-user-profile", () => ({
  default: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/use-update-user-avatar", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/mutations/use-remove-user-avatar", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/mutations/use-delete-account", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
  SESSION_TOO_OLD: "SESSION_TOO_OLD",
}));

// react-i18next is deliberately NOT mocked: `OperonVersionAbout` pulls in
// `version-check.ts`, which imports the real `@/lib/i18n` at module scope (its version
// toast copy) — that init calls `.use(initReactI18next)`, an export a hand-rolled
// `useTranslation`-only mock does not carry, exactly the failure `members.test.tsx`'s
// simpler mock never hits because that route has no such import chain.

// The leaf component this test proves is MOUNTED — real, not mocked, so its own
// `about-version` testid is what this test actually looks for.

const InformationRoute = (Route as unknown as { component: ComponentType })
  .component;

afterEach(() => {
  cleanup();
});

describe("account/information route", () => {
  it("mounts OperonVersionAbout on the page", () => {
    render(<InformationRoute />);
    expect(screen.getByTestId("about-version")).toBeTruthy();
  });
});
