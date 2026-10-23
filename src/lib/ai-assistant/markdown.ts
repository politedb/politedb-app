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
  | {
      kind: "list";
      ordered: boolean;
      /** First number of an ordered list ("3." starts at 3). */
      start?: number;
      items: Inline[][];
    }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; children: Inline[] };

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** Longer answers render as plain text: the reader never does unbounded work. */
export const MAX_MARKDOWN_CHARS = 200_000;
/** Scan steps per inline run, as a multiple of its length (nested runs rescan). */
const WORK_PER_CHAR = 8;
const WORK_BASE = 10_000;
const MAX_NESTING = 16;

class WorkLimit extends Error {}

type Ctx = {
  budget: number;
  /** Next position of a character, remembered so repeated searches stay linear. */
  next: Map<string, { from: number; at: number }>;
};

function step(ctx: Ctx, cost = 1) {
  ctx.budget -= cost;
  if (ctx.budget < 0) throw new WorkLimit();
}

function nextIndex(s: string, ch: string, from: number, ctx: Ctx): number {
  const known = ctx.next.get(ch);
  if (known && known.from <= from && (known.at === -1 || known.at >= from)) {
    return known.at;
  }
  const at = s.indexOf(ch, from);
  ctx.next.set(ch, { from, at });
  return at;
}

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
const isWord = (ch: string | undefined) => ch !== undefined && /\w/.test(ch);

function runLength(s: string, i: number, end: number, ch: string): number {
  let j = i;
  while (j < end && s[j] === ch) j += 1;
  return j - i;
}

/** A delimiter run that can open: text follows it, and `_` does not sit inside a word. */
function canOpen(
  s: string,
  i: number,
  run: number,
  end: number,
  ch: string,
  start = 0
) {
  if (run > 3 || i + run >= end || isSpace(s[i + run])) return false;
  // Before `start` sits the enclosing run's own delimiter: a boundary, not a word.
  return ch === "*" || i <= start || !isWord(s[i - 1]);
}

/**
 * A delimiter run at `k` (of `run` characters) that can close: text precedes it,
 * and for `_` no word follows the whole run (the run may close several openers).
 */
function canClose(s: string, k: number, run: number, end: number, ch: string) {
  if (isSpace(s[k - 1])) return false;
  // Past `end` sits the enclosing run's own delimiter: a boundary, not a word.
  return ch === "*" || k + run >= end || !isWord(s[k + run]);
}

/** End (after `)`) of a complete `[text](destination)` at `i`, or -1. */
function linkEnd(s: string, i: number, end: number, ctx: Ctx): number {
  const close = nextIndex(s, "]", i + 1, ctx);
  if (
    close === -1 ||
    close + 1 >= end ||
    close <= i + 1 ||
    s[close + 1] !== "("
  ) {
    return -1;
  }
  // The destination ends at `)` and holds no whitespace.
  let k = close + 2;
  while (k < end && s[k] !== ")" && !isSpace(s[k])) {
    step(ctx);
    k += 1;
  }
  return k < end && s[k] === ")" && k > close + 2 ? k + 1 : -1;
}

/**
 * Where a run of `len` `ch` opened before `from` closes, or -1. Code spans are
 * skipped, and nested runs of another length are matched as a whole, so
 * `*a **b** c*` closes at the last `*`, not inside `**b**`.
 */
function findCloser(
  s: string,
  from: number,
  end: number,
  ch: string,
  len: number,
  ctx: Ctx,
  depth: number
): number {
  if (depth > MAX_NESTING) throw new WorkLimit();
  let k = from;
  while (k < end) {
    step(ctx);
    const c = s[k];
    if (c === "`") {
      const close = nextIndex(s, "`", k + 1, ctx);
      k = close !== -1 && close < end ? close + 1 : k + 1;
      continue;
    }
    if (c === "[") {
      // A link destination is opaque: markers inside it never close emphasis.
      const after = linkEnd(s, k, end, ctx);
      k = after !== -1 ? after : k + 1;
      continue;
    }
    if (c !== ch) {
      k += 1;
      continue;
    }
    const run = runLength(s, k, end, ch);
    step(ctx, run);
    if (run >= len && canClose(s, k, run, end, ch)) return k;
    if (run !== len && canOpen(s, k, run, end, ch)) {
      const inner = findCloser(s, k + run, end, ch, run, ctx, depth + 1);
      if (inner !== -1) {
        k = inner + run;
        continue;
      }
    }
    k += run;
  }
  return -1;
}

