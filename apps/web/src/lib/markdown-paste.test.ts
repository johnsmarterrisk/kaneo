import { Editor, type JSONContent } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { looksLikeMarkdown, pasteMarkdown } from "./markdown-paste";

const SCRIPT = [
  "# Episode 12",
  "",
  "## Cold open",
  "",
  "Say **Smarter Risk** clearly.",
  "",
  "- first beat",
  "- second beat",
  "",
  "1. intro",
  "2. outro",
  "",
  "See [the site](https://smarterrisk.example/a) and run `npm test`.",
].join("\n");

function makeEditor(): Editor {
  return new Editor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Markdown.configure({ markedOptions: { breaks: true, gfm: true } }),
    ],
  });
}

function pasteEvent(
  flavours: Record<string, string> | null,
): ClipboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  const clipboardData = flavours
    ? {
        types: Object.keys(flavours),
        getData: (type: string) => flavours[type] ?? "",
      }
    : null;
  return {
    clipboardData,
    preventDefault: vi.fn(),
  } as unknown as ClipboardEvent & {
    preventDefault: ReturnType<typeof vi.fn>;
  };
}

function collect(node: JSONContent, out: JSONContent[] = []): JSONContent[] {
  out.push(node);
  for (const child of node.content ?? []) collect(child, out);
  return out;
}

function markTypes(doc: JSONContent): string[] {
  return collect(doc).flatMap((n) => (n.marks ?? []).map((m) => m.type));
}

// `editor.commands` is a getter that builds a fresh object on each read, so
// the stub replaces the getter rather than a property of one returned object.
function stubInsertContent(editor: Editor, impl: () => boolean): void {
  const real = editor.commands;
  vi.spyOn(editor, "commands", "get").mockReturnValue({
    ...real,
    insertContent: impl,
  });
}

let editors: Editor[] = [];
function editorUnderTest(): Editor {
  const editor = makeEditor();
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors) editor.destroy();
  editors = [];
  vi.restoreAllMocks();
});

describe("looksLikeMarkdown", () => {
  it.each([
    ["a heading line", "# Heading"],
    ["an opening fence line", "```ts\nconst a = 1;\n```"],
    ["two bullet lines", "- one\n- two"],
    ["two numbered lines", "1. one\n2. two"],
    ["two quote lines", "> one\n> two"],
    ["inline bold in prose", "Say **this** loud"],
    ["an inline link in prose", "see [the docs](https://x.test/a) now"],
    ["inline code in prose", "run `npm test` first"],
    ["the full script", SCRIPT],
    ["bold alone", "**bold**"],
  ])("is true for %s", (_name, text) => {
    expect(looksLikeMarkdown(text)).toBe(true);
  });

  it.each([
    ["two sentences of prose", "Call the client today. Then send the notes."],
    ["one numbered line and prose", "1. Call the client\nthen write it up"],
    ["one dash-led line and prose", "- remember the badge\nat the door"],
    ["a hashtag", "#hashtag launch today"],
    ["a sentence with one star", "the * is a footnote here"],
    ["a spaced dash", "a - b"],
    ["an email", "write to john@example.com please"],
    ["a bare URL in prose", "look at https://x.test/a today"],
    ["empty", ""],
  ])("is false for %s", (_name, text) => {
    expect(looksLikeMarkdown(text)).toBe(false);
  });
});

