import { discordPlugin } from "./discord";
import { genericWebhookPlugin } from "./generic-webhook";
import { giteaPlugin } from "./gitea";
import { githubPlugin, initializeGitHubPlugin } from "./github";
import { mattermostPlugin } from "./mattermost";
import { initializeEventSubscriptions, registerPlugin } from "./registry";
import { slackPlugin } from "./slack";
import { telegramPlugin } from "./telegram";
import { telegraphPlugin } from "./telegraph";

export function initializePlugins() {
  console.log("Initializing plugins...");

  registerPlugin(githubPlugin);
  registerPlugin(giteaPlugin);
  registerPlugin(slackPlugin);
  registerPlugin(mattermostPlugin);
  registerPlugin(discordPlugin);
  registerPlugin(genericWebhookPlugin);
  registerPlugin(telegramPlugin);
  // Operon fork addition (spec R15, decision 31, task B12): names the `telegraph`
  // integration type and validates its config. It registers no event handlers on
  // purpose — see apps/api/src/plugins/telegraph/config.ts.
  registerPlugin(telegraphPlugin);
  initializeGitHubPlugin();
  initializeEventSubscriptions();

  console.log("✅ Plugins initialized");
}

export * from "./registry";
export * from "./types";
