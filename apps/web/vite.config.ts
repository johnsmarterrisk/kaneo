import path from "node:path";
import babel from "@rolldown/plugin-babel";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import packageJson from "../../package.json";

const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
const sentryOrg = process.env.SENTRY_ORG;
const sentryProject = process.env.SENTRY_PROJECT;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    // Stage 1 round-1 finding 4: a literal placeholder baked into the bundle at BUILD
    // time, the same mechanism `KANEO_API_URL` etc. already use — `env.sh` substitutes the
    // real, computed `version.json` payload into this exact string at CONTAINER START (see
    // its own comment, and `src/lib/version-check.ts`'s `getLoadedVersion` for why this
    // document's own "loaded" identity must be baked into the bundle's bytes rather than
    // fetched from the same resource the freshness check fetches fresh).
    __KANEO_LOADED_VERSION_JSON__: JSON.stringify(
      "KANEO_LOADED_VERSION_JSON_PLACEHOLDER",
    ),
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
            release: { name: packageJson.version },
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
});
