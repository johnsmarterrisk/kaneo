import { randomUUID } from "node:crypto";
import path from "node:path";
import babel from "@rolldown/plugin-babel";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import packageJson from "../../package.json";

const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
const sentryOrg = process.env.SENTRY_ORG;
const sentryProject = process.env.SENTRY_PROJECT;

// A build ID names the exact uploaded artifacts, independently of runtime deployment
// labels. The SDK and uploader receive the same ID from this config evaluation.
const sentryRelease = `initiative-${randomUUID().replaceAll("-", "")}`;
const RUNTIME_SLOT_SIZE = 4096;

// JSON.parse prevents the minifier from folding a slot into a larger string or
// evaluating a configuration-dependent branch before runtime substitution.
export function runtimeDefines(
  env: Record<string, string>,
): Record<string, string> {
  const definitions: Record<string, string> = {
    __KANEO_LOADED_VERSION_JSON__: `JSON.parse(${JSON.stringify("KANEO_LOADED_VERSION_JSON_PLACEHOLDER".padEnd(RUNTIME_SLOT_SIZE))})`,
  };
  for (const [key, value] of Object.entries(env)) {
    if (/^(KANEO_[A-Z0-9_]+|OPERON_APEX_URL)$/.test(value)) {
      definitions[`import.meta.env.${key}`] =
        `JSON.parse(${JSON.stringify(value.padEnd(RUNTIME_SLOT_SIZE))})`;
    }
  }
  return definitions;
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
