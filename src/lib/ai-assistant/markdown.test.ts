import { describe, expect, it } from "vitest";
import { MAX_MARKDOWN_CHARS, parseInline, parseMarkdown } from "./markdown";

describe("parseMarkdown", () => {
  it("reads the structure of a typical agent answer", () => {
    const blocks = parseMarkdown(
      [
        "Đơn hàng nằm trong bảng **public.orders**.",
        "",
        "**Liên kết:**",
        "- `orders.user_id` → `users.id`",
        "- `orders.shipping_address_id` (có thể để trống)",
        "",
        "1. first",
        "2. second",
        "",
        "```sql",
        "SELECT 1;",
        "```",
      ].join("\n")
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      "paragraph",
      "paragraph",
      "list",
      "list",
      "code",
    ]);
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      children: [
        { kind: "text", text: "Đơn hàng nằm trong bảng " },
        { kind: "strong", children: [{ kind: "text", text: "public.orders" }] },
        { kind: "text", text: "." },
      ],
    });
    const list = blocks[2] as any;
    expect(list.ordered).toBe(false);
    expect(list.items[0][0]).toEqual({ kind: "code", text: "orders.user_id" });
    expect((blocks[3] as any).ordered).toBe(true);
    expect((blocks[3] as any).start).toBe(1);
    expect(list.start).toBeUndefined();
    expect(blocks[4]).toEqual({ kind: "code", lang: "sql", text: "SELECT 1;" });
  });

  it("keeps line breaks, headings and quotes", () => {
    const blocks = parseMarkdown("## Title\nline one\nline two\n\n> note");
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 2 });
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      children: [
        { kind: "text", text: "line one" },
        { kind: "break" },
        { kind: "text", text: "line two" },
      ],
    });
    expect(blocks[2]).toMatchObject({ kind: "quote" });
  });
});

