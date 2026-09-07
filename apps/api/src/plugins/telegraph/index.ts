import type { IntegrationPlugin } from "../types";
import { TELEGRAPH_INTEGRATION_TYPE, validateTelegraphConfig } from "./config";

/**
 * Operon fork addition (spec R15, decision 31, task B12). See `./config.ts` for why
 * this type exists, why it is per project, and why it deliberately registers no task
 * event handlers.
 */
export const telegraphPlugin: IntegrationPlugin = {
  type: TELEGRAPH_INTEGRATION_TYPE,
  name: "Telegraph",
  validateConfig: validateTelegraphConfig,
};

export type { TelegraphConfig } from "./config";
export {
  TELEGRAPH_INTEGRATION_TYPE,
  TELEGRAPH_MESSAGE_RESOURCE_TYPE,
  telegraphConfigSchema,
  validateTelegraphConfig,
} from "./config";
