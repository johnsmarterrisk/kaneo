import { describe, expect, it } from "vitest";
import { apiRouter, createRoute, z } from "../../../apps/api/src/openapi";
import { updateProjectBody } from "../../../apps/api/src/project/schema";

// Regression guard for the extra review round on fork/initiative-settings (fee3d00):
// making every field on updateProjectBody optional (so General and Visibility can each
// send only the field they own) meant an empty body, or a body of only unrecognized
// fields, also passed validation. It then reached update-project.ts's controller, whose
// `.set({})` Drizzle call throws "No values to set" — a 500, not a validation error, and
// a write attempt that should never have happened.
//
// The fix is the schema-level `.refine()` on updateProjectBody requiring at least one
// recognized field. This is a REQUEST-level test: it exercises the real
// updateProjectBody schema through an actual OpenAPIHono app (built with the project's
// own apiRouter(), so its shared defaultHook — the thing that turns a Zod failure into
// the route's normal 400 — runs exactly as it does in production), never the full app
// with its auth/workspace middleware or a database, which is out of scope for a
// validation-layer fix.

function buildTestApp() {
  const route = createRoute({
    method: "put",
    path: "/test-update-project-body",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: updateProjectBody } },
      },
    },
    responses: {
      200: {
        description: "Echoes the validated body",
        content: {
          "application/json": {
            schema: z.object({ received: z.record(z.string(), z.unknown()) }),
          },
        },
      },
    },
  });

  const app = apiRouter();
  app.openapi(route, (c) => {
    const body = c.req.valid("json");
    return c.json({ received: body }, 200);
  });
  return app;
}

async function putBody(body: unknown) {
  const app = buildTestApp();
  return app.request("/test-update-project-body", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("updateProjectBody — empty update is refused, not a server error", () => {
  it("rejects an empty body with 400, not 500", async () => {
    const response = await putBody({});

    // This is the assertion that fails without the fix: pre-fix, {} passed validation
    // (every field optional) and the handler below would go on to call the DB
    // controller's `.set({})`, which throws — surfacing as a 500 in the real route.
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text.toLowerCase()).toContain("at least one");
  });

  it("rejects a body of only unrecognized fields with 400, not 500", async () => {
    const response = await putBody({ notAField: "x", alsoNotAField: 1 });

    // z.object() strips unknown keys by default, so this body is equivalent to {} once
    // parsed — it must be refused the same way, not silently accepted as "no changes".
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text.toLowerCase()).toContain("at least one");
  });

  it("accepts a visibility-only body (isPublic alone)", async () => {
    const response = await putBody({ isPublic: true });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { received: unknown };
    expect(payload.received).toEqual({ isPublic: true });
  });

  it("accepts a general-only body (name alone), the general.tsx shape", async () => {
    const response = await putBody({ name: "New name" });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { received: unknown };
    expect(payload.received).toEqual({ name: "New name" });
  });
});
