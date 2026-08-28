import { h } from "preact";
import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { TagSelect } from "./TagSelect";

describe("TagSelect", () => {
  it("keeps a fixed height and scrolls wrapped tags", () => {
    render(
      h(TagSelect, {
        label: "Primary",
        values: [
          "account_id",
          "uid",
          "message_id",
          "from_text",
          "subject",
          "to_text",
        ],
        onChange: () => {},
        options: [],
      })
    );

    const field = screen.getByText("account_id").closest("div")?.parentElement
      ?.parentElement as HTMLElement;
    expect(field.className).toMatch(/(?:^|\s)h-7(?:\s|$)/);
    expect(field.className).toContain("overflow-hidden");

    const scroller = screen.getByText("account_id").closest("div")
      ?.parentElement as HTMLElement;
    expect(scroller.className).toContain("overflow-y-auto");
    expect(screen.getByText("to_text")).toBeTruthy();
  });
});
