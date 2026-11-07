import { markdownToPlainText } from "./markdown-to-plain-text";

/** Copy title and text / .txt body: the title, a blank line, the plain description. */
export function buildScriptText(
  title: string,
  markdown: string | null | undefined,
): string {
  const body = markdownToPlainText(markdown ?? "", { dropNotSpoken: true });
  return body.trim() ? `${title}\n\n${body}` : title;
}

/** .md body: the title as a heading, then the description exactly as stored. */
export function buildScriptMarkdown(
  title: string,
  markdown: string | null | undefined,
): string {
  return `# ${title}\n\n${markdown ?? ""}`;
}

// Characters no common filesystem accepts, plus control characters.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what the filename rule removes
const FILENAME_UNSAFE = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;
const FILENAME_MAX = 100;

/**
 * `<NN> - <title>.<ext>`, NN the task number zero-padded to two. A task with no
 * number gets no prefix (assumption A3); an empty title becomes the literal
 * `Untitled` (A4, a filename, not UI copy).
 */
export function scriptFilename(
  number: number | null,
  title: string,
  ext: "txt" | "md",
): string {
  const trimEdges = (value: string) => value.replace(/^[. ]+|[. ]+$/g, "");
  let name = trimEdges(title.replace(FILENAME_UNSAFE, "").replace(/\s+/g, " "));
  name = trimEdges(name.slice(0, FILENAME_MAX)) || "Untitled";
  const prefix = number === null ? "" : `${String(number).padStart(2, "0")} - `;
  return `${prefix}${name}.${ext}`;
}
