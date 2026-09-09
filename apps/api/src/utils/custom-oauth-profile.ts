/**
 * The `custom` (Operon) OIDC profile mapper, and the seam that carries the two
 * claims Better Auth does not persist anywhere the workspace bootstrap can read.
 *
 * ── WHY THIS FILE HOLDS A MAP ─────────────────────────────────────────────────
 *
 * Operon is the identity provider for this instance (Operon spec decision 39). Two
 * facts about its profile matter to `databaseHooks.user.create.after` in
 * `../auth.ts`:
 *
 *   * `sub` is the person's 64-hex Nostr **pubkey** (decision 43). Better Auth does
 *     record it — as `account.accountId` with `provider_id = 'custom'` — but it
 *     writes that row *after* the user row, so the user-create hook cannot read it
 *     back, and the table carries no unique constraint on
 *     `(provider_id, account_id)` to look it up by anyway.
 *   * `role` decides whether this login is the one that bootstraps the single
 *     workspace (decision 49). Nothing in Better Auth's user model stores it.
 *
 * The mapper is the ONLY place in the sign-in path that sees the raw profile:
 * `mapProfileToUser` is called with the userinfo document
 * (`better-auth/dist/plugins/generic-oauth/index.mjs:117-121`) immediately before
 * the user is created. So it records what the hook needs in a short-lived,
 * in-process map, keyed by **provider and subject**, and the hook consumes it.
 *
 * ── THE KEY IS THE SUBJECT, NEVER THE EMAIL (round-2 finding 1) ───────────────
 *
 * It used to be the email address, and one map entry per address is one identity
 * per address — which an OIDC subject is emphatically not. Two callbacks for the
 * same address and DIFFERENT subjects (an admin retyping an address onto a second
 * Operon identity, a rekey in flight, a deliberate collision) shared a slot, so
 * the second capture silently OVERWROTE the first. `auth.ts`'s conflict recovery
 * then read the survivor's subject while handling the other callback and could
 * hand one person's Kaneo user — and their session — to the other. The subject is
 * the thing Operon actually authenticated, so the subject is the key, and two
 * concurrent callbacks now occupy two entries that cannot touch each other.
 *
 * Provider-qualified as well as subject-keyed, because `custom` is upstream's
 * generic-OIDC slot and a bare subject would be a value some other provider could
 * one day collide with by accident.
 *
 * Three properties keep that honest rather than clever:
 *
 *   1. **It is consumed, not read.** `takeOperonOidcClaims` deletes the entry, so a
 *      later sign-in can never be provisioned from a stale profile.
 *   2. **It expires.** `mapProfileToUser` runs on EVERY callback, while
 *      `user.create.after` runs only on the first one, so most entries are never
 *      collected; the five-minute TTL is what stops the map growing forever.
 *   3. **It never persists.** These are claims in flight for one request, not a
 *      record. The record is `identities.kaneo_user_id` in Operon's own database,
 *      written by the server-to-server callback.
 *
 * The alternative — a new column on `user` — would be a Drizzle schema change on a
 * 45-migration upstream chain for two values that live for one request. That is
 * exactly the fork drift `docs/fork-discipline.md` exists to prevent.
 */

/** How long a captured profile stays collectable. One sign-in round trip is ms. */
const CLAIMS_TTL_MS = 5 * 60 * 1000;

/**
 * Is this instance an Operon instance at all?
 *
 * Read here, from the environment, rather than imported from `../auth`: `auth.ts` imports
 * THIS module (`mapProfileToUser` is wired into the `genericOAuth` config), so importing
 * the constant back would be a cycle. It is the same two variables in the same order,
 * read once at module scope exactly as `auth.ts` reads them, so the two can never
 * disagree about what mode this process is in.
 *
 * ── WHY THE CAPTURE IS GATED ON IT ───────────────────────────────────────────────────
 *
 * `providerId: "custom"` is UPSTREAM's generic-OIDC slot, not Operon's. Any self-hosted
 * Kaneo can point it at Okta, Authentik or Keycloak, and before this gate every one of
 * those profiles was captured here — which meant an ordinary custom-OIDC login was then
 * treated downstream as an Operon login: `syncOperonInstanceRole` rewrote `user.role`
 * from a `role` claim the provider never meant that way (demoting a real instance
 * administrator to `user` on their next sign-in), the workspace bootstrap auto-joined the
 * person to the earliest workspace, and `hasOperonOidcClaims` waved them straight past
 * `DISABLE_REGISTRATION`'s invitation gate. None of that is upstream behaviour, and R35
 * says upstream behaviour is exactly what a non-Operon instance gets.
 *
 * With the gate, a non-Operon instance captures nothing, so every one of those paths is
 * unreachable rather than merely unlikely: `takeOperonOidcClaims` and
 * `hasOperonOidcClaims` both answer from an empty map. `auth.ts` gates both consumers a
 * second time, because a boundary worth having is worth having on both sides.
 */
const isOperonOidcOnly =
  process.env.OPERON_OIDC_ONLY === "true" ||
  process.env.DISABLE_LOGIN_FORM === "true";

export type OperonOidcClaims = {
  /** The OIDC subject: the identity's 64-hex Nostr pubkey (Operon decision 43). */
  sub: string;
  email: string;
  name: string;
  /** Narrowed to the closed set Operon emits; anything else reads as "member". */
  role: "admin" | "member";
};

