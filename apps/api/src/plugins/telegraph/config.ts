import * as v from "valibot";

/**
 * The `telegraph` integration type — an Operon fork addition (spec R15, decision 31,
 * task B12).
 *
 * WHAT IT IS FOR
 * Operon's Telegraph is the chat half of the same product Initiative is the project
 * half of. "Create task from message" needs somewhere to record which Nostr event a
 * task came from, and Kaneo already has exactly the right shape for that: an
 * `integration` row that an `external_link` row points at. So Telegraph becomes an
 * integration type beside `generic-webhook`, `github` and `gitea` rather than a new
 * column on `task`, which would be schema drift on a 45-migration upstream chain.
 *
 * WHY IT IS PER PROJECT AND CARRIES NO SECRET
 * `integrationTable` is keyed `UNIQUE (projectId, type)` and has no `workspaceId`
 * (`../../database/schema.ts`), so there is exactly one `telegraph` row per project;
 * Operon's provisioner (spec C19) creates them, no migration seeds them. Unlike every
 * other type here, the config holds **no credential**: Operon talks to Kaneo with an
 * API key held on the Operon side, and Telegraph deep links are public within the
 * instance. That matters because `external-link/index.ts` warns that
 * `integration.config` is plaintext — a `telegraph` row has nothing to leak.
 *
 * WHY THERE ARE NO EVENT HANDLERS
 * Every other plugin here pushes Kaneo task events outward. Telegraph needs none:
 * Operon's signal writer derives Telegraph-side activity from the relay it is already
 * subscribed to (spec R29), and Kaneo task activity reaches Operon through the
 * generic webhook C19 provisions alongside this row. A second outbound path would
 * duplicate every signal. The plugin therefore exists to NAME the type and validate
 * its config, which is what `registerPlugin` is for.
 */
export const TELEGRAPH_INTEGRATION_TYPE = "telegraph";

/**
 * The `resourceType` an Operon-written Telegraph link carries. A Telegraph link
 * points at one chat message, identified by the 64-hex id of the Nostr event that
 * carried it.
 */
export const TELEGRAPH_MESSAGE_RESOURCE_TYPE = "message";

export const telegraphConfigSchema = v.object({
  /**
   * Optional. The Operon apex origin this project's Telegraph lives on, recorded for
   * operators reading the row. It is NOT what renders the link: the web client reads
   * `OPERON_APEX_URL` from its own runtime configuration (`apps/web/env.sh`), because
   * the browser must not depend on a value written into a database row months ago.
   */
  apexUrl: v.optional(
    v.pipe(
      v.string(),
      v.url(),
      v.check((value) => {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      }, "Telegraph apex URL must use http or https"),
    ),
  ),
});

export type TelegraphConfig = v.InferOutput<typeof telegraphConfigSchema>;

export async function validateTelegraphConfig(
  config: unknown,
): Promise<{ valid: boolean; errors?: string[] }> {
  try {
    v.parse(telegraphConfigSchema, config);
    return { valid: true };
  } catch (error) {
    if (error instanceof v.ValiError) {
      return {
        valid: false,
        errors: error.issues.map((issue) => issue.message),
      };
    }

    return {
      valid: false,
      errors: [error instanceof Error ? error.message : "Invalid config"],
    };
  }
}
