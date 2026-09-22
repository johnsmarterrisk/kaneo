import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const placeholderPattern = "[`\\\"']KANEO_TURNSTILE_SITE_KEY[`\\\"']";
const turnstilePlaceholder = "KANEO_TURNSTILE_SITE_KEY";

const ENV_SH_PATH = resolve(import.meta.dirname, "../env.sh");
const ENV_SH = readFileSync(ENV_SH_PATH, "utf8");

/** Extracts the literal `CONFIG_ALLOWLIST_INPUT=$( ... )` / `CONFIG_HASH=$(...)` shell
    text out of the real `env.sh` and runs it against a controlled env — exercising the
    ACTUAL script rather than a hand copy that could drift from it (Stage 1 round-1
    finding 18). */
function extractConfigHashScript(): string {
  const start = ENV_SH.indexOf("CONFIG_ALLOWLIST_INPUT=$(");
  // This is literal SHELL text (env.sh's own `${CONFIG_ALLOWLIST_INPUT}`), not a JS
  // template literal placeholder.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: see comment above
  const marker = "CONFIG_HASH=$(printf '%s' \"${CONFIG_ALLOWLIST_INPUT}\"";
  const end = ENV_SH.indexOf("\n", ENV_SH.indexOf(marker));
  if (start === -1 || end === -1) {
    throw new Error("could not locate the CONFIG_HASH block in env.sh");
  }
  return ENV_SH.slice(start, end);
}

function computeConfigHash(env: Record<string, string>): string {
  const script = `${extractConfigHashScript()}\nprintf '%s' "$CONFIG_HASH"`;
  return execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
}

describe("runtime environment replacement", () => {
  it("strips unset placeholders regardless of the quote emitted by the bundler", () => {
    const bundle = [
      `const doubleQuoted = "${turnstilePlaceholder}";`,
      `const singleQuoted = '${turnstilePlaceholder}';`,
      `const templateLiteral = \`${turnstilePlaceholder}\`;`,
      `const required = "KANEO_API_URL";`,
      `const configured = "https://example.com";`,
    ].join("\n");

    const result = execFileSync("sed", ["-E", `s#${placeholderPattern}#""#g`], {
      input: bundle,
      encoding: "utf8",
    });

    expect(result).not.toContain("KANEO_TURNSTILE_SITE_KEY");
    expect(result).toContain(`const required = "KANEO_API_URL";`);
    expect(result).toContain(`const doubleQuoted = "";`);
    expect(result).toContain(`const singleQuoted = "";`);
    expect(result).toContain(`const templateLiteral = "";`);
    expect(result).toContain(`const configured = "https://example.com";`);
  });

  it("uses the quote-agnostic pattern in the container entrypoint", () => {
    const entrypoint = readFileSync(
      resolve(import.meta.dirname, "../env.sh"),
      "utf8",
    );

    expect(entrypoint).toContain(
      `sed -i -E 's#[\`"'"'"']KANEO_TURNSTILE_SITE_KEY[\`"'"'"']#""#g' {} +`,
    );
  });
});

describe("source maps are never served (Stage 1 round-1 finding 17)", () => {
  it("nginx.kaneo.conf refuses a direct .map request before the SPA fallback catches it", () => {
    const conf = readFileSync(
      resolve(import.meta.dirname, "../nginx.kaneo.conf"),
      "utf8",
    );
    const mapLocationIndex = conf.indexOf("location ~* \\.map$");
    const rootLocationIndex = conf.indexOf("location / {");
    expect(mapLocationIndex).toBeGreaterThan(-1);
    expect(rootLocationIndex).toBeGreaterThan(-1);
    // A regex location is matched before a prefix location by nginx regardless of
    // declaration order, but keeping it textually first too is what the paired
    // Operon-side test (`cache-freshness-headers.test.mjs`) and this file both assert.
    expect(mapLocationIndex).toBeLessThan(rootLocationIndex);
    expect(conf.slice(mapLocationIndex, mapLocationIndex + 60)).toContain(
      "return 404;",
    );
  });
});

