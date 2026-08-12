import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "src/types";
import { AiAssistantMessageCard } from "./AiAssistantMessageCard";

const runSqlQueryMock = vi.fn();
const touchIdMock = vi.fn();

vi.mock("src/lib/tauri/query", () => ({
  runSqlQuery: (...args: unknown[]) => runSqlQueryMock(...args),
}));

vi.mock("src/lib/tauri/security", () => ({
  securityTouchIdAuthenticate: (...args: unknown[]) => touchIdMock(...args),
}));

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
    runSqlQueryMock.mockReset();
    touchIdMock.mockReset();
    touchIdMock.mockResolvedValue(true);
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
