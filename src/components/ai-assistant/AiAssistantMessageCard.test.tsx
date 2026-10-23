import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { useState } from "preact/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "src/types";
import { AiAssistantMessageCard } from "./AiAssistantMessageCard";

const runSqlQueryMock = vi.fn();
const touchIdMock = vi.fn();
const sqlSafetyMock = vi.fn();
const calls: string[] = [];

vi.mock("src/lib/tauri/query", () => ({
  runSqlQuery: (...args: unknown[]) => runSqlQueryMock(...args),
}));

vi.mock("src/lib/tauri/security", () => ({
  securityTouchIdAuthenticate: (...args: unknown[]) => touchIdMock(...args),
}));

vi.mock("src/lib/tauri/aiAgent", () => ({
  aiAgentSqlSafety: (...args: unknown[]) => sqlSafetyMock(...args),
}));

const agentMessage: ChatMessage = {
  id: "assistant-2",
  role: "assistant",
  text: "Lowercase it.",
  parts: [
    {
      type: "sqlPreview",
      sql: "SELECT lower(1);",
      safety: "read_only",
      agent: true,
      confirmationState: "pending",
    },
  ],
};

const readOnlyMessage: ChatMessage = {
  id: "assistant-1",
  role: "assistant",
  text: "List users.",
  parts: [
    { type: "text", text: "List users." },
    {
      type: "sqlPreview",
      sql: "SELECT id, name FROM users;",
      safety: "read_only",
      confirmationState: "pending",
    },
  ],
};

function Harness(props: {
  initialMessage?: ChatMessage;
  runtimeConnectionId?: string;
  querySafetyMode?: "default" | "production";
}) {
  const [message, setMessage] = useState(
    props.initialMessage ?? readOnlyMessage
  );

  return (
    <AiAssistantMessageCard
      message={message}
      runtimeConnectionId={props.runtimeConnectionId}
      querySafetyMode={props.querySafetyMode}
      onUpdateMessage={(_, patch) =>
        setMessage((current) => ({ ...current, ...patch }))
      }
    />
  );
}

