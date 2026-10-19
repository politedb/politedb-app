import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { renderHook, act } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "src/types";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("src/lib/tauri/aiAgent", () => ({
  aiAgentDataAccessList: (...a: unknown[]) => mocks.list(...a),
  aiAgentDataAccessRevoke: (...a: unknown[]) => mocks.revoke(...a),
  aiAgentSqlSafety: async () => "unknown",
}));
vi.mock("src/lib/tauri/query", () => ({ runSqlQuery: vi.fn() }));
vi.mock("src/lib/tauri/security", () => ({
  securityTouchIdAuthenticate: vi.fn(),
}));

import { useScreenStore } from "src/stores/screen";
import { AiAssistantMessageCard } from "./AiAssistantMessageCard";
import { AgentStepsPart } from "./AiAssistantMessageParts";
import { AiDataAccessList } from "./AiDataAccessList";
import {
  rememberAiChatOwner,
  useAiChatSession,
} from "./hooks/useAiChatSession";

const request: ChatMessage = {
  id: "m1",
  role: "assistant",
  text: "To answer, the AI needs to read data from Shop DB.",
  parts: [
    {
      type: "text",
      text: "To answer, the AI needs to read data from Shop DB.",
    },
    {
      type: "dataAccessRequest",
      question: "top customers?",
      label: "Shop DB",
      state: "pending",
    },
  ],
};

