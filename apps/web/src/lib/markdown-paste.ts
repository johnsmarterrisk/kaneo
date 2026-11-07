import type { Editor } from "@tiptap/core";

// Operon fork (row 22, Markdown paste): pasted plain text that looks like
// Markdown is parsed by @tiptap/markdown (already in both editors) instead of
// landing as literal `#` and `**`. Detection is deliberately conservative
// (Decision A): prose with a stray `*` or one leading `1.` keeps today's paste.

const HEADING_LINE = /^ {0,3}#{1,6} \S/m;
const FENCE_LINE = /^ {0,3}```/m;
const LIST_OR_QUOTE_LINE = /^ {0,3}(?:[-*+] |\d{1,9}[.)] |> )\S/;
const INLINE_MARKERS = [
  /\*\*[^*\n]+\*\*/, // bold
  /\[[^\]\n]+\]\(\S+?\)/, // link
  /`[^`\n]+`/, // inline code
];

export function looksLikeMarkdown(text: string): boolean {
  if (HEADING_LINE.test(text) || FENCE_LINE.test(text)) return true;

  let listLines = 0;
  for (const line of text.split("\n")) {
    if (LIST_OR_QUOTE_LINE.test(line)) listLines += 1;
    if (listLines >= 2) return true;
  }

  return INLINE_MARKERS.some((marker) => marker.test(text));
}

/**
 * The Markdown branch of the editors' handlePaste. Returns true only when it
 * inserted the paste; every other case returns false so the existing handler
 * paths (and ProseMirror's default paste) run exactly as before.
 */
export function pasteMarkdown(
  editor: Editor | null,
  event: ClipboardEvent,
): boolean {
  if (!editor) return false;
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
