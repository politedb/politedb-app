import { act, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPLAIN_ANALYZE_CONFIRMATION,
  EXPLAIN_ANALYZE_NOTES,
} from "src/lib/query-analyzer/explainAnalyzeMessages";
import {
  confirmExplainAnalyze,
  useExplainAnalyzeConfirmStore,
} from "src/stores/explainAnalyzeConfirm";
import { ExplainAnalyzeConfirmHost } from "./ExplainAnalyzeConfirmHost";

function ask() {
  let result: Promise<boolean>;
  act(() => {
    result = confirmExplainAnalyze({
      target: "Local PG",
      statement: "select * from users",
    });
  });
  return result!;
}

afterEach(() => {
  useExplainAnalyzeConfirmStore.getState().answer(false);
});

describe("ExplainAnalyzeConfirmHost", () => {
  it("shows the approved text, every note, the tab and the statement", () => {
    render(<ExplainAnalyzeConfirmHost />);
    void ask();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(EXPLAIN_ANALYZE_CONFIRMATION);
    for (const note of EXPLAIN_ANALYZE_NOTES) {
      expect(dialog.textContent).toContain(note);
    }
    expect(dialog.textContent).toContain("Local PG");
    expect(dialog.textContent).toContain("select * from users");
  });

  it("focuses Cancel, so Enter cancels", async () => {
    render(<ExplainAnalyzeConfirmHost />);
    const result = ask();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(document.activeElement as HTMLElement);
    await expect(result).resolves.toBe(false);
  });

  it("cancels on Escape", async () => {
    render(<ExplainAnalyzeConfirmHost />);
    const result = ask();
    fireEvent.keyDown(document, { key: "Escape" });
    await expect(result).resolves.toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("runs only on the explicit button", async () => {
    render(<ExplainAnalyzeConfirmHost />);
    const result = ask();
    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "Run Explain Analyze" })
      );
    });
    await expect(result).resolves.toBe(true);
  });

  it("a newer request cancels the older one", async () => {
    render(<ExplainAnalyzeConfirmHost />);
    const first = ask();
    void ask();
    await expect(first).resolves.toBe(false);
  });
});
