import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { AgentStepsPart } from "./AiAssistantMessageParts";

describe("AgentStepsPart", () => {
  it("summarises steps with fixed labels only", () => {
    render(
      <AgentStepsPart
        steps={[
          { tool: "list_tables", ok: true, truncated: true, durationMs: 3 },
          {
            tool: "describe_table",
            ok: false,
            truncated: false,
            durationMs: 1,
          },
          { tool: "something_new", ok: true, truncated: false, durationMs: 1 },
        ]}
      />
    );
    expect(screen.getByText(/Checked the database \(3 steps\)/)).toBeTruthy();
    expect(screen.getByText(/Listed tables \(partial\)/)).toBeTruthy();
    expect(
      screen.getByText(/Looked at a table's structure \(failed\)/)
    ).toBeTruthy();
    expect(screen.getByText("Used a database tool")).toBeTruthy();
  });

  it("renders nothing without steps", () => {
    const { container } = render(<AgentStepsPart steps={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
