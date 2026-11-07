import { describe, expect, it } from "vitest";
import { buildScriptMarkdown, buildScriptText } from "./task-script";

describe("buildScriptText", () => {
  it("is the title, a blank line, then the spoken description", () => {
    expect(buildScriptText("MV-10", "**Hello** [team](https://x).")).toBe(
      "MV-10\n\nHello team.",
    );
  });

  it("drops a not-spoken section", () => {
    expect(
      buildScriptText("T", "Say it.\n\n## Not spoken\n\nCrew notes."),
    ).toBe("T\n\nSay it.");
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["whitespace", "   \n\n  "],
    ["only a dropped image", "![x](https://x/i.png)"],
  ])("is the title alone for a %s description (AC4)", (_name, markdown) => {
    expect(buildScriptText("Title only", markdown)).toBe("Title only");
  });
});

describe("buildScriptMarkdown", () => {
  it.each([
    ["no trailing whitespace", "Body **bold**"],
    ["trailing spaces", "Body  "],
    ["trailing newlines", "Body\n\n"],
    ["a not-spoken section, kept", "Say.\n\n## Not spoken\n\nNotes."],
  ])("keeps the description exactly as stored: %s", (_name, markdown) => {
    expect(buildScriptMarkdown("MV-10", markdown)).toBe(
      `# MV-10\n\n${markdown}`,
    );
  });

  it("is the heading alone for an empty description", () => {
    expect(buildScriptMarkdown("MV-10", null)).toBe("# MV-10\n\n");
  });
});
