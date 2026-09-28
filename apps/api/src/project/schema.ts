import { z } from "../openapi";

export const projectParam = z.object({ id: z.string() });

export const workspaceIdQuery = z.object({ workspaceId: z.string() });

export const listProjectsQuery = z.object({
  workspaceId: z.string(),
  includeArchived: z.string().optional().openapi({
    description: 'Pass "true" to include archived projects in the list.',
  }),
});

export const createProjectBody = z.object({
  name: z.string(),
  workspaceId: z.string(),
  icon: z.string(),
  slug: z.string(),
});

export const updateProjectBody = z
  .object({
    // All fields are optional: every settings page (General, Visibility) sends
    // only the fields it owns, so an update that omits a field must leave the
    // stored value untouched rather than defaulting or overwriting it (see
    // update-project.ts controller). This is the same pattern already used for
    // isPublic, extended to name/icon/slug/description so the Visibility save
    // can no longer overwrite a concurrent General edit and vice versa.
    name: z.string().optional(),
    icon: z.string().optional(),
    slug: z.string().optional(),
    description: z.string().optional(),
    isPublic: z.boolean().optional(),
  })
  // Every field being optional means an empty (or unknown-field-only) body would
  // otherwise pass validation and reach the controller, whose `.set({})` Drizzle
  // call throws "No values to set" — a 500, not a validation error. Refuse it here
  // instead, at the same 400-class the route already answers with for a bad field
  // (see apiRouter's defaultHook in ../openapi.ts), so it never reaches the DB.
  .refine(
    (body) =>
      body.name !== undefined ||
      body.icon !== undefined ||
      body.slug !== undefined ||
      body.description !== undefined ||
      body.isPublic !== undefined,
    {
      message:
        "At least one of name, icon, slug, description, isPublic is required",
    },
  );

export const reorderProjectsBody = z.object({
  // Positions express a relative order only; the controller renumbers the
  // workspace to 0..n-1, so the values just have to be sane.
  projects: z
    .array(z.object({ id: z.string(), position: z.number().int().min(0) }))
    .min(1),
});