function parseRange(
  s: string,
  start: number,
  end: number,
  ctx: Ctx,
  depth: number
): Inline[] {
  if (depth > MAX_NESTING) throw new WorkLimit();
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ kind: "text", text: buffer });
    buffer = "";
  };
  let i = start;
  while (i < end) {
    step(ctx);
    const c = s[i];
    if (c === "\n") {
      flush();
      out.push({ kind: "break" });
      i += 1;
      continue;
    }
    if (c === "`") {
      const close = nextIndex(s, "`", i + 1, ctx);
      if (close !== -1 && close < end && close > i + 1) {
        flush();
        out.push({ kind: "code", text: s.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    if (c === "[") {
      const after = linkEnd(s, i, end, ctx);
      if (after !== -1) {
        const close = s.indexOf("](", i + 1);
        flush();
        out.push({
          kind: "link",
          text: s.slice(i + 1, close),
          domain: domainOf(s.slice(close + 2, after - 1)),
        });
        i = after;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      const run = runLength(s, i, end, c);
      step(ctx, run);
      if (canOpen(s, i, run, end, c, start)) {
        const close = findCloser(s, i + run, end, c, run, ctx, depth + 1);
        const full = close !== -1 && close > i + run ? close + run : -1;
        // A triple opener may close in two steps (`***a** b*`). The span that
        // closes first wins, so a later `***` never swallows the text between.
        const split =
          run === 3 ? splitTriple(s, i, end, c, ctx, depth + 1) : null;
        if (split && (full === -1 || split.next < full)) {
          flush();
          out.push(buildSplit(s, i + 3, split, ctx, depth + 1));
          i = split.next;
          continue;
        }
        if (full !== -1) {
          flush();
          const children = parseRange(s, i + run, close, ctx, depth + 1);
          out.push(
            run === 1
              ? { kind: "em", children }
              : run === 2
                ? { kind: "strong", children }
                : { kind: "strong", children: [{ kind: "em", children }] }
          );
          i = full;
          continue;
        }
      }
      buffer += s.slice(i, i + run);
      i += run;
      continue;
    }
    buffer += c;
    i += 1;
  }
  flush();
  return out;
}

type Split = {
  inner: 1 | 2;
  outer: 1 | 2;
  innerClose: number;
  outerClose: number;
  /** Position after the whole span. */
  next: number;
};

/**
 * A triple opener closed by two runs instead of one: `***a** b*` is emphasis
 * holding strong `a`, and `***a* b**` is strong holding emphasis `a`. Of the
 * two readings, the one that closes first.
 */
function splitTriple(
  s: string,
  i: number,
  end: number,
  ch: string,
  ctx: Ctx,
  depth: number
): Split | null {
  const start = i + 3;
  let best: Split | null = null;
  for (const [inner, outer] of [
    [2, 1],
    [1, 2],
  ] as const) {
    const innerClose = findCloser(s, start, end, ch, inner, ctx, depth);
    if (innerClose === -1 || innerClose <= start) continue;
    const outerClose = findCloser(
      s,
      innerClose + inner,
      end,
      ch,
      outer,
      ctx,
      depth
    );
    if (outerClose === -1) continue;
    const next = outerClose + outer;
    if (!best || next < best.next) {
      best = { inner, outer, innerClose, outerClose, next };
    }
  }
  return best;
}

function buildSplit(
  s: string,
  start: number,
  split: Split,
  ctx: Ctx,
  depth: number
): Inline {
  const innerNode: Inline = {
    kind: split.inner === 2 ? "strong" : "em",
    children: parseRange(s, start, split.innerClose, ctx, depth),
  };
  const rest = parseRange(
    s,
    split.innerClose + split.inner,
    split.outerClose,
    ctx,
    depth
  );
  return {
    kind: split.outer === 2 ? "strong" : "em",
    children: [innerNode, ...rest],
  };
}

/** Text with line breaks only. */
function plainInline(source: string): Inline[] {
  const out: Inline[] = [];
  source.split("\n").forEach((line, index) => {
    if (index > 0) out.push({ kind: "break" });
    if (line) out.push({ kind: "text", text: line });
  });
  return out;
}

/**
 * Inline markup: `code`, **strong**, *em* / _em_ (nesting-aware), [text](url),
 * hard line breaks. Work is bounded: past the budget the run is plain text.
 */
export function parseInline(source: string): Inline[] {
  const ctx: Ctx = {
    budget: WORK_BASE + WORK_PER_CHAR * source.length,
    next: new Map(),
  };
  try {
    return parseRange(source, 0, source.length, ctx, 0);
  } catch (error) {
    if (error instanceof WorkLimit) return plainInline(source);
    throw error;
  }
}

// `[\s\S]*` (not `.*`) so a line separator inside the text never forces backtracking.
const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+([\s\S]*)$/;

/**
 * The language of an opening code fence line (possibly empty), or null. A plain
 * trim-and-check: a regex with whitespace on both sides of an optional token
 * backtracks quadratically on near-miss lines.
 */
function fenceLanguage(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("```")) return null;
  const lang = trimmed.slice(3).trim();
  return /^[\w+-]*$/.test(lang) ? lang : null;
}

/** Block structure: fenced code, headings, lists, quotes and paragraphs. */
export function parseMarkdown(source: string): Block[] {
  if (source.length > MAX_MARKDOWN_CHARS) {
    return [{ kind: "paragraph", children: plainInline(source) }];
  }
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
    const fence = fenceLanguage(line);
    if (fence !== null) {
      flushParagraph();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== "```") {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({
        kind: "code",
        lang: fence,
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
    const heading = /^(#{1,6})\s+([\s\S]*)$/.exec(line);
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
      blocks.push(
        ordered
          ? { kind: "list", ordered, start: Number(item[2]), items }
          : { kind: "list", ordered, items }
      );
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
