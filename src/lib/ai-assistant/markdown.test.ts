import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

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
});
