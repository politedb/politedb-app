import { render } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { MarkdownText } from "./MarkdownText";

describe("MarkdownText", () => {
  it("renders formatting as elements and never as HTML", () => {
    const { container } = render(
      <MarkdownText
        text={
          "**Bold** and `code`\n\n- one\n- two\n\n<img src=x onerror=alert(1)> [site](https://evil.example/x)"
        }
      />
    );
    expect(container.querySelector("strong")?.textContent).toBe("Bold");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain("site (evil.example)");
  });

  it("leaves room for two-digit numbers and keeps the first number", () => {
    const items = Array.from({ length: 11 }, (_, i) => `${i + 1}. item`);
    const { container } = render(<MarkdownText text={items.join("\n")} />);
    const list = container.querySelector("ol") as HTMLOListElement;
    expect(list.querySelectorAll("li")).toHaveLength(11);
    expect(list.style.paddingLeft).toBe("calc(2ch + 1rem)");

    const later = render(<MarkdownText text={"3. three\n4. four"} />);
    const startAt = later.container.querySelector("ol") as HTMLOListElement;
    expect(startAt.getAttribute("start")).toBe("3");
    expect(startAt.style.paddingLeft).toBe("calc(1ch + 1rem)");

    const widest = render(<MarkdownText text={"999999999. a\n2. b"} />);
    const big = widest.container.querySelector("ol") as HTMLOListElement;
    expect(big.getAttribute("start")).toBe("999999999");
    expect(big.style.paddingLeft).toBe("calc(10ch + 1rem)");
  });
});
