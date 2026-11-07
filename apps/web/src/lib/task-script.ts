import { markdownToPlainText } from "./markdown-to-plain-text";

/** Copy script / .txt body: the title, a blank line, the spoken description. */
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
