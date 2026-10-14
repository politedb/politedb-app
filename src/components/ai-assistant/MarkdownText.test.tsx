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
});