describe("parseInline", () => {
  it("does not treat snake_case or a lone star as emphasis", () => {
    expect(parseInline("order_items and user_id")).toEqual([
      { kind: "text", text: "order_items and user_id" },
    ]);
    expect(parseInline("SELECT * FROM t")).toEqual([
      { kind: "text", text: "SELECT * FROM t" },
    ]);
    expect(parseInline("*soft*")).toEqual([
      { kind: "em", children: [{ kind: "text", text: "soft" }] },
    ]);
  });

  it("turns links into text plus domain", () => {
    expect(parseInline("[docs](https://www.postgresql.org/docs/)")).toEqual([
      { kind: "link", text: "docs", domain: "www.postgresql.org" },
    ]);
    expect(parseInline("[x](javascript:alert(1))")[0]).toMatchObject({
      kind: "link",
      domain: null,
    });
  });

  it("nests emphasis in both directions", () => {
    const text = (t: string) => ({ kind: "text", text: t });
    expect(parseInline("*italic **bold** text*")).toEqual([
      {
        kind: "em",
        children: [
          text("italic "),
          { kind: "strong", children: [text("bold")] },
          text(" text"),
        ],
      },
    ]);
    expect(parseInline("**bold *italic* text**")).toEqual([
      {
        kind: "strong",
        children: [
          text("bold "),
          { kind: "em", children: [text("italic")] },
          text(" text"),
        ],
      },
    ]);
    expect(parseInline("***both***")).toEqual([
      { kind: "strong", children: [{ kind: "em", children: [text("both")] }] },
    ]);
    expect(parseInline("__a _b___")).toEqual([
      {
        kind: "strong",
        children: [text("a "), { kind: "em", children: [text("b")] }],
      },
    ]);
    expect(parseInline("_a __b___")).toEqual([
      {
        kind: "em",
        children: [text("a "), { kind: "strong", children: [text("b")] }],
      },
    ]);
    expect(parseInline("***a** b*")).toEqual([
      {
        kind: "em",
        children: [{ kind: "strong", children: [text("a")] }, text(" b")],
      },
    ]);
    expect(parseInline("***a* b**")).toEqual([
      {
        kind: "strong",
        children: [{ kind: "em", children: [text("a")] }, text(" b")],
      },
    ]);
    // A later full triple span does not swallow an earlier split one.
    expect(parseInline("***a** b* then ***c***")).toEqual([
      {
        kind: "em",
        children: [{ kind: "strong", children: [text("a")] }, text(" b")],
      },
      text(" then "),
      { kind: "strong", children: [{ kind: "em", children: [text("c")] }] },
    ]);
    expect(parseInline("***a* b** then ***c***")).toEqual([
      {
        kind: "strong",
        children: [{ kind: "em", children: [text("a")] }, text(" b")],
      },
      text(" then "),
      { kind: "strong", children: [{ kind: "em", children: [text("c")] }] },
    ]);
    expect(parseInline("___a__ b_ and **c**")).toEqual([
      {
        kind: "em",
        children: [{ kind: "strong", children: [text("a")] }, text(" b")],
      },
      text(" and "),
      { kind: "strong", children: [text("c")] },
    ]);
    expect(parseInline("***x*** and ***y***")).toEqual([
      { kind: "strong", children: [{ kind: "em", children: [text("x")] }] },
      text(" and "),
      { kind: "strong", children: [{ kind: "em", children: [text("y")] }] },
    ]);
    expect(parseInline("__strong__ and _em_")).toEqual([
      { kind: "strong", children: [text("strong")] },
      text(" and "),
      { kind: "em", children: [text("em")] },
    ]);
  });

  it("keeps markers inside code and unmatched markers literal", () => {
    expect(parseInline("*a `b*c` d*")).toEqual([
      {
        kind: "em",
        children: [
          { kind: "text", text: "a " },
          { kind: "code", text: "b*c" },
          { kind: "text", text: " d" },
        ],
      },
    ]);
    expect(parseInline("*x [label](https://example.com/a*b) y*")).toEqual([
      {
        kind: "em",
        children: [
          { kind: "text", text: "x " },
          { kind: "link", text: "label", domain: "example.com" },
          { kind: "text", text: " y" },
        ],
      },
    ]);
    expect(parseInline("**see [doc](https://x.dev/a**b)**")).toEqual([
      {
        kind: "strong",
        children: [
          { kind: "text", text: "see " },
          { kind: "link", text: "doc", domain: "x.dev" },
        ],
      },
    ]);
    expect(parseInline("**unclosed and *also")).toEqual([
      { kind: "text", text: "**unclosed and *also" },
    ]);
    expect(parseInline("2 * 3 * 4")).toEqual([
      { kind: "text", text: "2 * 3 * 4" },
    ]);
    expect(parseInline("[not a link] and [x]")).toEqual([
      { kind: "text", text: "[not a link] and [x]" },
    ]);
  });

  it("stays fast on hostile input and keeps every character", () => {
    // Inputs that stay literal or fall back to plain text: the visible text must
    // be exactly the input.
    const literal = [
      "[".repeat(128_000),
      "*a ".repeat(40_000),
      "**a ".repeat(30_000),
      "`".repeat(128_000),
      "_a ".repeat(40_000),
      "*".repeat(128_000),
      "word ".repeat(30_000),
      "*a **b ".repeat(10_000) + "** ".repeat(10_000),
      ("[x " + "*a\n").repeat(20_000),
    ];
    const flat = (list: ReturnType<typeof parseInline>): string =>
      list
        .map((n) =>
          n.kind === "text" || n.kind === "code"
            ? n.text
            : n.kind === "break"
              ? "\n"
              : n.kind === "link"
                ? n.text
                : flat(n.children)
        )
        .join("");
    for (const source of literal) {
      const started = performance.now();
      const nodes = parseInline(source);
      expect(performance.now() - started, source.slice(0, 12)).toBeLessThan(
        500
      );
      expect(flat(nodes) === source, source.slice(0, 12)).toBe(true);
    }
    // One long link: fast, and its label survives.
    const link = "[a".repeat(64_000) + "](x)";
    const started = performance.now();
    expect(parseInline(link)[0]).toMatchObject({ kind: "link" });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("recognizes blocks in linear time on near-miss lines", () => {
    for (const source of [
      "```" + " ".repeat(64_000) + "!",
      " ".repeat(64_000) + "!",
      "#" + " ".repeat(64_000) + "\u2028!",
      "-" + " ".repeat(64_000) + "\u2028!",
      "  " + " ".repeat(64_000) + "\n  x",
      ">" + " ".repeat(64_000) + "!",
    ]) {
      const started = performance.now();
      parseMarkdown(source);
      expect(
        performance.now() - started,
        JSON.stringify(source.slice(0, 4))
      ).toBeLessThan(500);
    }
    expect(parseMarkdown("```sql\nSELECT 1\n```")).toEqual([
      { kind: "code", lang: "sql", text: "SELECT 1" },
    ]);
    expect(parseMarkdown("```  \nx\n  ```  ")).toEqual([
      { kind: "code", lang: "", text: "x" },
    ]);
    expect(parseMarkdown("``` not a fence")[0]).toMatchObject({
      kind: "paragraph",
    });
    expect(parseMarkdown("# Title\u2028more")[0]).toMatchObject({
      kind: "heading",
      level: 1,
    });
  });

  it("renders very long answers as plain text", () => {
    const source = "**x** ".repeat(MAX_MARKDOWN_CHARS / 5);
    const blocks = parseMarkdown(source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "paragraph" });
    expect(JSON.stringify(blocks)).not.toContain('"strong"');
  });

  it("still formats long ordinary answers", () => {
    const line =
      "The **orders** table has *12* columns; see `order_items` and [docs](https://x.dev). ";
    const source = line.repeat(1_500); // ~130k characters in one paragraph
    const started = performance.now();
    const nodes = parseInline(source);
    expect(performance.now() - started).toBeLessThan(500);
    expect(nodes.filter((n) => n.kind === "strong")).toHaveLength(1_500);
    expect(nodes.filter((n) => n.kind === "link")).toHaveLength(1_500);
  });
});
