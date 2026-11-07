import { describe, expect, it } from "vitest";
import { markdownToPlainText } from "./markdown-to-plain-text";

const spoken = (markdown: string) =>
  markdownToPlainText(markdown, { dropNotSpoken: true });

// AC1: nothing Markdown-shaped reaches the spoken text.
function expectNoMarkup(text: string) {
  expect(text).not.toContain("**");
  expect(text).not.toMatch(/^#/m);
  expect(text).not.toContain("](");
  expect(text).not.toContain("![");
  expect(text).not.toContain("<kaneo-");
}

describe("markdownToPlainText", () => {
  it.each([
    ["heading", "## Opening", "Opening"],
    [
      "strong, em, del, codespan",
      "**Wear** *your* ~~old~~ `PPE`",
      "Wear your old PPE",
    ],
    [
      "in-sentence link",
      "see the [hearing policy](https://x/p) now",
      "see the hearing policy now",
    ],
    [
      "autolink keeps its URL",
      "visit https://example.com today",
      "visit https://example.com today",
    ],
    [
      "reference link and its def",
      "read [the guide][g]\n\n[g]: https://x/g",
      "read the guide",
    ],
    [
      "trailing citation",
      "Always wear earplugs. [OSHA](https://x)",
      "Always wear earplugs.",
    ],
    [
      "citation after a closing quote",
      "She said “come back.” [CDC](https://x)",
      "She said “come back.”",
    ],
    [
      "citation after closing emphasis",
      "**She said “come back.”** [CDC](https://x)",
      "She said “come back.”",
    ],
    ["no boundary after emphasis", "**Use** [PPE](https://x)", "Use PPE"],
    [
      "closing paren alone is no boundary",
      "(Use) [PPE](https://x)",
      "(Use) PPE",
    ],
    [
      "citation mid-paragraph",
      "Stop. [NIOSH](https://x) Then go.",
      "Stop. Then go.",
    ],
    [
      "long link text is not a citation",
      "Done. [the hearing policy](https://x)",
      "Done. the hearing policy",
    ],
    ["image dropped", "Look ![a chart](https://x/c.png) here", "Look  here"],
    ["line break", "one\ntwo", "one\ntwo"],
    ["escape", "a \\* b", "a * b"],
    ["unordered list", "- one\n- two", "• one\n• two"],
    ["ordered list keeps its start", "3. three\n4. four", "3. three\n4. four"],
    [
      "nested list",
      "- one\n  - inner\n    - deeper\n- two",
      "• one\n  • inner\n    • deeper\n• two",
    ],
    ["task list", "- [ ] buy\n- [x] sell", "buy\nsell"],
    ["blockquote", "> quoted **text**", "quoted text"],
    ["table", "| a | b |\n|---|---|\n| 1 | 2 |", "a\tb\n1\t2"],
    ["hr dropped", "above\n\n---\n\nbelow", "above\n\nbelow"],
    [
      "mention",
      'Hi <kaneo-mention id="u1" label="Ann"></kaneo-mention> there',
      "Hi @Ann there",
    ],
    [
      "embed dropped",
      'before\n\n<kaneo-embed url="https://x" mode="embed" />\n\nafter',
      "before\n\nafter",
    ],
    [
      "invalid embed keeps its visible URL",
      '<span class="kaneo-embed-invalid-link">http://bad</span>',
      "http://bad",
    ],
    [
      "issue link dropped",
      'a\n\n<kaneo-issue-link url="https://x" issue-key="K-1" task-id="t" />\n\nb',
      "a\n\nb",
    ],
    [
      "attachment dropped",
      'a\n\n<kaneo-attachment url="https://x" filename="f.pdf" mime-type="application/pdf" size="3" />\n\nb',
      "a\n\nb",
    ],
    [
      "entities decoded",
      "Tom &amp; Jerry &lt;3 &quot;hi&quot; &#39;x&#39; &#65;&#x42;&nbsp;!",
      "Tom & Jerry <3 \"hi\" 'x' AB !",
    ],
    ["footnote stays text (A5)", "a claim [^1]", "a claim [^1]"],
    ["empty input", "", ""],
    ["whitespace input", "  \n\n  ", ""],
  ])("%s", (_name, markdown, expected) => {
    const text = spoken(markdown);
    expect(text).toBe(expected);
  });

  it("keeps a fenced block verbatim between prose blocks", () => {
    const markdown =
      "Intro.\n\n```mermaid\n  graph TD  \n\n    A --> B\n```\n\nOutro.";
    expect(spoken(markdown)).toBe(
      "Intro.\n\n  graph TD  \n\n    A --> B\n\nOutro.",
    );
  });

  it("keeps a fenced block verbatim inside a nested list", () => {
    const markdown =
      "- step\n  - inner\n\n    ```\n      indented  \n\n    x\n    ```\n- next";
    expect(spoken(markdown)).toBe(
      "• step\n  • inner\n  indented  \n\nx\n• next",
    );
  });

  it("keeps a fenced block's edges when it is the first and last block", () => {
    expect(spoken("```\n  first  \n\n```")).toBe("  first  \n");
    expect(spoken("Prose.\n\n```\n\n  last  \n```")).toBe(
      "Prose.\n\n\n  last  ",
    );
  });

  it("joins blocks by exactly one blank line and trims trailing spaces", () => {
    expect(spoken("one   \n\n\n\ntwo  ")).toBe("one\n\ntwo");
  });

  it("drops a not-spoken section at h2 until the next h2", () => {
    const markdown =
      "## Script\n\nSay this.\n\n## Not spoken\n\nB-roll notes.\n\n### Shot list\n\nWide.\n\n## Close\n\nBye.";
    expect(spoken(markdown)).toBe("Script\n\nSay this.\n\nClose\n\nBye.");
  });

  it("drops a not-spoken section at h2 until a following h1", () => {
    const markdown = "## NOT SPOKEN: crew\n\nLights.\n\n# Part two\n\nHello.";
    expect(spoken(markdown)).toBe("Part two\n\nHello.");
  });

  it("keeps a not-spoken section when dropNotSpoken is false", () => {
    expect(
      markdownToPlainText("## Not spoken\n\nNotes.", { dropNotSpoken: false }),
    ).toBe("Not spoken\n\nNotes.");
  });

  it("leaves no Markdown in a realistic script (AC1)", () => {
    const markdown = [
      "# Hearing protection",
      "",
      "**Noise** hurts. *Really.* See the [policy](https://x/p). [OSHA](https://osha.gov)",
      "",
      "![chart](https://x/c.png)",
      "",
      '- Ask <kaneo-mention id="u1" label="Ann"></kaneo-mention>',
      "- [ ] Check [fit][f]",
      "",
      '<kaneo-embed url="https://x/v" mode="embed" />',
      "",
      "[f]: https://x/f",
    ].join("\n");
    const text = spoken(markdown);
    expectNoMarkup(text);
    expect(text).toBe(
      "Hearing protection\n\nNoise hurts. Really. See the policy.\n\n• Ask @Ann\nCheck fit",
    );
  });
});
