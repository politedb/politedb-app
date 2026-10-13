import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
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
      presentation="floating"
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
        presentation="floating"
        message={{ id: "a", role: "assistant", text: "", streaming: true }}
      />
    );
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
    view.rerender(
      <AiAssistantMessageCard
        presentation="floating"
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

  it("keeps the panel layout and never labels user messages", () => {
    const view = render(
      <AiAssistantMessageCard
        presentation="panel"
        message={{
          id: "p",
          role: "assistant",
          text: "Done.",
          durationMs: 3000,
        }}
      />
    );
    // Panel shows its own role label and a single duration line.
    expect(screen.getByText("PoliteDB AI")).toBeInTheDocument();
    expect(screen.getAllByText("Worked for 3s")).toHaveLength(1);
    view.unmount();

    render(
      <Harness
        initialMessage={{ id: "u", role: "user", text: "hi", durationMs: 3000 }}
      />
    );
    expect(screen.queryByText(/^Worked for/)).not.toBeInTheDocument();
  });
});