const pendingClaims = new Map<
  string,
  { claims: OperonOidcClaims; storedAt: number }
>();

/**
 * The provider id Better Auth files an Operon subject under — `auth.ts`'s
 * `OPERON_PROVIDER_ID`, spelled again here for the same reason `isOperonOidcOnly` is:
 * `auth.ts` imports THIS module, so importing the constant back would be a cycle.
 */
const CLAIMS_PROVIDER_ID = "custom";

function stringOrEmpty(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Provider and subject, and nothing else. An email address is an attribute two
 * identities can share; the pair below is the identity itself.
 */
function claimsKey(sub: string) {
  return `${CLAIMS_PROVIDER_ID}:${sub.trim()}`;
}

function sameEmail(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function prune(now: number) {
  for (const [key, entry] of pendingClaims) {
    if (now - entry.storedAt > CLAIMS_TTL_MS) {
      pendingClaims.delete(key);
    }
  }
}

/**
 * Record the claims of an in-flight Operon sign-in. Exported for the tests; the
 * production caller is `mapCustomOAuthProfileToUser` below.
 */
export function rememberOperonOidcClaims(
  claims: OperonOidcClaims,
  now: number = Date.now(),
) {
  prune(now);
  pendingClaims.set(claimsKey(claims.sub), { claims, storedAt: now });
}

/**
 * Collect and DELETE the claims recorded for a SUBJECT, or `null` when there are
 * none — which is the ordinary case for every sign-in that is not an Operon OIDC
 * account creation, and is what makes the reconciliation a no-op for them.
 *
 * The caller supplies the subject the DATABASE says the session's user holds
 * (`auth.ts`, `takeOperonClaimsForUser`), not one read off the request, so a login
 * can only ever collect the claims of the identity it actually signed in as.
 */
export function takeOperonOidcClaims(
  sub: string | null | undefined,
  now: number = Date.now(),
): OperonOidcClaims | null {
  if (!sub) return null;
  prune(now);
  const key = claimsKey(sub);
  const entry = pendingClaims.get(key);
  if (!entry) return null;
  pendingClaims.delete(key);
  return entry.claims;
}

/**
 * Is there a live Operon profile for this email — WITHOUT consuming it?
 *
 * This is what the registration gate asks. `DISABLE_REGISTRATION` means "no account is
 * created outside the OIDC flow" (Operon decision 42), and the honest test for "inside
 * the OIDC flow" is that Operon's userinfo document was just mapped for this address —
 * not that some OAuth callback is in flight, and certainly not a path string: Better
 * Auth's request path at that moment is an internal spelling this fork does not control,
 * and matching it was observed to refuse the very first sign-in.
 *
 * ── AND IT IS THE ONLY QUESTION THE ADDRESS MAY BE ASKED ─────────────────────────────
 *
 * Deliberately a scan, and deliberately the only reader that takes an email at all. The
 * question here is about an ADDRESS ("is a sign-in for this address in flight") and its
 * answer decides one thing: whether an invitation is required. Every question about
 * WHICH PERSON is signing in — the adapter's conflict recovery, the session
 * reconciliation — is asked of the subject instead, because those answers hand out
 * accounts and an address is not an identity. Round-2 finding 1 is exactly what happens
 * when the two are conflated.
 */
export function hasOperonOidcClaims(
  email: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!email) return false;
  prune(now);
  for (const entry of pendingClaims.values()) {
    if (sameEmail(entry.claims.email, email)) return true;
  }
  return false;
}

/** Test seam: drop every captured profile. Never called in production. */
export function __resetOperonOidcClaims() {
  pendingClaims.clear();
}

export function mapCustomOAuthProfileToUser(profile: Record<string, unknown>) {
  const email = stringOrEmpty(profile.email);
  const nameFromParts = [
    stringOrEmpty(profile.given_name),
    stringOrEmpty(profile.family_name),
  ]
    .filter(Boolean)
    .join(" ");

  const fallbackName = [
    stringOrEmpty(profile.name),
    nameFromParts,
    stringOrEmpty(profile.preferred_username),
    email ? email.split("@")[0] : "",
  ].find(Boolean);

  // `sub` AND an email are both required: the map is keyed by the subject, and a
  // profile with no subject is not an Operon identity, so provisioning it would invent
  // a link to a custody row that does not exist. The email is carried in the entry
  // rather than in its key, because the registration gate still has to recognise the
  // address (`hasOperonOidcClaims`) even though nothing may be IDENTIFIED by it.
  // The gate. On a non-Operon instance this whole block does not run, and the map stays
  // empty for the life of the process — see `isOperonOidcOnly` above. Everything below
  // the `if` is unchanged; upstream's own return value is unchanged in BOTH modes.
  const sub = stringOrEmpty(profile.sub);
  if (isOperonOidcOnly && sub && email) {
    rememberOperonOidcClaims({
      sub,
      email,
      name: fallbackName || email,
      // A closed set, mirroring the claim Operon emits. Any third value reads as
      // "member", so an unexpected role can never bootstrap a workspace.
      role: stringOrEmpty(profile.role) === "admin" ? "admin" : "member",
    });
  }

  return fallbackName ? { name: fallbackName } : {};
}
