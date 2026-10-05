import * as Sentry from "@sentry/node";
import { APIError } from "better-auth/api";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { auth } from "../auth";
import {
  assertOperonAgentAlive,
  operonKeyKind,
} from "../operon-agent-liveness";
import { verifyApiKey } from "./verify-api-key";

// User is tagged on Sentry's isolation scope; the per-request isolation
// scope is forked by Sentry.withIsolationScope in the api.use("*", ...)
// middleware, so this only affects the in-flight request.
function attachUserToScope(userId: string) {
  Sentry.setUser({ id: userId });
}

function isAuthRejection(error: unknown) {
  if (!(error instanceof APIError)) {
    return false;
  }
  const status = typeof error.statusCode === "number" ? error.statusCode : 0;
  return status >= 400 && status < 500;
}

async function getSession(headers: Headers) {
  try {
    return await auth.api.getSession({ headers });
  } catch (error) {
    if (isAuthRejection(error)) {
      return null;
    }
    throw error;
  }
}

async function getSessionFromBearerOnlyHeaders(c: Context) {
  const headers = new Headers(c.req.raw.headers);
  headers.delete("cookie");
  // Operon agent-initiative D20: a Bearer that failed key verification must not
  // authenticate through the api-key plugin as a second header's key-built session,
  // which carries no key ceiling and skips the agent liveness check.
  headers.delete("x-api-key");

  return getSession(headers);
}

function parseBearerToken(authHeader: string | undefined): {
  token: string | null;
  malformed: boolean;
} {
  if (!authHeader) {
    return { token: null, malformed: false };
  }

  if (!authHeader.match(/^Bearer\b/i)) {
    return { token: null, malformed: false };
  }

  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    return { token: null, malformed: true };
  }

  return {
    token: match[1] ?? null,
    malformed: false,
  };
}

type VerifiedKey = Awaited<ReturnType<typeof verifyApiKey>>;

/**
 * Operon agent-initiative D20: every VERIFIED Operon agent key on the request, in either
 * header, must be vouched for by Operon before anything else authenticates it, even when
 * the other header holds a human session or another key. A refusal throws the same 401 a
 * disabled key gets. Returns whether an agent key was presented.
 */
async function checkOperonAgentKeys(
  ...results: VerifiedKey[]
): Promise<boolean> {
  let agent = false;
  for (const result of results) {
    if (!result?.valid || operonKeyKind(result.key.metadata) !== "agent") {
      continue;
    }
    await assertOperonAgentAlive(result.key.userId, result.key.id);
    agent = true;
  }
  return agent;
}

/**
 * Resolves `{ operonAgent }`: true when an Operon agent key authenticated (or rode
 * along on) this request, so the WebSocket upgrades can refuse it (D20).
 */
export async function authenticateApiRequest(
  c: Context,
): Promise<{ operonAgent: boolean }> {
  const { token, malformed } = parseBearerToken(c.req.header("Authorization"));
  if (malformed) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const apiKeyHeader = c.req.header("x-api-key")?.trim();
  if (!token && apiKeyHeader) {
    const apiKeyResult = await verifyApiKey(apiKeyHeader);
    if (!apiKeyResult?.valid || !apiKeyResult.key) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const operonAgent = await checkOperonAgentKeys(apiKeyResult);
    const key = apiKeyResult.key;
    c.set("userId", key.userId);
    c.set("userEmail", "");
    c.set("user", null);
    c.set("session", null);
    c.set("apiKey", {
      id: key.id,
      userId: key.userId,
      enabled: key.enabled,
      permissions: key.permissions,
    });
    attachUserToScope(key.userId);
    return { operonAgent };
  }

  if (token) {
    const apiKeyResult = await verifyApiKey(token);
    // D20: an `x-api-key` beside a Bearer is otherwise ignored, but must still pass.
    const besideResult = apiKeyHeader ? await verifyApiKey(apiKeyHeader) : null;
    const operonAgent = await checkOperonAgentKeys(apiKeyResult, besideResult);
    if (apiKeyResult?.valid && apiKeyResult.key) {
      const key = apiKeyResult.key;
      c.set("userId", key.userId);
      c.set("userEmail", "");
      c.set("user", null);
      c.set("session", null);
      c.set("apiKey", {
        id: key.id,
        userId: key.userId,
        enabled: key.enabled,
        permissions: key.permissions,
      });
      attachUserToScope(key.userId);
      return { operonAgent };
    }
    const sessionResult = await getSessionFromBearerOnlyHeaders(c);
    if (sessionResult?.user && sessionResult.session) {
      c.set("user", sessionResult.user);
      c.set("session", sessionResult.session);
      c.set("userId", sessionResult.user.id);
      c.set("userEmail", sessionResult.user.email ?? "");
      attachUserToScope(sessionResult.user.id);
      return { operonAgent };
    }
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const sessionResult = await getSession(c.req.raw.headers);
  c.set("user", sessionResult?.user ?? null);
  c.set("session", sessionResult?.session ?? null);
  c.set("userId", sessionResult?.user?.id ?? "");
  c.set("userEmail", sessionResult?.user?.email ?? "");

  if (!sessionResult?.user) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  attachUserToScope(sessionResult.user.id);
  return { operonAgent: false };
}

export async function resolveAssetBearerOrCookie(c: Context): Promise<{
  userId: string;
  apiKeyId?: string;
}> {
  const { token, malformed } = parseBearerToken(c.req.header("Authorization"));
  if (malformed) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const apiKeyHeader = c.req.header("x-api-key")?.trim();
  if (!token && apiKeyHeader) {
    const apiKeyResult = await verifyApiKey(apiKeyHeader);
    await checkOperonAgentKeys(apiKeyResult);
    if (apiKeyResult?.valid && apiKeyResult.key) {
      return {
        userId: apiKeyResult.key.userId,
        apiKeyId: apiKeyResult.key.id,
      };
    }
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  if (token) {
    const apiKeyResult = await verifyApiKey(token);
    await checkOperonAgentKeys(
      apiKeyResult,
      apiKeyHeader ? await verifyApiKey(apiKeyHeader) : null,
    );
    if (apiKeyResult?.valid && apiKeyResult.key) {
      return {
        userId: apiKeyResult.key.userId,
        apiKeyId: apiKeyResult.key.id,
      };
    }
    const sessionResult = await getSessionFromBearerOnlyHeaders(c);
    if (sessionResult?.user?.id) {
      return { userId: sessionResult.user.id };
    }
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const sessionResult = await getSession(c.req.raw.headers);
  if (!sessionResult?.user) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  return { userId: sessionResult.user.id };
}