describe("config_hash — a canonical allowlist, not just three URLs (Stage 1 finding 18)", () => {
  it("changing OPERON_APEX_URL still changes the hash (the original behaviour, preserved)", () => {
    const base = { OPERON_APEX_URL: "https://a.example" };
    const changed = { OPERON_APEX_URL: "https://b.example" };
    expect(computeConfigHash(base)).not.toBe(computeConfigHash(changed));
  });

  it("changing a KANEO_*-prefixed value the generic substitution loop ALSO replaces changes the hash — the regression this finding closes", () => {
    const base = {
      OPERON_APEX_URL: "https://a.example",
      KANEO_TURNSTILE_SITE_KEY: "site-key-one",
    };
    const changed = {
      OPERON_APEX_URL: "https://a.example",
      KANEO_TURNSTILE_SITE_KEY: "site-key-two",
    };
    // The ORIGINAL three-value formula (KANEO_API_URL/KANEO_CLIENT_URL/OPERON_APEX_URL
    // only) would have hashed these two envs identically, since neither of the varying
    // keys was in that fixed set.
    expect(computeConfigHash(base)).not.toBe(computeConfigHash(changed));
  });

  it("an unset vs a set-but-empty KANEO_* value are NOT confused with each other", () => {
    const unset = { OPERON_APEX_URL: "https://a.example" };
    const setEmpty = {
      OPERON_APEX_URL: "https://a.example",
      KANEO_TURNSTILE_SITE_KEY: "",
    };
    expect(computeConfigHash(unset)).not.toBe(computeConfigHash(setEmpty));
  });

  it("is deterministic and independent of env var insertion order", () => {
    const orderA = {
      OPERON_APEX_URL: "https://a.example",
      KANEO_A: "1",
      KANEO_B: "2",
    };
    const orderB = {
      KANEO_B: "2",
      OPERON_APEX_URL: "https://a.example",
      KANEO_A: "1",
    };
    expect(computeConfigHash(orderA)).toBe(computeConfigHash(orderB));
  });

  it("is a 64-character hex sha256 digest", () => {
    const hash = computeConfigHash({ OPERON_APEX_URL: "https://a.example" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("embedded loaded-version identity (Stage 1 finding 4)", () => {
  it("declares the build-time placeholder define in vite.config.ts", () => {
    const viteConfig = readFileSync(
      resolve(import.meta.dirname, "../vite.config.ts"),
      "utf8",
    );
    expect(viteConfig).toContain("__KANEO_LOADED_VERSION_JSON__");
    expect(viteConfig).toContain("KANEO_LOADED_VERSION_JSON_PLACEHOLDER");
  });

  it("env.sh writes the SAME payload to version.json and prepares it for the bundle, from the SAME five variables", () => {
    expect(ENV_SH).toContain("LOADED_VERSION_JSON=$(printf");
    expect(ENV_SH).toContain("KANEO_LOADED_VERSION_JSON_PLACEHOLDER");
    const heredocStart =
      ENV_SH.indexOf("<<VERSIONJSON\n") + "<<VERSIONJSON\n".length;
    const versionJsonBlock = ENV_SH.slice(
      heredocStart,
      ENV_SH.indexOf("\nVERSIONJSON\n", heredocStart),
    );
    for (const name of [
      "VERSION_RELEASE",
      "VERSION_OPERON_SHA",
      "VERSION_FORK_SHA",
      "CONFIG_HASH",
      "BUILT_AT",
    ]) {
      expect(versionJsonBlock).toContain(`\${${name}}`);
      expect(ENV_SH).toContain(`"\${${name}}"`);
    }
  });

  /** Extracts the REAL `case "...five vars..." in *[!SAFE-CHARS]*) ... esac` guard's
      pattern line out of env.sh, and runs it standalone — proving the actual character
      class env.sh checks against, not a hand copy that could drift from it. Unlike the
      version tried first (escaping the payload for sed), which `sed`'s own replacement-
      text escaping rules made actively wrong (most `sed`s consume a `\` before `"` or
      `\` in the replacement, so an "escaped" quote arrived BARE — see the removed test
      this replaced), a value that cannot contain `"`/`\`/`#` in the first place needs no
      escaping, so the guard IS the whole safety mechanism here. */
  function isAcceptedByRealGuard(combined: string): boolean {
    const guardLine = "*[!A-Za-z0-9._:-]*)";
    expect(ENV_SH).toContain(guardLine); // fails loudly if env.sh's pattern ever changes
    const script = `case "$1" in\n  ${guardLine} echo UNSAFE ;;\n  *) echo SAFE ;;\nesac`;
    const result = execFileSync("sh", ["-c", script, "sh", combined], {
      encoding: "utf8",
    });
    return result.trim() === "SAFE";
  }

  it("accepts realistically-shaped values (release id, hex SHAs, hex hash, ISO-8601 timestamp)", () => {
    const combined =
      "2026.09.22-4" +
      "a".repeat(40) +
      "b".repeat(40) +
      "c".repeat(64) +
      "2026-09-22T12:00:00.000Z";
    expect(isAcceptedByRealGuard(combined)).toBe(true);
  });

  it("accepts the dev-fallback release id shape (dev-<sha7>) and the 'unknown' fallback", () => {
    expect(
      isAcceptedByRealGuard(
        "dev-a1b2c3dunknownunknownunknown2026-09-22T00:00:00.000Z",
      ),
    ).toBe(true);
  });

  it("REJECTS a value carrying a double quote — exactly what would break out of the JS string literal", () => {
    expect(isAcceptedByRealGuard('2026.09.22-4"; alert(1); "')).toBe(false);
  });

  it("REJECTS a value carrying a backslash", () => {
    expect(isAcceptedByRealGuard("2026.09.22-4\\backslash")).toBe(false);
  });

  it("REJECTS a value carrying the sed delimiter `#`", () => {
    expect(isAcceptedByRealGuard("2026.09.22-4#injected")).toBe(false);
  });
});
