// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { build, loadEnv } from "vite";
import { describe, expect, it } from "vitest";
import config, {
  runtimeConfigKeys,
  runtimeConfigSlot,
  runtimeDefines,
} from "../vite.config";
import { formatStamp } from "./lib/version-check";

const ENV_SH = readFileSync(resolve(import.meta.dirname, "../env.sh"), "utf8");
// The real source index.html, with the key list vite's build writes into its
// runtime-config slot (runtimeConfigSlot over .env.production's placeholder keys).
const BUILT_INDEX_HTML = readFileSync(
  resolve(import.meta.dirname, "../index.html"),
  "utf8",
).replace(
  'data-keys=""',
  `data-keys="${runtimeConfigKeys(loadEnv("production", resolve(import.meta.dirname, ".."))).join(",")}"`,
);
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
  html: string = BUILT_INDEX_HTML,
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
            [`${ROOT}/index.html`]: html,
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

const SLOTS =
  /<script id="operon-(?:loaded-version|runtime-config)"[^>]*>[\s\S]*?<\/script>/g;

/** Runs the two index.html slots env.sh wrote, the way the browser does, and returns
    what they leave on `window`. */
function pageGlobals(files: Record<string, string>) {
  const window: {
    __OPERON_LOADED_VERSION__?: unknown;
    __OPERON_RUNTIME_CONFIG__?: Record<string, string> | null;
  } = {};
  for (const [element] of files[`${ROOT}/index.html`].matchAll(SLOTS)) {
    const body = element
      .replace(/^<script[^>]*>/, "")
      .replace(/<\/script>$/, "");
    new Script(body).runInNewContext({ window });
  }
  return window;
}

