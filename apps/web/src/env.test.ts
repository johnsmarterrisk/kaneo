// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { SourceMap } from "node:module";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import config, { runtimeDefines } from "../vite.config";
import { formatStamp } from "./lib/version-check";

const ENV_SH = readFileSync(resolve(import.meta.dirname, "../env.sh"), "utf8");
const ROOT = "/usr/share/nginx/html";
const NGINX = "/etc/nginx/conf.d/default.conf";
const identityEnv = {
  VERSION_RELEASE: "2026.09.22-4",
  VERSION_OPERON_SHA: "a".repeat(40),
  VERSION_FORK_SHA: "b".repeat(40),
};

// Execute the entire entrypoint with its real shell/heredoc and Node substitution.
// Only filesystem I/O is redirected to memory: the review fence forbids fixtures on disk.
function runEntrypoint(
  bundle: string,
  env: Record<string, string | undefined> = {},
) {
  const harness = `
    const fs = require('node:fs');
    const vm = require('node:vm');
    const files = JSON.parse(process.env.FIXTURE_FILES);
    const mockFs = {
      readdirSync: () => [{ name: 'probe.js', isDirectory: () => false }],
      readFileSync: path => files[path],
      writeFileSync: (path, value) => { files[path] = value; },
    };
    vm.runInNewContext(fs.readFileSync(0, 'utf8'), {
      require: id => id === 'node:fs' ? mockFs : require(id),
      process: { env: JSON.parse(process.env.FIXTURE_ENV) }, URL,
    });
    process.stdout.write(JSON.stringify(files));
  `;
  return JSON.parse(
    execFileSync(
      "sh",
      ["-c", `node() { command node -e "$HARNESS"; }\n${ENV_SH}`],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HARNESS: harness,
          FIXTURE_FILES: JSON.stringify({
            [`${ROOT}/probe.js`]: bundle,
            [NGINX]:
              "return 200 'MCP_PRM_JSON_PLACEHOLDER';\nreturn 200 'MCP_AS_JSON_PLACEHOLDER';",
          }),
          FIXTURE_ENV: JSON.stringify({ ...identityEnv, ...env }),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    ),
  ) as Record<string, string>;
}

const definitions = runtimeDefines({
  VITE_API_URL: "KANEO_API_URL",
  VITE_CLIENT_URL: "KANEO_CLIENT_URL",
  VITE_OPERON_APEX_URL: "OPERON_APEX_URL",
  VITE_TURNSTILE_SITE_KEY: "KANEO_TURNSTILE_SITE_KEY",
});

function identity(files: Record<string, string>) {
  return JSON.parse(files[`${ROOT}/version.json`]);
}

describe("runtime entrypoint", () => {
  it("evaluates the actual identity substitution as JS and matches version.json", () => {
    const bundle = `globalThis.identity = ${definitions.__KANEO_LOADED_VERSION_JSON__};`;
    const files = runEntrypoint(bundle);
    const context: { identity?: string } = {};
    new Script(files[`${ROOT}/probe.js`]).runInNewContext(context);
    expect(JSON.parse(context.identity ?? "null")).toEqual(identity(files));
    expect(identity(files).release).toBe("2026.09.22-4");
  });

  it("escapes quotes, backslashes, controls and Unicode without shifting any code", () => {
    const bundle = `globalThis.apex=${definitions["import.meta.env.VITE_OPERON_APEX_URL"]};globalThis.done=true;`;
    const apex = 'https://example.invalid/"quoted"\\path\n\u2028é';
    const files = runEntrypoint(bundle, { OPERON_APEX_URL: apex });
    const result = files[`${ROOT}/probe.js`];
    const context: { apex?: string; done?: boolean } = {};
    new Script(result).runInNewContext(context);
    expect(context).toEqual({ apex, done: true });
    expect(result.indexOf("globalThis.done")).toBe(
      bundle.indexOf("globalThis.done"),
    );
    expect(result.length).toBe(bundle.length);
    expect(result.split("\n")).toHaveLength(1);
  });

  it("preserves source-code placeholder comparisons and empties an unset optional key", () => {
    const bundle = `globalThis.site=${definitions["import.meta.env.VITE_TURNSTILE_SITE_KEY"]};globalThis.comparison="OPERON_APEX_URL";`;
    const files = runEntrypoint(bundle, {
      OPERON_APEX_URL: "https://example.invalid",
    });
    const context = {};
    new Script(files[`${ROOT}/probe.js`]).runInNewContext(context);
    expect(context).toEqual({ site: "", comparison: "OPERON_APEX_URL" });
  });

  it("fails before publishing an oversized value or malformed identity", () => {
    expect(() =>
      runEntrypoint(
        `globalThis.apex=${definitions["import.meta.env.VITE_OPERON_APEX_URL"]};`,
        {
          OPERON_APEX_URL: "x".repeat(5000),
        },
      ),
    ).toThrow();
    expect(() =>
      runEntrypoint("", { VERSION_RELEASE: 'bad"release' }),
    ).toThrow();
  });

  it("versioning v1: accepts the new vMAJOR.MINOR release shape", () => {
    const files = runEntrypoint("", { VERSION_RELEASE: "v1.0" });
    expect(identity(files).release).toBe("v1.0");
  });

  it("versioning v1: still accepts the old YYYY.MM.DD-N shape (historical releases)", () => {
    const files = runEntrypoint("", { VERSION_RELEASE: "2026.09.22-8" });
    expect(identity(files).release).toBe("2026.09.22-8");
  });

  it("versioning v1: the retired dev-<sha> fallback shape is no longer accepted", () => {
    expect(() =>
      runEntrypoint("", { VERSION_RELEASE: "dev-a1b2c3d" }),
    ).toThrow();
  });

  it("versioning v1: VERSION_RELEASE genuinely ABSENT (not merely empty) resolves to unknown/dev, never throwing — Codex round 1 finding 13", () => {
    // `undefined` here — not `""` — so JSON.stringify drops the key entirely from
    // FIXTURE_ENV: every other test in this file overrides VERSION_RELEASE, but the shared
    // `identityEnv` fixture still SUPPLIES one, which is exactly the gap finding 13 named.
    // This is the actual local `docker compose build initiative` shape open-items row 75
    // fixed the RENDERING of: no `VERSION_RELEASE` in the container's environment at all.
    const files = runEntrypoint("", { VERSION_RELEASE: undefined });
    expect(identity(files).release).toBe("unknown");
    expect(formatStamp(identity(files))).toBe("dev");
  });

  it("hashes all substituted configuration deterministically, distinguishing absent and empty", () => {
    const hash = (env: Record<string, string>) =>
      identity(runEntrypoint("", env)).config_hash;
    expect(hash({ KANEO_A: "1", KANEO_B: "2" })).toBe(
      hash({ KANEO_B: "2", KANEO_A: "1" }),
    );
    expect(hash({ OPERON_APEX_URL: "https://a.invalid" })).not.toBe(
      hash({ OPERON_APEX_URL: "https://b.invalid" }),
    );
    expect(hash({ KANEO_TURNSTILE_SITE_KEY: "one" })).not.toBe(
      hash({ KANEO_TURNSTILE_SITE_KEY: "two" }),
    );
    expect(hash({})).not.toBe(hash({ KANEO_A: "" }));
    expect(hash({})).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still writes OAuth discovery metadata and empties it when API URL is absent", () => {
    const configured = runEntrypoint("", {
      KANEO_API_URL: "https://api.example.invalid/api",
    });
    expect(configured[NGINX]).toContain(
      '"resource":"https://api.example.invalid/api/mcp"',
    );
    expect(configured[NGINX]).toContain(
      '"token_endpoint":"https://api.example.invalid/api/mcp/token"',
    );
    expect(runEntrypoint("")[NGINX]).toBe("return 200 '{}';\nreturn 200 '{}';");
  });
});

