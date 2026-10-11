/**
 * The fork's phone Navigate/Work model — **derived from the route, and nothing else**.
 *
 * WHY THE HISTORY STACK IS GONE (John, real iPhone, 2026-09-22). The previous model made
 * Navigate/Work a browser-history concern: the back arrow called `history.back()`, a
 * `popstate` listener read a stamped entry back, a cold mount seeded entries with
 * `replaceState` + `pushState`, and a `traversing` flag suppressed the route effect for one
 * render. On a real iPhone that combination could LOOP — the intercepted `popstate` and the
 * `replaceState` that followed it kept re-entering — and Safari hung hard enough that John
 * had to kill the app. Headless WebKit never reproduced it, which is exactly why it shipped.
 *
 * The replacement has no state to desync and nothing to intercept. A URL already says which
 * screen belongs on it, so the screen is read from the URL; the back arrow is an ordinary
 * router navigation to the parent route; and Safari's own Back button then simply follows
 * the router's history like any other link. There is no `pushState`, no `popstate`
 * listener and no `history.back()` anywhere in the fork's phone code.
 */

/** Which of the two phone screens a path belongs to. */
export type PhoneScreen = "navigate" | "work";

const WORKSPACE_ROOT = /^\/dashboard\/workspace\/([^/]+)\/?$/;
const WORKSPACE_ANY = /^\/dashboard\/workspace\/([^/]+)(?:\/(.*))?$/;
const TASK_ROUTE =
  /^\/dashboard\/workspace\/([^/]+)\/project\/([^/]+)\/task\/[^/]+\/?$/;
const PROJECT_ROUTE =
  /^\/dashboard\/workspace\/([^/]+)\/project\/([^/]+)(?:\/.*)?$/;

/**
 * The workspace ROOT is the list — Navigate. Anything deeper (a project, a board, a task)
 * is a thing the address named, so it is Work. A path outside the workspace tree
 * (settings, onboarding) has no Work screen of its own and falls back to Navigate, which is
 * always reachable and never traps the reader.
 */
export function phoneScreenForPath(pathname: string): PhoneScreen {
  if (WORKSPACE_ROOT.test(pathname)) return "navigate";
  return WORKSPACE_ANY.test(pathname) ? "work" : "navigate";
}

/** Kept for the callers that only ask "is the list showing". */
export function phoneNavOpenForPath(pathname: string): boolean {
  return phoneScreenForPath(pathname) === "navigate";
}

/**
 * Where the back arrow (and every X) goes: one step up the route, never `history.back()`.
 *
 * `{ to }` is a router navigation. `{ apex: true }` means the reader is already at the
 * workspace root, where "back" leaves Initiative for the Operon apex — the only place the
 * fork's phone code performs a location assignment, and it is a forward navigation to
 * another origin rather than a traversal of this one's history.
 */
export function phoneBackTarget(
  pathname: string,
): { to: string } | { apex: true } {
  const task = TASK_ROUTE.exec(pathname);
  if (task) {
    return { to: `/dashboard/workspace/${task[1]}/project/${task[2]}/board` };
  }
  const project = PROJECT_ROUTE.exec(pathname);
  if (project) return { to: `/dashboard/workspace/${project[1]}` };
  const workspace = WORKSPACE_ANY.exec(pathname);
  if (workspace?.[2]) {
    return { to: `/dashboard/workspace/${workspace[1]}` };
  }
  if (WORKSPACE_ROOT.test(pathname) && workspace?.[1] !== "create") {
    return { apex: true };
  }
  // Unknown and non-workspace routes stay in the app; /dashboard resolves the
  // active workspace (or onboarding) through the router.
  return { to: "/dashboard" };
}

/**
 * Operon fork addition (Tables task 15, spec 7.11; docs/fork-discipline.md rows 2 and 18):
 * the phone bottom tab bar's addressing. The bar is shared in shape with Operon's
 * `app/src/shell/BottomTabBar.tsx`: "Telegraph" · "Initiative" · "Tables" · "More".
 */
export type BottomTab = "telegraph" | "initiative" | "tables" | "more";

const TABLE_ROUTE = /^\/dashboard\/workspace\/[^/]+\/project\/[^/]+\/table\/?$/;

/** A table's own screen marks "Tables"; every other Initiative screen marks "Initiative". */
export function bottomTabForPath(pathname: string): BottomTab {
  return TABLE_ROUTE.test(pathname) ? "tables" : "initiative";
}

/** The workspace the current address is inside, or null outside the workspace tree. */
export function workspaceIdForPath(pathname: string): string | null {
  const match = WORKSPACE_ANY.exec(pathname);
  return match && match[1] !== "create" ? match[1] : null;
}

/** The Tables section's anchor on the workspace list (`tables-section.tsx`'s `id`). */
export const TABLES_ANCHOR_ID = "tables";

/**
 * "Scroll to the Tables section once it has rendered", as a one-shot flag rather than the
 * URL's hash alone. Operon's Tables tab arrives at `/#tables`, and the router's redirects
 * (`/` → `/dashboard` → the workspace list) drop the hash before any screen renders — so
 * `main.tsx` captures it before the router runs (as it already does for the checkout
 * intent), and the section consumes it when its tables have loaded.
 */
let tablesAnchorPending = false;

export function captureTablesAnchor(hash: string = window.location.hash): void {
  if (hash === `#${TABLES_ANCHOR_ID}`) tablesAnchorPending = true;
}

export function requestTablesAnchor(): void {
  tablesAnchorPending = true;
}

/** True once per request; the caller scrolls. */
export function takeTablesAnchor(): boolean {
  const pending = tablesAnchorPending;
  tablesAnchorPending = false;
  return pending;
}
