import { randomUUID } from "node:crypto";
import path from "node:path";
import babel from "@rolldown/plugin-babel";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import packageJson from "../../package.json";

const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
const sentryOrg = process.env.SENTRY_ORG;
const sentryProject = process.env.SENTRY_PROJECT;

// A build ID names the exact uploaded artifacts, independently of runtime deployment
// labels. The SDK and uploader receive the same ID from this config evaluation.
const sentryRelease = `initiative-${randomUUID().replaceAll("-", "")}`;
// Only these public browser settings may enter index.html. A VITE_* placeholder
// naming a server secret must never turn that secret into runtime page data.
const PUBLIC_RUNTIME_KEYS = new Set([
  "KANEO_API_URL",
  "KANEO_CLIENT_URL",
  "KANEO_SENTRY_DSN",
  "KANEO_TURNSTILE_SITE_KEY",
  "OPERON_APEX_URL",
]);

/** The runtime keys this build reads: every `.env` value that is a placeholder name. */
export function runtimeConfigKeys(env: Record<string, string>): string[] {
  return [
    ...new Set(Object.values(env).filter((v) => PUBLIC_RUNTIME_KEYS.has(v))),
  ].sort();
}

// Open-items 458 (Operon repo): runtime configuration is read from
// window.__OPERON_RUNTIME_CONFIG__, which env.sh writes into index.html (no-cache) at
// container start. It used to be fixed-width slots env.sh rewrote inside the hashed .js
// chunks, which changed a chunk's bytes under an unchanged URL; a CDN max-age then served
// old configuration under a new identity. The `?? name` fallback is the same
// "never substituted" placeholder value the client already checks for (vite preview,
// or no env.sh run). The loaded version identity lives in the sibling slot.
export function runtimeDefines(
  env: Record<string, string>,
): Record<string, string> {
  const definitions: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (PUBLIC_RUNTIME_KEYS.has(value)) {
      const name = JSON.stringify(value);
      definitions[`import.meta.env.${key}`] =
        `(globalThis.__OPERON_RUNTIME_CONFIG__?.[${name}] ?? ${name})`;
    }
  }
  return definitions;
}

/** Writes the key list into index.html's runtime-config slot so env.sh publishes exactly
    the keys the bundle reads, never every KANEO_* variable in the container. */
export function runtimeConfigSlot(keys: string[]): Plugin {
  const slot = '<script id="operon-runtime-config" data-keys="">';
  return {
    name: "operon-runtime-config-keys",
    apply: "build",
    transformIndexHtml(html) {
      if (!html.includes(slot))
        throw new Error("index.html has no runtime-config slot");
      return html.replace(
        slot,
        `<script id="operon-runtime-config" data-keys="${keys.join(",")}">`,
      );
    },
  };
}

export default defineConfig(({ mode, command }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __KANEO_SENTRY_RELEASE__: JSON.stringify(sentryRelease),
    ...(command === "build"
      ? runtimeDefines(loadEnv(mode, import.meta.dirname))
      : {}),
  },
  base: "/",
  plugins: [
    runtimeConfigSlot(runtimeConfigKeys(loadEnv(mode, import.meta.dirname))),
    tanstackRouter({
      autoCodeSplitting: true,
      // Keep co-located route tests out of the generated route tree.
      routeFileIgnorePattern: "\\.test\\.tsx?$",
    }),
    tailwindcss(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    // Hidden when Sentry env vars are absent so local dev does not depend on it.
    ...(sentryAuthToken && sentryOrg && sentryProject
      ? [
          sentryVitePlugin({
            authToken: sentryAuthToken,
            org: sentryOrg,
            project: sentryProject,
            release: { name: sentryRelease },
          }),
        ]
      : []),
  ],
  server: {
    host: true,
    hmr: true,
    port: 5173,
  },
  optimizeDeps: {
    exclude: ["better-auth"],
  },
  ssr: {
    noExternal: ["better-auth"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@i18n": path.resolve(__dirname, "../../i18n"),
    },
  },
  build: {
    // Source maps are required for the Sentry Vite plugin to upload and
    // symbolicate stack traces. Hidden so the .map files are not served
    // to end users; the Sentry plugin still attaches them to uploaded
    // releases.
    sourcemap: "hidden",
    rollupOptions: {},
    commonjsOptions: {
      include: [/better-auth/, /node_modules/],
      transformMixedEsModules: true,
    },
    target: "esnext",
  },
}));
