import { z } from "../openapi";

export const taskIdParam = z.object({ taskId: z.string() });

/**
 * Operon fork addition (spec R15, decision 31, task B12): the body of the
 * `POST /api/external-link` write route.
 *
 * `taskId` is read by `workspaceAccess.fromTaskId("taskId")` BEFORE this parses,
 * straight off the raw JSON body, which is why the key name is load-bearing and why
 * the middleware and the handler must read the id from the same place — see the
 * comment on the `lookup` source in `utils/workspace-access-middleware.ts`.
 */
export const createExternalLinkBody = z.object({
  taskId: z.string().min(1),
  integrationId: z.string().min(1),
  resourceType: z.string().min(1).max(64),
  externalId: z.string().min(1).max(256),
  // http/https only. This value is rendered straight into an `<a href>` by
  // `apps/web/src/components/external-links/external-links-accordion.tsx`, and every
  // upstream writer of this column is server-side plugin code fed by a provider API.
  // This route is the first one a workspace MEMBER can reach, so the scheme is
  // checked here rather than trusted.
  url: z
    .string()
    .url()
    .refine(
      (value) => {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      },
      { message: "url must use http or https" },
    ),
  title: z.string().max(512).nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

export type CreateExternalLinkBody = z.infer<typeof createExternalLinkBody>;
