// @vitest-environment node

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Operon fork check (spec R14, task B11) — the apex placeholder, in the artefact that
 * actually ships.
 *
 * NODE, NOT JSDOM. esbuild refuses to run under jsdom's `TextEncoder`, and this suite
 * compiles the real component, so it declares its own environment. It renders nothing;
 * only `apexUrl` is called.
 *
 * See `docs/fork-discipline.md` in the Operon repository for why this check lives in
 * the fork rather than in Operon.
 */

const DEV_APEX_URL = "https://operon.lvh.me:8443";

describe("apexUrl in the COMPILED bundle, after env.sh's substitution", () => {
  /**
   * The regression Codex found could not be caught by any test that ran the source:
   * it lived in the interaction between the compiled output and `apps/web/env.sh`,
   * which does a global `sed` for the token over every `.js` file in the image. The
   * baked value and the source's comparison constant were both that token, so the
   * substitution moved BOTH and they stayed equal — a fully configured deployment
   * silently took the dev fallback.
   *
   * So this test compiles the real module, performs the real substitution on the
   * real output bytes, and evaluates the result. Everything the component imports is
   * stubbed: nothing is rendered here, only `apexUrl` is called.
   */
  async function compileAndSubstitute(bakedValue: string, apex: string) {
    const esbuild = await import("esbuild");
    const entry = fileURLToPath(
      new URL("../components/operon-switcher.tsx", import.meta.url),
    );

    const stubEverythingButTheEntry: import("esbuild").Plugin = {
      name: "stub-non-relative-imports",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === "entry-point") return null;
          if (args.path.startsWith(".") || args.path.startsWith("/")) {
            return null;
          }
          return { path: args.path, namespace: "stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: [
            "export default {};",
            "export const UserAvatar = () => null;",
            "export const useUserWebSocket = () => {};",
          ].join("\n"),
          loader: "js",
        }));
      },
    };

    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "operonSwitcherModule",
      platform: "browser",
      // No renderer is needed: the JSX is compiled to calls that are never made.
      jsx: "transform",
      jsxFactory: "__stubJsx",
      jsxFragment: "__stubFragment",
      banner: {
        js: "var __stubJsx = () => null; var __stubFragment = null;",
      },
      define: {
        // What Vite bakes from `apps/web/.env.production` at image build time: the
        // MEMBER, inlined, so no `VITE_OPERON_APEX_URL` identifier survives into the
        // output — which is what production really looks like, and what makes the
        // substitution below hit only the value.
        "import.meta.env.VITE_OPERON_APEX_URL": JSON.stringify(bakedValue),
      },
      plugins: [stubEverythingButTheEntry],
    });

    const compiled = result.outputFiles[0]?.text ?? "";
    expect(compiled).toContain(bakedValue);
    // Vite inlines the member, so the variable NAME is gone from the artefact and the
    // only occurrences of the token are the baked value itself.
    expect(compiled).not.toContain("VITE_" + bakedValue);

    // EXACTLY what `apps/web/env.sh` does to every .js file in the image:
    //   sed -i "s#OPERON_APEX_URL#$OPERON_APEX_URL#g"
    // — global, over the whole file, with no idea which occurrence is which.
    const substituted = compiled.split(bakedValue).join(apex);

    const load = new Function(
      `var operonSwitcherModule; ${substituted}; return operonSwitcherModule;`,
    ) as () => { apexUrl: () => string };

    return load().apexUrl();
  }

  it("returns the substituted apex, not the dev fallback", async () => {
    const apex = "https://operon.example.org";
    // A production-shaped value that appears in no source file in this repository.
    expect(await compileAndSubstitute("OPERON_APEX_URL", apex)).toBe(apex);
  }, 30_000);

  it("still falls back when env.sh substituted nothing", async () => {
    // `OPERON_APEX_URL` unset in the container: the token survives verbatim.
    const compiledResult = await compileAndSubstitute(
      "OPERON_APEX_URL",
      "OPERON_APEX_URL",
    );
    expect(compiledResult).toBe(DEV_APEX_URL);
  }, 30_000);
});
