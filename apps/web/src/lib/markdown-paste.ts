import type { TiptapEditorHTMLElement } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";

// Operon fork (row 22, Markdown paste): pasted plain text that looks like
// Markdown is parsed by @tiptap/markdown (already in both editors) instead of
// landing as literal `#` and `**`. Detection is deliberately conservative
// (Decision A): prose with a stray `*` or one leading `1.` keeps today's paste.

const HEADING_LINE = /^ {0,3}#{1,6} \S/m;
const FENCE_LINE = /^ {0,3}```/m;
// One regex per line kind: two lines of the SAME kind trigger, so prose with
// one numbered line and one dash-led line stays literal (T6 walk ruling).
const LIST_OR_QUOTE_LINES = [
  /^ {0,3}[-*+] \S/, // bullet
  /^ {0,3}\d{1,9}[.)] \S/, // numbered
  /^ {0,3}> \S/, // quote
];
const INLINE_MARKERS = [
  /\*\*[^*\n]+\*\*/, // bold
  /\[[^\]\n]+\]\(\S+?\)/, // link
  /`[^`\n]+`/, // inline code
];

export function looksLikeMarkdown(text: string): boolean {
  if (HEADING_LINE.test(text) || FENCE_LINE.test(text)) return true;

  const lines = text.split("\n");
  for (const kind of LIST_OR_QUOTE_LINES) {
    if (lines.filter((line) => kind.test(line)).length >= 2) return true;
  }

  return INLINE_MARKERS.some((marker) => marker.test(text));
}

/**
 * The Markdown branch of the editors' handlePaste. Returns true only when it
 * inserted the paste; every other case returns false so the existing handler
 * paths (and ProseMirror's default paste) run exactly as before.
 *
 * It takes the handler's own `view` and resolves the Tiptap editor from it
 * (Tiptap sets `view.dom.editor`), never the component's `editor` variable:
 * with `immediatelyRender: false` the editorProps closure captures `editor`
 * from the render before the instance existed, so it is null at paste time.
 */
export function pasteMarkdown(
  view: EditorView,
  event: ClipboardEvent,
): boolean {
  const editor = (view.dom as TiptapEditorHTMLElement).editor;
  if (!editor || editor.isDestroyed) return false;
  const clipboardData = event.clipboardData;
  if (!clipboardData) return false;
  // Rich pastes (browser, Docs, Word) are already formatted by the default
  // paste; never second-guess them from their plain flavour (Decision B).
  if (Array.from(clipboardData.types ?? []).includes("text/html")) {
    return false;
  }

  const text = clipboardData.getData("text/plain") || "";
  const trimmed = text.trim();
  // A whitespace-free paste keeps the URL / issue-key / YouTube paths (R3a).
  if (!trimmed || !/\s/.test(trimmed)) return false;
  if (!looksLikeMarkdown(trimmed)) return false;

  let inserted: boolean;
  try {
    inserted = editor.commands.insertContent(text, {
      contentType: "markdown",
    });
  } catch (error) {
    console.error("Markdown paste failed:", error);
    return false;
  }
  if (!inserted) return false;

  // Only after a successful insert, so a failure leaves the default paste.
  event.preventDefault();
  return true;
}