it("keeps real Vite source-map positions valid after every runtime substitution", async () => {
  const source = [
    "globalThis.api = import.meta.env.VITE_API_URL;",
    "globalThis.apex = import.meta.env.VITE_OPERON_APEX_URL;",
    "globalThis.identity = __KANEO_LOADED_VERSION_JSON__;",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: input source for Vite
    "globalThis.callback = `${import.meta.env.VITE_CLIENT_URL}/auth/sign-in`;",
    'throw new Error("mapping probe");',
  ].join("\n");
  const result = await build({
    configFile: false,
    logLevel: "silent",
    define: definitions,
    plugins: [
      {
        name: "memory-entry",
        resolveId: (id) =>
          id.endsWith("runtime-proof") ? "/runtime-proof.js" : null,
        load: (id) => (id === "/runtime-proof.js" ? source : null),
      },
    ],
    build: {
      write: false,
      sourcemap: "hidden",
      minify: true,
      lib: { entry: "runtime-proof", formats: ["es"] },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!("output" in output)) throw new Error("Expected bundled output");
  const chunk = output.output.find((entry) => entry.type === "chunk");
  if (!chunk?.map) throw new Error("Missing source map");
  const replaced = runEntrypoint(chunk.code, {
    KANEO_API_URL: "https://api.example.invalid/api",
    KANEO_CLIENT_URL: "https://initiative.example.invalid",
    OPERON_APEX_URL: "https://operon.example.invalid",
  })[`${ROOT}/probe.js`];
  expect(replaced).toHaveLength(chunk.code.length);
  const context: { api?: string; apex?: string; callback?: string } = {};
  let stack = "";
  try {
    new Script(replaced, { filename: "probe.js" }).runInNewContext(context);
  } catch (error) {
    stack = String((error as Error).stack);
  }
  const location = stack.match(/at probe\.js:(\d+):(\d+)/);
  expect(location).not.toBeNull();
  const map = new SourceMap(JSON.parse(chunk.map.toString()));
  const original = map.findEntry(
    Number(location?.[1]) - 1,
    Number(location?.[2]) - 1,
  );
  expect("originalLine" in original && original.originalLine).toBe(4);
  expect(context.callback).toBe(
    "https://initiative.example.invalid/auth/sign-in",
  );
  expect(context.api).toBe("https://api.example.invalid/api");
  expect(context.apex).toBe("https://operon.example.invalid");
}, 30_000);

it("uses one immutable build ID in the emitted SDK constant and source-map uploader", async () => {
  const resolved =
    typeof config === "function"
      ? await config({ command: "build", mode: "production" })
      : config;
  expect(JSON.parse(resolved.define?.__KANEO_SENTRY_RELEASE__ ?? '""')).toMatch(
    /^initiative-[0-9a-f]{32}$/,
  );
  const text = readFileSync(
    resolve(import.meta.dirname, "../vite.config.ts"),
    "utf8",
  );
  expect(text).toContain("release: { name: sentryRelease }");
});

it("never serves source maps through nginx", () => {
  const text = readFileSync(
    resolve(import.meta.dirname, "../nginx.kaneo.conf"),
    "utf8",
  );
  const location = text.indexOf("location ~* \\.map$");
  expect(location).toBeGreaterThan(-1);
  expect(text.slice(location, location + 60)).toContain("return 404;");
});