describe("pasteMarkdown", () => {
  it("inserts parsed Markdown and prevents the default paste", () => {
    const editor = editorUnderTest();
    const event = pasteEvent({ "text/plain": SCRIPT });

    expect(pasteMarkdown(editor.view, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);

    const doc = editor.getJSON();
    const nodes = collect(doc);
    const types = nodes.map((n) => n.type);
    expect(types).toContain("heading");
    expect(types).toContain("bulletList");
    expect(types).toContain("orderedList");
    expect(markTypes(doc)).toEqual(
      expect.arrayContaining(["bold", "link", "code"]),
    );
    const link = nodes
      .flatMap((n) => n.marks ?? [])
      .find((m) => m.type === "link");
    expect(link?.attrs?.href).toBe("https://smarterrisk.example/a");
    const visible = editor.getText();
    expect(visible).not.toContain("**");
    expect(visible).not.toContain("](");
    expect(visible).not.toMatch(/^#/m);
  });

  it("leaves an HTML-bearing paste to the existing paths", () => {
    const editor = editorUnderTest();
    const before = editor.getJSON();
    const event = pasteEvent({
      "text/plain": SCRIPT,
      "text/html": "<h1>Episode 12</h1>",
    });

    expect(pasteMarkdown(editor.view, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(editor.getJSON()).toEqual(before);
  });

  it.each(["https://x.test/a", "**bold**", "`code`", "[a](https://b)"])(
    "leaves the single token %s literal",
    (token) => {
      const editor = editorUnderTest();
      const before = editor.getJSON();
      const event = pasteEvent({ "text/plain": token });

      expect(pasteMarkdown(editor.view, event)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(editor.getJSON()).toEqual(before);
    },
  );

  it("leaves prose to the default paste", () => {
    const editor = editorUnderTest();
    const before = editor.getJSON();
    const event = pasteEvent({
      "text/plain": "Call the client today. Then send the notes.",
    });

    expect(pasteMarkdown(editor.view, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(editor.getJSON()).toEqual(before);
  });

  it.each([
    ["missing clipboard data", null],
    ["an empty plain flavour", { "text/plain": "" }],
  ])("returns false for %s", (_name, flavours) => {
    const editor = editorUnderTest();
    const before = editor.getJSON();
    const event = pasteEvent(flavours);

    expect(pasteMarkdown(editor.view, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(editor.getJSON()).toEqual(before);
  });

  it("returns false and logs when insertion throws", () => {
    const editor = editorUnderTest();
    const failure = new Error("parse exploded");
    stubInsertContent(editor, () => {
      throw failure;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const event = pasteEvent({ "text/plain": SCRIPT });

    expect(pasteMarkdown(editor.view, event)).toBe(false);
    expect(logged).toHaveBeenCalledWith("Markdown paste failed:", failure);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("returns false when the insert command returns false", () => {
    const editor = editorUnderTest();
    const before = editor.getJSON();
    stubInsertContent(editor, () => false);
    const event = pasteEvent({ "text/plain": SCRIPT });

    expect(pasteMarkdown(editor.view, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(editor.getJSON()).toEqual(before);
  });

  it("returns false for a view with no editor behind it", () => {
    const event = pasteEvent({ "text/plain": SCRIPT });
    const view = {
      dom: document.createElement("div"),
    } as unknown as EditorView;
    expect(pasteMarkdown(view, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  // The way the editors run it: handlePaste is declared in the options of the
  // render before the editor exists (immediatelyRender: false), so a closure
  // over the component's `editor` is null at paste time — the T6 walk's root
  // cause. The helper must work from the handler's own view alone.
  it("inserts when called from an editorProps.handlePaste whose closure editor is null", () => {
    const closureEditor: Editor | null = null;
    const seen: Array<Editor | null> = [];
    const editor = new Editor({
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
        Markdown.configure({ markedOptions: { breaks: true, gfm: true } }),
      ],
      editorProps: {
        handlePaste: (view, event) => {
          seen.push(closureEditor);
          return pasteMarkdown(view, event);
        },
      },
    });
    editors.push(editor);
    const event = pasteEvent({ "text/plain": SCRIPT });

    const handled = editor.view.someProp("handlePaste", (handler) =>
      handler(editor.view, event, editor.view.state.doc.slice(0, 0)),
    );

    expect(seen).toEqual([null]);
    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(collect(editor.getJSON()).map((n) => n.type)).toContain("heading");
  });

  it("keeps a pasted h4 as a level-4 heading drawn as h1 and saved as ####", () => {
    const editor = editorUnderTest();
    const event = pasteEvent({ "text/plain": "#### x" });

    // "#### x" has whitespace and a heading line, so it takes the branch.
    expect(pasteMarkdown(editor.view, event)).toBe(true);
    const heading = collect(editor.getJSON()).find((n) => n.type === "heading");
    expect(heading?.attrs?.level).toBe(4);
    expect(editor.getHTML()).toContain("<h1>x</h1>");
    expect(editor.getMarkdown().trim()).toBe("#### x");
  });
});