function Card(props: { onAllow: (q: string) => Promise<boolean> }) {
  const [message, setMessage] = useState(request);
  return (
    <AiAssistantMessageCard
      message={message}
      runtimeConnectionId="conn-1"
      onUpdateMessage={(_, patch) => setMessage((m) => ({ ...m, ...patch }))}
      onAllowDataAccess={props.onAllow}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("data access request", () => {
  it("allows once and asks the question again", async () => {
    const onAllow = vi.fn().mockResolvedValue(true);
    render(<Card onAllow={onAllow} />);
    expect(
      screen.getByText("Allow AI to read data from Shop DB?")
    ).toBeInTheDocument();
    // AI settings no longer list grants, so the card must not point there.
    expect(screen.queryByText(/revoke this in AI settings/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onAllow).toHaveBeenCalledWith("top customers?");
    await screen.findByText("Allowed.");
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("stays pending when the permission could not be saved", async () => {
    const onAllow = vi.fn().mockResolvedValue(false);
    render(<Card onAllow={onAllow} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(onAllow).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(screen.queryByText("Allowed.")).toBeNull();
  });

  it("saves once: no second answer while the permission is saving", async () => {
    let finish: (saved: boolean) => void = () => {};
    const onAllow = vi.fn(
      () => new Promise<boolean>((resolve) => (finish = resolve))
    );
    render(<Card onAllow={onAllow} />);
    const allow = screen.getByRole("button", { name: "Allow" });
    const notNow = screen.getByRole("button", { name: "Not now" });
    fireEvent.click(allow);
    fireEvent.click(allow);
    fireEvent.click(notNow);
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Not allowed.")).toBeNull();
    finish(true);
    await screen.findByText("Allowed.");
  });

  it("not now leaves data access off", () => {
    const onAllow = vi.fn().mockResolvedValue(true);
    render(<Card onAllow={onAllow} />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onAllow).not.toHaveBeenCalled();
    expect(screen.getByText("Not allowed.")).toBeInTheDocument();
  });

  it("labels the data steps", () => {
    render(
      <AgentStepsPart
        steps={[
          { tool: "sample_rows", ok: true, truncated: false, durationMs: 1 },
          {
            tool: "run_readonly_query",
            ok: true,
            truncated: true,
            durationMs: 1,
          },
          { tool: "explain_query", ok: false, truncated: false, durationMs: 1 },
        ]}
      />
    );
    expect(screen.getByText("Read sample rows")).toBeInTheDocument();
    expect(screen.getByText(/Ran a read-only query/)).toBeInTheDocument();
    expect(screen.getByText(/Checked a query plan/)).toBeInTheDocument();
  });
});

describe("revoking data access", () => {
  it("revokes, then deletes the chat history of that connection's tabs", async () => {
    mocks.list
      .mockResolvedValueOnce([
        {
          profileId: "p1",
          profileLabel: "Shop DB",
          providerLabel: "OpenAI",
          endpointHost: "api.openai.com",
          grantedAt: 1,
        },
      ])
      .mockResolvedValue([]);
    mocks.revoke.mockResolvedValue(undefined);
    useScreenStore.setState({
      profileTabs: [
        { id: "tab-shop", profileId: "p1" } as any,
        { id: "tab-other", profileId: "p2" } as any,
      ],
    });
    // Both tabs have a chat; the shop tab's is mounted.
    const shop = renderHook(() => useAiChatSession("tab-shop"));
    act(() => shop.result.current.appendUserMessage("secret question"));
    const other = renderHook(() => useAiChatSession("tab-other"));
    act(() => other.result.current.appendUserMessage("keep me"));
    await waitFor(() =>
      expect(localStorage.getItem("politedb.ai.chat.tab-shop")).toContain(
        "secret question"
      )
    );

    // A tab of the same connection that was closed earlier.
    rememberAiChatOwner("tab-closed", "p1");
    localStorage.setItem(
      "politedb.ai.chat.tab-closed",
      JSON.stringify({
        sessions: [
          {
            id: "s",
            messages: [{ id: "x", role: "assistant", text: "closed tab data" }],
          },
        ],
      })
    );

    render(<AiDataAccessList />);
    await screen.findByText(/Shop DB → OpenAI/);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith("p1"));
    await screen.findByText("No connection allowed yet.");
    await waitFor(() => expect(shop.result.current.messages).toHaveLength(0));
    expect(
      localStorage.getItem("politedb.ai.chat.tab-shop") ?? ""
    ).not.toContain("secret question");
    expect(other.result.current.messages.map((m) => m.text)).toEqual([
      "keep me",
    ]);
    expect(localStorage.getItem("politedb.ai.chat.tab-closed")).toBeNull();
  });
});

describe("chat history ownership", () => {
  it("editing a connection removes its chats that hold data, and only those", async () => {
    const { PROFILE_CHANGED_EVENT } = await import("src/lib/tauri/profile");
    rememberAiChatOwner("tab-data", "p9");
    rememberAiChatOwner("tab-plain", "p9");
    localStorage.setItem(
      "politedb.ai.chat.tab-data",
      JSON.stringify({
        sessions: [
          {
            id: "s",
            messages: [
              { id: "x", role: "assistant", text: "rows", dataRead: true },
            ],
          },
        ],
      })
    );
    localStorage.setItem(
      "politedb.ai.chat.tab-plain",
      JSON.stringify({
        sessions: [
          { id: "s", messages: [{ id: "y", role: "user", text: "hi" }] },
        ],
      })
    );
    window.dispatchEvent(
      new CustomEvent(PROFILE_CHANGED_EVENT, { detail: "p9" })
    );
    expect(localStorage.getItem("politedb.ai.chat.tab-data")).toBeNull();
    expect(localStorage.getItem("politedb.ai.chat.tab-plain")).toContain("hi");
  });

  it("a purged tab that chats again is still purged by a later revoke", async () => {
    mocks.list.mockResolvedValue([
      {
        profileId: "p1",
        profileLabel: "Shop DB",
        providerLabel: "OpenAI",
        endpointHost: "api.openai.com",
        grantedAt: 1,
      },
    ]);
    mocks.revoke.mockResolvedValue(undefined);
    useScreenStore.setState({ profileTabs: [] });
    rememberAiChatOwner("tab-reused", "p1");
    const { purgeAiChatScopes } = await import("./hooks/useAiChatSession");
    purgeAiChatScopes(["tab-reused"]);
    // The same (now closed) tab chatted again after the first revoke.
    localStorage.setItem(
      "politedb.ai.chat.tab-reused",
      JSON.stringify({ sessions: [{ id: "s", messages: [] }] })
    );
    render(<AiDataAccessList />);
    await screen.findByText(/Shop DB → OpenAI/);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(localStorage.getItem("politedb.ai.chat.tab-reused")).toBeNull()
    );
  });
});
