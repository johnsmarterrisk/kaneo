import { lexer, type Token, type Tokens } from "marked";

// A part of one rendered block. Code is kept byte-for-byte (scripts carry
// indented mermaid and code samples), so normalisation only ever touches
// `text` parts; `sep` parts are the joins between parts and are never trimmed.
type Part = { kind: "text" | "code" | "sep"; value: string };

const NOT_SPOKEN = /not spoken/i;
// A source mark such as [CDC](url) or [SmarterRisk](url): one short token.
const CITATION_TEXT = /^[A-Za-z0-9]{1,12}$/;
// The rendered text before a citation ends a sentence: terminal punctuation,
// optional closing quotes/parentheses, at most one space. Closing emphasis
// markers are already gone from rendered text, so `**…back.”** [CDC]` matches.
const SENTENCE_END = /[.!?]["'”’»)]* ?$/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  nbsp: "\u00a0",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (match, ref) => {
    if (ref in NAMED_ENTITIES) return NAMED_ENTITIES[ref];
    if (ref.startsWith("#x")) {
      const code = Number.parseInt(ref.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (ref.startsWith("#")) {
      const code = Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

// Custom editor nodes are stored as HTML. A mention keeps its visible
// `@label`; every other tag is dropped, and text between tags stays (so the
// invalid-embed span keeps its visible URL).
function htmlToText(html: string): string {
  return html
    .replace(/<kaneo-mention\b[^>]*\blabel="([^"]*)"[^>]*>/g, "@$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "");
}

function inlineText(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text":
        out +=
          "tokens" in token && token.tokens
            ? inlineText(token.tokens)
            : token.text;
        break;
      case "strong":
      case "em":
      case "del":
        out += inlineText((token as Tokens.Strong).tokens);
        break;
      case "codespan":
      case "escape":
        out += token.text;
        break;
      case "link": {
        const text = inlineText((token as Tokens.Link).tokens);
        if (CITATION_TEXT.test(text) && SENTENCE_END.test(out)) {
          out = out.replace(/ $/, "");
          break;
        }
        out += text;
        break;
      }
      case "br":
        out += "\n";
        break;
      case "html":
        out += htmlToText(token.text);
        break;
      case "image":
      case "checkbox":
        break;
      default:
        out +=
          "tokens" in token && Array.isArray(token.tokens)
            ? inlineText(token.tokens)
            : "text" in token && typeof token.text === "string"
              ? token.text
              : "";
    }
  }
  return out;
}

function joinParts(groups: Part[][], separator: string): Part[] {
  const out: Part[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (out.length > 0) out.push({ kind: "sep", value: separator });
    out.push(...group);
  }
  return out;
}

function listParts(list: Tokens.List, level: number): Part[] {
  const indent = "  ".repeat(level);
  const start = typeof list.start === "number" ? list.start : 1;
  const items = list.items.map((item, index) => {
    const marker = item.task ? "" : list.ordered ? `${start + index}. ` : "• ";
    let first = true;
    const pieces: Part[][] = [];
    for (const child of item.tokens) {
      if (child.type === "list") {
        pieces.push(listParts(child as Tokens.List, level + 1));
      } else if (child.type === "code") {
        pieces.push([{ kind: "code", value: child.text }]);
      } else if (child.type === "space" || child.type === "checkbox") {
        // nothing spoken
      } else {
        const text = blockText(child);
        if (!text) continue;
        pieces.push([
          { kind: "text", value: `${indent}${first ? marker : ""}${text}` },
        ]);
        first = false;
      }
    }
    return joinParts(pieces, "\n");
  });
  return joinParts(items, "\n");
}

function blockText(token: Token): string {
  if (token.type === "html") return htmlToText(token.text);
  if ("tokens" in token && Array.isArray(token.tokens)) {
    return inlineText(token.tokens);
  }
  return "text" in token && typeof token.text === "string" ? token.text : "";
}

function blockParts(token: Token): Part[] {
  switch (token.type) {
    case "space":
    case "hr":
    case "def":
      return [];
    case "code":
      return [{ kind: "code", value: token.text }];
    case "list":
      return listParts(token as Tokens.List, 0);
    case "blockquote":
      return joinParts(
        (token as Tokens.Blockquote).tokens.map(blockParts),
        "\n\n",
      );
    case "table": {
      const table = token as Tokens.Table;
      const row = (cells: Tokens.TableCell[]) =>
        cells.map((cell) => inlineText(cell.tokens)).join("\t");
      return [
        {
          kind: "text",
          value: [row(table.header), ...table.rows.map(row)].join("\n"),
        },
      ];
    }
    default:
      return [{ kind: "text", value: blockText(token) }];
  }
}

// Normalise one text part: trailing whitespace off each line, blank-line runs
// collapsed, blank lines at its outer edges removed. Leading spaces stay (they
// are nested-list indentation).
function normaliseText(value: string): string {
  return decodeEntities(value)
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

function renderParts(parts: Part[]): string {
  const normalised = parts.map((part) =>
    part.kind === "text" ? { ...part, value: normaliseText(part.value) } : part,
  );
  // A part that normalised to nothing takes its preceding separator with it.
  let out = "";
  let pendingSep = "";
  let hasContent = false;
  for (const part of normalised) {
    if (part.kind === "sep") {
      if (hasContent) pendingSep = part.value;
      continue;
    }
    if (part.kind === "text" && part.value === "") continue;
    out += pendingSep + part.value;
    pendingSep = "";
    hasContent = true;
  }
  return out;
}

/**
 * The spoken plain text of a stored task description (Markdown with the
 * editor's custom HTML nodes). Lexed with the editor's own options.
 */
export function markdownToPlainText(
  markdown: string,
  opts: { dropNotSpoken: boolean },
): string {
  const tokens = lexer(markdown, { gfm: true, breaks: true });
  const blocks: string[] = [];
  let skipUntilDepth: number | null = null;

  for (const token of tokens) {
    if (token.type === "heading") {
      const depth = (token as Tokens.Heading).depth;
      if (skipUntilDepth !== null && depth <= skipUntilDepth) {
        skipUntilDepth = null;
      }
      if (
        skipUntilDepth === null &&
        opts.dropNotSpoken &&
        NOT_SPOKEN.test(inlineText((token as Tokens.Heading).tokens))
      ) {
        skipUntilDepth = depth;
      }
    }
    if (skipUntilDepth !== null) continue;

    const block = renderParts(blockParts(token));
    if (block !== "") blocks.push(block);
  }

  return blocks.join("\n\n");
}
