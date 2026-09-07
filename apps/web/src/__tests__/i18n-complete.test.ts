import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Operon fork check (spec R13, task B10).
 *
 * Two conditions, either of which fails this suite:
 *
 *  1. No user-visible "Kaneo" string survives in the locale files. Initiative is
 *     Operon's project module and must not name the upstream product anywhere a
 *     user can read it.
 *  2. Every key in `en-US.json` — the source of truth named by the fork's own
 *     AGENTS.md — exists in every other locale, so a rebranded string cannot
 *     reach English and miss the eighteen translations.
 *
 * See `docs/fork-discipline.md` in the Operon repository for why this check lives
 * in the fork rather than in Operon.
 */

const I18N_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../i18n",
);
const SOURCE_LOCALE = "en-US.json";

/**
 * "Kaneo" occurrences that are technical identifiers rather than the product
 * name. Rebranding these would make the copy describe something that does not
 * exist: `X-Kaneo-Signature` is the header the fork's own webhook client and
 * notification delivery actually emit (`apps/api/src/plugins/generic-webhook/client.ts`,
 * `apps/api/src/notification-preferences/delivery.ts`), and the example webhook
 * URLs are URLs, not prose.
 */
const TECHNICAL_IDENTIFIERS: RegExp[] = [
  /X-Kaneo-Signature/g,
  /https?:\/\/\S*kaneo\S*/gi,
];

/**
 * i18next resolves a plural form per language, so a language with a single
 * plural category legitimately has no `_one` entry. Parity is therefore asserted
 * over the plural *family*, not the individual suffixed key.
 */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/**
 * Keys upstream ships in `en-US.json` and in no other locale at the fork point
 * (`v2.23.1`, 2026-09-06). They are upstream's translation debt, not Operon's:
 * the fork deliberately does not machine-fill them, because writing English into
 * `ru-RU.json` would claim a translation that does not exist while i18next
 * already falls back to `en-US` at runtime.
 *
 * The assertion below is a subset check against this frozen list, so upstream
 * translating one of them passes and any NEW divergence — including every key
 * this fork rebrands — fails.
 */
const UPSTREAM_UNTRANSLATED_AT_FORK_POINT = new Set([
  "settings.mattermostIntegration.channelHint",
  "settings.mattermostIntegration.channelLabel",
  "settings.mattermostIntegration.channelPlaceholder",
  "settings.mattermostIntegration.connect",
  "settings.mattermostIntegration.connected",
  "settings.mattermostIntegration.connectionHint",
  "settings.mattermostIntegration.connectionTitle",
  "settings.mattermostIntegration.disconnect",
  "settings.mattermostIntegration.events.taskCommentCreated",
  "settings.mattermostIntegration.events.taskCreated",
  "settings.mattermostIntegration.events.taskDescriptionChanged",
  "settings.mattermostIntegration.events.taskPriorityChanged",
  "settings.mattermostIntegration.events.taskStatusChanged",
  "settings.mattermostIntegration.events.taskTitleChanged",
  "settings.mattermostIntegration.eventsHint",
  "settings.mattermostIntegration.eventsTitle",
  "settings.mattermostIntegration.paused",
  "settings.mattermostIntegration.saveChanges",
  "settings.mattermostIntegration.toast.disabled",
  "settings.mattermostIntegration.toast.enabled",
  "settings.mattermostIntegration.toast.removeError",
  "settings.mattermostIntegration.toast.removed",
  "settings.mattermostIntegration.toast.saveError",
  "settings.mattermostIntegration.toast.saved",
  "settings.mattermostIntegration.toast.updateError",
  "settings.mattermostIntegration.update",
  "settings.mattermostIntegration.validation.webhookInvalid",
  "settings.mattermostIntegration.webhookHint",
  "settings.mattermostIntegration.webhookLabel",
  "settings.mattermostIntegration.webhookPlaceholder",
  "settings.projectIntegrations.mattermostSectionSubtitle",
  "settings.projectIntegrations.mattermostSectionTitle",
]);

type Bundle = Record<string, unknown>;

function localeFiles(): string[] {
  return readdirSync(I18N_DIR)
    .filter((file) => file.endsWith(".json") && file !== "schema.json")
    .sort();
}

function load(file: string): Bundle {
  return JSON.parse(readFileSync(path.join(I18N_DIR, file), "utf8")) as Bundle;
}

function flatten(bundle: Bundle): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: Bundle, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      const dotted = prefix ? `${prefix}.${key}` : key;
      if (typeof value === "string") {
        out.set(dotted, value);
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        walk(value as Bundle, dotted);
      }
    }
  };
  walk(bundle, "");
  return out;
}

/** The key with any i18next plural suffix removed — its plural family. */
function pluralFamily(key: string): string {
  return key.replace(PLURAL_SUFFIX, "");
}

function stripTechnicalIdentifiers(value: string): string {
  let stripped = value;
  for (const pattern of TECHNICAL_IDENTIFIERS) {
    stripped = stripped.replace(pattern, "");
  }
  return stripped;
}

const files = localeFiles();
const source = flatten(load(SOURCE_LOCALE));
const others = files.filter((file) => file !== SOURCE_LOCALE);

describe("i18n locale bundles", () => {
  it("finds the source locale and its eighteen translations", () => {
    expect(files).toContain(SOURCE_LOCALE);
    expect(others.length).toBeGreaterThan(0);
    expect(source.size).toBeGreaterThan(1000);
  });

  it("keeps no user-visible Kaneo string in any locale (R13)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const [key, value] of flatten(load(file))) {
        if (/kaneo/i.test(stripTechnicalIdentifiers(value))) {
          offenders.push(`${file} :: ${key} = ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("carries every en-US key into every other locale (R13)", () => {
    // A locale's own plural categories decide which suffixed members exist, so
    // parity is asserted over the family: the locale must translate the string,
    // not necessarily under the same suffix English uses.
    const familiesBySource = new Set(
      [...source.keys()].map((key) => pluralFamily(key)),
    );
    const undeclaredGaps: string[] = [];

    for (const file of others) {
      const families = new Set(
        [...flatten(load(file)).keys()].map((key) => pluralFamily(key)),
      );
      for (const family of familiesBySource) {
        if (families.has(family)) continue;
        if (UPSTREAM_UNTRANSLATED_AT_FORK_POINT.has(family)) continue;
        undeclaredGaps.push(`${file} :: ${family}`);
      }
    }

    expect(undeclaredGaps).toEqual([]);
  });

  it("carries every rebranded key into every other locale with no exemption", () => {
    // The frozen upstream-gap list above must never be able to hide a key this
    // fork renamed, so the branded keys are asserted separately without it.
    const branded = [...source.entries()]
      .filter(([, value]) => value.includes("Initiative"))
      .map(([key]) => pluralFamily(key));
    expect(branded.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const file of others) {
      const families = new Set(
        [...flatten(load(file)).keys()].map((key) => pluralFamily(key)),
      );
      for (const key of branded) {
        if (!families.has(key)) missing.push(`${file} :: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("renames only values, never keys — breadcrumbKaneo still resolves", () => {
    // The key names are upstream's API. B10 changes what a string says, not what
    // it is called, so this key must still exist and must now read INITIATIVE.
    expect(source.get("common.modals.createWorkspace.breadcrumbKaneo")).toBe(
      "INITIATIVE",
    );
    expect(source.get("common.appName")).toBe("Initiative");
  });
});
