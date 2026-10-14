/**
 * A small Markdown reader for assistant answers. It produces plain data that the UI
 * renders as elements, never HTML, so model text cannot inject markup. Links become
 * their text plus the domain (no clickable remote links, no images; plan ai-agent R5).
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; domain: string | null }
  | { kind: "break" };

export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; children: Inline[] };

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** Inline markup: `code`, **strong**, *em* / _em_, [text](url), hard line breaks. */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ kind: "text", text: buffer });
    buffer = "";
  };
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    if (rest[0] === "\n") {
      flush();
      out.push({ kind: "break" });
      i += 1;
      continue;
    }
    if (rest[0] === "`") {
      const end = source.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: "code", text: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (rest.startsWith("**") || rest.startsWith("__")) {
      const marker = rest.slice(0, 2);
      const end = source.indexOf(marker, i + 2);
      if (end > i + 2) {
        flush();
        out.push({
          kind: "strong",
          children: parseInline(source.slice(i + 2, end)),
        });
        i = end + 2;
        continue;
      }
    }
    if (
      (rest[0] === "*" || rest[0] === "_") &&
      rest[1] &&
      rest[1] !== " " &&
      rest[1] !== rest[0]
    ) {
      const end = source.indexOf(rest[0], i + 1);
      const prev = i > 0 ? source[i - 1] : " ";
      // `_` inside words (snake_case) is not emphasis.
      if (end > i + 1 && (rest[0] === "*" || !/\w/.test(prev))) {
        flush();
        out.push({
          kind: "em",
          children: parseInline(source.slice(i + 1, end)),
        });
        i = end + 1;
        continue;
      }
    }
    if (rest[0] === "[") {
      const match = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
      if (match) {
        flush();
        out.push({ kind: "link", text: match[1], domain: domainOf(match[2]) });
        i += match[0].length;
        continue;
      }
    }
    buffer += rest[0];
    i += 1;
  }
  flush();
  return out;
}

const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;

/** Block structure: fenced code, headings, lists, quotes and paragraphs. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({
        kind: "paragraph",
        children: parseInline(paragraph.join("\n")),
      });
    }
    paragraph = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({
        kind: "code",
        lang: fence[1] ?? "",
        text: body.join("\n"),
      });
      i += 1;
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      i += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        children: parseInline(heading[2].trim()),
      });
      i += 1;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flushParagraph();
      const ordered = Boolean(item[2]);
      const items: Inline[][] = [];
      while (i < lines.length) {
        const next = LIST_ITEM.exec(lines[i]);
        if (!next || Boolean(next[2]) !== ordered) break;
        let text = next[3];
        i += 1;
        // Indented continuation lines belong to the item.
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i]) &&
          !LIST_ITEM.exec(lines[i])
        ) {
          text += `\n${lines[i].trim()}`;
          i += 1;
        }
        items.push(parseInline(text));
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", children: parseInline(quoted.join("\n")) });
      continue;
    }
    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
  return blocks;
}
