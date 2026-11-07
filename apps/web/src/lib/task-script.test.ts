import { describe, expect, it } from "vitest";
import {
  buildScriptMarkdown,
  buildScriptText,
  scriptFilename,
} from "./task-script";

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

// AC5: the saved file's name.
describe("scriptFilename", () => {
  it.each([
    [
      "pads the number to two",
      7,
      "MV-10 Hearing",
      "txt",
      "07 - MV-10 Hearing.txt",
    ],
    ["keeps a longer number", 123, "Intro", "md", "123 - Intro.md"],
    ["no number, no prefix (A3)", null, "Intro", "md", "Intro.md"],
    [
      "removes reserved characters",
      1,
      'a/b\\c:d*e?f"g<h>i|j',
      "txt",
      "01 - abcdefghij.txt",
    ],
    [
      "removes control characters",
      1,
      "a\u0000b\u001fc\u007fd",
      "txt",
      "01 - abcd.txt",
    ],
    ["collapses whitespace", 2, "a \t\n  b", "txt", "02 - a b.txt"],
    ["trims edge dots and spaces", 3, " ..Intro. . ", "txt", "03 - Intro.txt"],
    ["empty title is Untitled (A4)", 4, "", "txt", "04 - Untitled.txt"],
    [
      "only unsafe characters is Untitled",
      5,
      " ?*. ",
      "md",
      "05 - Untitled.md",
    ],
  ] as const)("%s", (_name, number, title, ext, expected) => {
    expect(scriptFilename(number, title, ext)).toBe(expected);
  });

  it("caps the title at 100 characters, then re-trims", () => {
    const title = `${"a".repeat(98)}. b`;
    expect(scriptFilename(1, title, "txt")).toBe(`01 - ${"a".repeat(98)}.txt`);
    expect(scriptFilename(1, "x".repeat(150), "md")).toBe(
      `01 - ${"x".repeat(100)}.md`,
    );
  });
});