describe("runtime entrypoint", () => {
  it("writes the identity into index.html's slot, matching version.json (open-items 458)", () => {
    const files = runEntrypoint("");
    expect(pageGlobals(files).__OPERON_LOADED_VERSION__).toEqual(
      identity(files),
    );
    expect(identity(files).release).toBe("2026.09.22-4");
    // Everything outside the two slots is byte-for-byte the built document.
    expect(files[`${ROOT}/index.html`].replace(SLOTS, "")).toBe(
      BUILT_INDEX_HTML.replace(SLOTS, ""),
    );
  });

  it("is idempotent across container restarts and fails loud without either slot", () => {
    const once = runEntrypoint("", { KANEO_API_URL: "https://a.invalid/api" })[
      `${ROOT}/index.html`
    ];
    const twice = runEntrypoint("", {}, once)[`${ROOT}/index.html`];
    expect(twice.match(/operon-loaded-version/g)).toHaveLength(1);
    expect(twice.match(/operon-runtime-config/g)).toHaveLength(1);
    expect(
      pageGlobals({ [`${ROOT}/index.html`]: twice }).__OPERON_RUNTIME_CONFIG__,
    ).toMatchObject({ KANEO_API_URL: "KANEO_API_URL" });
    const withoutVersion = BUILT_INDEX_HTML.replace(
      /<script id="operon-loaded-version">[\s\S]*?<\/script>/,
      "",
    );
    const withoutConfig = BUILT_INDEX_HTML.replace(
      /<script id="operon-runtime-config"[\s\S]*?<\/script>/,
      "",
    );
    expect(() => runEntrypoint("", {}, withoutVersion)).toThrow();
    expect(() => runEntrypoint("", {}, withoutConfig)).toThrow();
  });

  it("writes runtime config into index.html, escaped, so no value can end the script", () => {
    const apex =
      'https://example.invalid/"quoted"\\path\n\u2028é</script><script>alert(1)</script>';
    const files = runEntrypoint("", {
      OPERON_APEX_URL: apex,
      KANEO_API_URL: "https://api.example.invalid/api",
    });
    const html = files[`${ROOT}/index.html`];
    expect(html).not.toContain("<script>alert(1)");
    expect(html.match(/<\/script>/g)).toHaveLength(
      BUILT_INDEX_HTML.match(/<\/script>/g)?.length ?? -1,
    );
    expect(pageGlobals(files).__OPERON_RUNTIME_CONFIG__).toMatchObject({
      OPERON_APEX_URL: apex,
      KANEO_API_URL: "https://api.example.invalid/api",
    });
  });

  it("publishes only the bundle's keys, keeps unset ones as their names, empties Turnstile", () => {
    const files = runEntrypoint("", {
      KANEO_CLIENT_URL: "",
      KANEO_SECRET_NOT_READ_BY_THE_BUNDLE: "secret",
    });
    expect(pageGlobals(files).__OPERON_RUNTIME_CONFIG__).toEqual({
      KANEO_API_URL: "KANEO_API_URL",
      KANEO_CLIENT_URL: "KANEO_CLIENT_URL",
      KANEO_SENTRY_DSN: "KANEO_SENTRY_DSN",
      KANEO_TURNSTILE_SITE_KEY: "",
      OPERON_APEX_URL: "OPERON_APEX_URL",
    });
    expect(files[`${ROOT}/index.html`]).not.toContain("secret");
  });

  it("never rewrites a .js chunk", () => {
    const bundle = `globalThis.apex=${definitions["import.meta.env.VITE_OPERON_APEX_URL"]};`;
    const files = runEntrypoint(bundle, {
      OPERON_APEX_URL: "https://x.invalid",
    });
    expect(files[`${ROOT}/probe.js`]).toBe(bundle);
  });

  it("fails before publishing a malformed identity or key list", () => {
    expect(() =>
      runEntrypoint("", { VERSION_RELEASE: 'bad"release' }),
    ).toThrow();
    expect(() =>
      runEntrypoint(
        "",
        {},
        BUILT_INDEX_HTML.replace(/data-keys="[^"]*"/, 'data-keys="PATH"'),
      ),
    ).toThrow();
  });

  it("versioning v1: accepts the new vMAJOR.MINOR release shape", () => {
    const files = runEntrypoint("", { VERSION_RELEASE: "v1.0" });
    expect(identity(files).release).toBe("v1.0");
  });

  it("versioning v1: rejects non-canonical zero-major and leading-zero variants", () => {
    for (const release of ["v0.0", "v0.1", "v01.0", "v1.01"]) {
      expect(() => runEntrypoint("", { VERSION_RELEASE: release })).toThrow();
    }
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

it("one built chunk, never rewritten, runs whichever config index.html carries (open-items 458)", async () => {
  // The stale-cache case: a browser that kept the previous deployment's chunk bytes
  // still runs the CURRENT configuration, because the chunk bytes never vary and the
  // config arrives in the no-cache document.
  const source = [
    "globalThis.api = import.meta.env.VITE_API_URL;",
    "globalThis.apex = import.meta.env.VITE_OPERON_APEX_URL;",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: input source for Vite
    "globalThis.callback = `${import.meta.env.VITE_CLIENT_URL}/auth/sign-in`;",
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
      minify: true,
      lib: { entry: "runtime-proof", formats: ["es"] },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!("output" in output)) throw new Error("Expected bundled output");
  const chunk = output.output.find((entry) => entry.type === "chunk");
  if (!chunk) throw new Error("Missing chunk");

  const run = (env: Record<string, string>) => {
    const files = runEntrypoint(chunk.code, env);
    expect(files[`${ROOT}/probe.js`]).toBe(chunk.code);
    const context: Record<string, unknown> = {
      __OPERON_RUNTIME_CONFIG__: pageGlobals(files).__OPERON_RUNTIME_CONFIG__,
    };
    new Script(chunk.code).runInNewContext(context);
    return { context, hash: identity(files).config_hash };
  };
  const first = run({
    KANEO_API_URL: "https://api.one.invalid/api",
    KANEO_CLIENT_URL: "https://initiative.one.invalid",
    OPERON_APEX_URL: "https://operon.one.invalid",
  });
  const second = run({
    KANEO_API_URL: "https://api.two.invalid/api",
    KANEO_CLIENT_URL: "https://initiative.two.invalid",
    OPERON_APEX_URL: "https://operon.two.invalid",
  });
  expect(first.context).toMatchObject({
    api: "https://api.one.invalid/api",
    apex: "https://operon.one.invalid",
    callback: "https://initiative.one.invalid/auth/sign-in",
  });
  expect(second.context).toMatchObject({
    api: "https://api.two.invalid/api",
    callback: "https://initiative.two.invalid/auth/sign-in",
  });
  // A config-only change still changes the version key.
  expect(first.hash).not.toBe(second.hash);

  // No env.sh run (vite preview): the placeholder names, as before.
  const bare: Record<string, unknown> = {};
  new Script(chunk.code).runInNewContext(bare);
  expect(bare).toMatchObject({ api: "KANEO_API_URL", apex: "OPERON_APEX_URL" });
}, 30_000);

it("the build writes the bundle's key list into the runtime-config slot", () => {
  const plugin = runtimeConfigSlot(["KANEO_API_URL", "OPERON_APEX_URL"]);
  const transform = plugin.transformIndexHtml as (html: string) => string;
  const source = readFileSync(
    resolve(import.meta.dirname, "../index.html"),
    "utf8",
  );
  expect(transform(source)).toContain(
    '<script id="operon-runtime-config" data-keys="KANEO_API_URL,OPERON_APEX_URL">',
  );
  expect(() => transform("<html></html>")).toThrow();
  expect(
    runtimeConfigKeys({ A: "KANEO_X", B: "plain", C: "OPERON_APEX_URL" }),
  ).toEqual(["KANEO_X", "OPERON_APEX_URL"]);
});

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
