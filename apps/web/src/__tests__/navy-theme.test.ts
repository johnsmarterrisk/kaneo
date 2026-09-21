// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { badgeVariants } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
function tokens(selector: string): Record<string, string> {
  const block = css.slice(css.indexOf(`${selector} {`)).split("}")[0];
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*(#[\da-f]{6});/gi)].map((m) => [
      m[1],
      m[2],
    ]),
  );
}
function luminance(hex: string) {
  const rgb = hex
    .slice(1)
    .match(/../g)
    ?.map((channel) => {
      const n = Number.parseInt(channel, 16) / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    });
  if (!rgb) throw new Error(`Invalid colour: ${hex}`);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("white surfaces on the navy ground", () => {
  const navy = { ...tokens(":root"), ...tokens(".navy") };
  it("uses the approved palette and reserves white ink for the ground", () => {
    expect(navy).toMatchObject({
      "--background": "#081a33",
      "--foreground": "#ffffff",
      "--card": "#ffffff",
      "--card-foreground": "#0b1f3a",
      "--popover": "#ffffff",
      "--popover-foreground": "#0b1f3a",
      "--secondary": "#efefef",
      "--secondary-foreground": "#0b1f3a",
      "--muted": "#efefef",
      "--muted-foreground": "#5a6577",
      "--accent": "#fbf4df",
      "--accent-foreground": "#0b1f3a",
      "--border": "#d7dee8",
      "--input": "#8496ae",
      "--ring": "#15315a",
      "--primary": "#15315a",
      "--primary-foreground": "#ffffff",
      "--destructive": "#c0362c",
      "--destructive-foreground": "#ffffff",
      "--success": "#167a4b",
      "--warning": "#8a5a00",
      "--tag": "#f5b700",
      "--tag-foreground": "#0b1f3a",
    });
    expect(css).toContain("@custom-variant dark (&:is(.dark *));");
  });

  it.each([":root", ".dark", ".navy"])(
    "keeps control and text pairs readable in %s",
    (selector) => {
      const palette = { ...tokens(":root"), ...tokens(selector) };
      for (const surface of [
        "card",
        "popover",
        "secondary",
        "accent",
        "primary",
        "destructive",
        "tag",
      ]) {
        expect(
          contrast(palette[`--${surface}`], palette[`--${surface}-foreground`]),
          surface,
        ).toBeGreaterThanOrEqual(4.5);
      }
      for (const ink of [
        "muted-foreground",
        "ink-secondary",
        "success",
        "warning",
        "destructive",
      ]) {
        expect(
          contrast(palette[`--${ink}`], palette["--card"]),
          ink,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("distinguishes text on solid buttons from text on light surfaces", () => {
    expect(buttonVariants({ variant: "destructive" })).toContain(
      "bg-destructive text-destructive-foreground",
    );
    expect(buttonVariants({ variant: "destructive-outline" })).toContain(
      "text-destructive ",
    );
    for (const variant of ["ghost", "outline", "link"] as const) {
      expect(buttonVariants({ variant })).toContain("text-card-foreground");
    }
    expect(badgeVariants({ variant: "error" })).toContain("text-destructive ");
    expect(badgeVariants({ variant: "tag" })).toContain(
      "bg-tag text-tag-foreground",
    );
    expect(contrast(navy["--input"], navy["--card"])).toBeGreaterThanOrEqual(3);
  });
});