describe("AiAssistantMessageCard SQL preview", () => {
  beforeEach(() => {
    calls.length = 0;
    runSqlQueryMock.mockReset();
    touchIdMock.mockReset();
    touchIdMock.mockImplementation(async () => {
      calls.push("auth");
      return true;
    });
    sqlSafetyMock.mockReset();
    sqlSafetyMock.mockImplementation(async () => {
      calls.push("check");
      return "read_only";
    });
    runSqlQueryMock.mockResolvedValue({
      columns: [
        { name: "id", db_type: "int4" },
        { name: "name", db_type: "text" },
      ],
      rows: [
        [1, "Ada"],
        [2, "Linus"],
      ],
      rowCount: 2,
    });
  });

  it("runs read-only SQL and renders result in chat", async () => {
    render(<Harness runtimeConnectionId="conn-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await screen.findByText("Ada");
    expect(screen.getByText("Linus")).toBeInTheDocument();
    expect(runSqlQueryMock).toHaveBeenCalledWith(
      "conn-1",
      "SELECT id, name FROM users;",
      { maxRows: 100 }
    );
    expect(screen.getByText("2 row(s)")).toBeInTheDocument();
  });

  it("does not re-check legacy previews", async () => {
    render(<Harness runtimeConnectionId="conn-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("Ada");
    expect(sqlSafetyMock).not.toHaveBeenCalled();
  });

  it("re-checks an agent preview on the current connection after authenticating", async () => {
    // A saved chat reopened on another connection: the label is from back then.
    render(
      <Harness
        initialMessage={agentMessage}
        runtimeConnectionId="conn-2"
        querySafetyMode="production"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("Ada");
    expect(sqlSafetyMock).toHaveBeenCalledWith("SELECT lower(1);", "conn-2");
    expect(calls).toEqual(["auth", "check"]);
    expect(runSqlQueryMock).toHaveBeenCalledTimes(1);
  });

  it("does not run an agent preview the current catalog no longer allows", async () => {
    // e.g. a user overload of lower(integer) was created after the answer.
    sqlSafetyMock.mockResolvedValue("unknown");
    render(
      <Harness initialMessage={agentMessage} runtimeConnectionId="conn-1" />
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText(/can no longer be run from the assistant/);
    expect(runSqlQueryMock).not.toHaveBeenCalled();
  });

  it("does not show Run without an active connection", () => {
    render(<Harness />);
    expect(
      screen.queryByRole("button", { name: "Run" })
    ).not.toBeInTheDocument();
  });

  it("does not show Run for mutating SQL", () => {
    render(
      <Harness
        runtimeConnectionId="conn-1"
        initialMessage={{
          ...readOnlyMessage,
          parts: [
            {
              type: "sqlPreview",
              sql: "DELETE FROM users;",
              safety: "mutating",
            },
          ],
        }}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Run" })
    ).not.toBeInTheDocument();
  });

  it("authenticates before running a production read", async () => {
    render(
      <Harness runtimeConnectionId="conn-1" querySafetyMode="production" />
    );

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(runSqlQueryMock).toHaveBeenCalledTimes(1));
    expect(touchIdMock).toHaveBeenCalledWith(
      "Authenticate with Touch ID before reading production data."
    );
    expect(touchIdMock.mock.invocationCallOrder[0]).toBeLessThan(
      runSqlQueryMock.mock.invocationCallOrder[0]
    );
  });
});

describe("AiAssistantMessageCard floating header", () => {
  it("shows only Thinking while streaming, then how long it took", () => {
    const streaming: ChatMessage = {
      id: "a-stream",
      role: "assistant",
      text: "",
      streaming: true,
    };
    const { unmount } = render(<Harness initialMessage={streaming} />);
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
    expect(screen.queryByText("Thought")).not.toBeInTheDocument();
    expect(screen.queryByText("›")).not.toBeInTheDocument();
    unmount();

    render(
      <Harness
        initialMessage={{
          id: "a-done",
          role: "assistant",
          text: "Done.",
          durationMs: 4200,
        }}
      />
    );
    expect(screen.getByText("Worked for 4s")).toBeInTheDocument();
    expect(screen.queryByText("Thought")).not.toBeInTheDocument();
  });

  it("switches from Thinking to the duration in place", () => {
    const view = render(
      <AiAssistantMessageCard
        message={{ id: "a", role: "assistant", text: "", streaming: true }}
      />
    );
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
    view.rerender(
      <AiAssistantMessageCard
        message={{
          id: "a",
          role: "assistant",
          text: "Done.",
          durationMs: 65_000,
        }}
      />
    );
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(screen.getByText("Worked for 1m 5s")).toBeInTheDocument();
  });

  it("hides the duration while streaming text and for short or unknown durations", () => {
    const cases: ChatMessage[] = [
      {
        id: "s",
        role: "assistant",
        text: "Partial",
        streaming: true,
        durationMs: 5000,
      },
      { id: "n", role: "assistant", text: "Done." },
      { id: "f", role: "assistant", text: "Done.", durationMs: 999 },
    ];
    for (const message of cases) {
      const view = render(<Harness initialMessage={message} />);
      expect(screen.queryByText(/^Worked for/)).not.toBeInTheDocument();
      expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
      view.unmount();
    }
    render(
      <Harness
        initialMessage={{
          id: "b",
          role: "assistant",
          text: "Done.",
          durationMs: 1000,
        }}
      />
    );
    expect(screen.getByText("Worked for 1s")).toBeInTheDocument();
  });

  it("never shows how long a user message took", () => {
    render(
      <Harness
        initialMessage={{ id: "u", role: "user", text: "hi", durationMs: 3000 }}
      />
    );
    expect(screen.queryByText(/^Worked for/)).not.toBeInTheDocument();
  });
});

describe("AiAssistantMessageCard with several SQL previews", () => {
  const twoQueries: ChatMessage = {
    id: "assistant-3",
    role: "assistant",
    text: "Two options.",
    parts: [
      { type: "sqlPreview", sql: "SELECT 1;", safety: "read_only" },
      { type: "sqlPreview", sql: "SELECT 2;", safety: "read_only" },
    ],
  };

  beforeEach(() => {
    runSqlQueryMock.mockReset();
    runSqlQueryMock.mockResolvedValue({
      columns: [{ name: "n", db_type: "int4" }],
      rows: [[42]],
      rowCount: 1,
    });
  });

  it("runs, copies and shows the result for one block only", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      <Harness initialMessage={twoQueries} runtimeConnectionId="conn-1" />
    );
    const blocks = () =>
      Array.from(container.querySelectorAll("code")).map(
        (code) => code.closest(".rounded-lg.border") as HTMLElement
      );

    fireEvent.click(screen.getAllByRole("button", { name: "Run" })[1]);
    await screen.findByText("42");
    expect(runSqlQueryMock).toHaveBeenCalledWith("conn-1", "SELECT 2;", {
      maxRows: 100,
    });
    expect(blocks()[1]).toHaveTextContent("1 row(s)");
    expect(blocks()[0]).not.toHaveTextContent("row(s)");

    fireEvent.click(screen.getAllByTitle("Copy SQL")[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("SELECT 1;"));
    expect(screen.getAllByTitle("Copied!")).toHaveLength(1);
    expect(screen.getAllByTitle("Copy SQL")).toHaveLength(1);
  });

  it("shows a run error under the block that failed", async () => {
    runSqlQueryMock.mockRejectedValue(new Error("relation missing"));
    const { container } = render(
      <Harness initialMessage={twoQueries} runtimeConnectionId="conn-1" />
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Run" })[0]);
    await screen.findByText("relation missing");
    expect(screen.getAllByText("relation missing")).toHaveLength(1);
    const first = container
      .querySelectorAll("code")[0]
      .closest(".rounded-lg.border");
    expect(first).toHaveTextContent("relation missing");
  });

  it("keeps each block's copied tick for its own time", async () => {
    vi.useFakeTimers();
    const step = async (run: () => unknown) => {
      await act(async () => {
        run();
      });
    };
    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
      });
      render(<Harness initialMessage={twoQueries} />);
      const copyButtons = screen.getAllByTitle("Copy SQL");
      await step(() => fireEvent.click(copyButtons[0]));
      await step(() => vi.advanceTimersByTime(1000));
      await step(() => fireEvent.click(copyButtons[1]));
      expect(screen.getAllByTitle("Copied!")).toHaveLength(2);

      // Copy the second again: its first timer must not clear the new tick.
      await step(() => vi.advanceTimersByTime(600));
      expect(screen.getAllByTitle("Copied!")).toHaveLength(1);
      await step(() => fireEvent.click(screen.getAllByTitle("Copied!")[0]));
      await step(() => vi.advanceTimersByTime(1000));
      expect(screen.getAllByTitle("Copied!")).toHaveLength(1);
      await step(() => vi.advanceTimersByTime(600));
      expect(screen.queryByTitle("Copied!")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a saved result at the end when its part index is not valid", () => {
    for (const resultPartIndex of ["0", 1.5, 7, -1] as unknown[]) {
      const { container, unmount } = render(
        <Harness
          initialMessage={{
            ...twoQueries,
            resultPreview: [{ n: 99 }],
            rowCount: 1,
            resultPartIndex: resultPartIndex as number,
          }}
        />
      );
      expect(screen.getByText("99")).toBeInTheDocument();
      const sqlBlocks = Array.from(container.querySelectorAll("code"))
        .filter((code) => code.textContent?.startsWith("SELECT"))
        .map((code) => code.closest(".rounded-lg.border"));
      expect(sqlBlocks).toHaveLength(2);
      for (const block of sqlBlocks) {
        expect(block).not.toHaveTextContent("99");
      }
      unmount();
    }
  });

  it("keeps copy controls reachable from the keyboard", () => {
    render(<Harness initialMessage={twoQueries} />);
    const copySql = screen.getAllByRole("button", { name: "Copy SQL" })[0];
    // Revealed on hover or keyboard focus, never removed from the tab order.
    expect(copySql.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(copySql.className).toContain("focus-visible:opacity-100");
    const copyMessage = screen.getByRole("button", { name: "Copy message" });
    expect(copyMessage.parentElement?.className).toContain(
      "group-focus-within:opacity-100"
    );
  });

  it("shows wide results as row cards without column scroll buttons", () => {
    render(
      <Harness
        initialMessage={{
          ...twoQueries,
          resultPreview: [{ a: 1, b: 2, c: 3, d: 4 }],
          rowCount: 1,
        }}
      />
    );
    expect(screen.getByText("Row 1")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Next result columns" })
    ).not.toBeInTheDocument();
  });
});
