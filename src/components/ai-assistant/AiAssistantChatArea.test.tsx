import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { createRef } from "preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatSession, AiProviderConfig } from "src/types";
import { AiAssistantChatArea } from "./AiAssistantChatArea";

vi.mock("src/components/ai-assistant/AiAssistantMessageCard", () => ({
  AiAssistantMessageCard: ({ message }: any) => <div>{message.text}</div>,
  AssistantStreamingPlaceholder: () => <div>Thinking...</div>,
}));

vi.mock("src/components/common/Popover", () => ({
  Popover: ({ children, content, open }: any) => (
    <div>
      {children}
      {open ? content : null}
    </div>
  ),
}));

const DAY = 24 * 60 * 60 * 1000;

const provider: AiProviderConfig = {
  id: "p1",
  kind: "ollama",
  label: "Local",
  defaultModel: "qwen",
  enabled: true,
};

function session(id: string, title: string, updatedAt: number): AiChatSession {
  return {
    id,
    scopeKey: "scope",
    title,
    messages: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

function renderArea(overrides: Record<string, unknown> = {}) {
  const props = {
    messages: [],
    messagesContainerRef: createRef<HTMLDivElement>(),
    messagesEndRef: createRef<HTMLDivElement>(),
    showScrollToBottom: false,
    onScrollToBottom: vi.fn(),
    submitting: false,
    prompt: "",
    onPromptChange: vi.fn(),
    onSubmit: vi.fn(),
    onCancelSubmit: vi.fn(),
    canSubmit: false,
    assistantStatus: "idle",
    onUpdateMessage: vi.fn(),
    providerLabel: "Local",
    providerModel: "qwen",
    providerOptions: [provider],
    activeProviderId: "p1",
    modelSelectionMode: "auto",
    onSelectAutoModel: vi.fn(),
    onSelectProviderModel: vi.fn(),
    contextOptions: [],
    onToggleContext: vi.fn(),
    chatSessions: [session("s1", "Current", Date.now())],
    activeSessionId: "s1",
    onNewChat: vi.fn(),
    onRenameSession: vi.fn(),
    onSwitchSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  } as any;
  return { props, ...render(<AiAssistantChatArea {...props} />) };
}

describe("AiAssistantChatArea", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists chats newest first under day headings", () => {
    const now = Date.now();
    renderArea({
      chatSessions: [
        session("old", "Last week", now - 8 * DAY),
        session("today", "This morning", now),
        session("yday", "Yesterday chat", now - DAY),
      ],
      activeSessionId: "today",
    });
    fireEvent.click(screen.getByRole("button", { name: /This morning/ }));

    // Labels appear in this order in the open list (after the title button).
    const list = document.body.textContent ?? "";
    let from = list.indexOf("Today");
    for (const label of [
      "This morning",
      "Yesterday",
      "Yesterday chat",
      "Last week",
    ]) {
      const at = list.indexOf(label, from + 1);
      expect(at, label).toBeGreaterThan(from);
      from = at;
    }
  });

  it("guides to AI settings when no provider is enabled", () => {
    const { props } = renderArea({
      providerOptions: [{ ...provider, enabled: false }],
    });
    expect(screen.getByText("Set up an AI provider")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open AI settings" }));
    expect(props.onOpenSettings).toHaveBeenCalled();
  });

  it("puts a suggestion in the prompt without sending it", () => {
    const { props } = renderArea({ runtimeConnectionId: "conn-1" });
    fireEvent.click(
      screen.getByRole("button", { name: "Which tables are the largest?" })
    );
    expect(props.onPromptChange).toHaveBeenCalledWith(
      "Which tables are the largest?"
    );
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByPlaceholderText("Ask anything...")
    );
  });

  it("mentions @ context only when context can be added", () => {
    renderArea();
    expect(screen.queryByText(/Type @ to add context/)).not.toBeInTheDocument();
    renderArea({
      contextOptions: [
        { id: "sql", label: "Current SQL", available: true, active: false },
      ],
    });
    expect(screen.getByText(/Type @ to add context/)).toBeInTheDocument();
  });

  it("copies the chat and says when copying fails", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderArea({
      messages: [{ id: "m1", role: "user", text: "hello" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy chat" }));
    await screen.findByText("Chat copied to clipboard");
    expect(writeText).toHaveBeenCalledWith("You: hello");

    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copy chat" }));
    await screen.findByText("Could not copy the chat");
  });

  it("shows the model status line only while a model loads", () => {
    const { rerender, props } = renderArea({ submitting: true });
    expect(screen.queryByText("Loading model...")).not.toBeInTheDocument();
    rerender(
      <AiAssistantChatArea
        {...props}
        submitting
        assistantStatus="loading_model"
      />
    );
    expect(screen.getByText("Loading model...")).toBeInTheDocument();
  });

  it("grows the prompt with its text", async () => {
    vi.spyOn(
      HTMLTextAreaElement.prototype,
      "scrollHeight",
      "get"
    ).mockReturnValue(140);
    renderArea({ prompt: "line 1\nline 2\nline 3\nline 4" });
    const textarea = screen.getByPlaceholderText("Ask anything...");
    await waitFor(() => expect(textarea.style.height).toBe("140px"));
    expect(textarea.className).toContain("max-h-50");
  });

  it("keeps the scroll-to-latest button above the composer", () => {
    renderArea({ showScrollToBottom: true });
    const button = screen.getByRole("button", {
      name: "Scroll to latest message",
    });
    expect(button.className).toContain("bottom-full");
    expect(
      button.parentElement?.contains(
        screen.getByPlaceholderText("Ask anything...")
      )
    ).toBe(true);
  });

  it("leaves focus on the scroll button when an answer ends", () => {
    const { props, rerender } = renderArea({
      submitting: true,
      showScrollToBottom: true,
    });
    const button = screen.getByRole("button", {
      name: "Scroll to latest message",
    });
    button.focus();
    rerender(<AiAssistantChatArea {...props} submitting={false} />);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Scroll to latest message" })
    );
  });

  it("returns focus to the prompt after Stop when an answer ends", () => {
    const { props, rerender } = renderArea({ submitting: true });
    const stop = screen.getByRole("button", { name: "Stop" });
    stop.focus();
    rerender(<AiAssistantChatArea {...props} submitting={false} />);
    expect(document.activeElement).toBe(
      screen.getByPlaceholderText("Ask anything...")
    );
  });

  it("picks @ context with the arrow keys and Enter", () => {
    const contextOptions = [
      { id: "connection", label: "Connection", available: true, active: false },
      { id: "sql", label: "Current SQL", available: true, active: false },
    ];
    const { props, rerender } = renderArea({ contextOptions });
    const textarea = screen.getByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "@" } });
    rerender(<AiAssistantChatArea {...props} prompt="@" />);
    expect(
      screen.getByRole("option", { name: "Current SQL" })
    ).toBeInTheDocument();
    expect(textarea).toHaveAttribute("aria-activedescendant", "ai-context-0");

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea).toHaveAttribute("aria-activedescendant", "ai-context-1");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(props.onToggleContext).toHaveBeenCalledWith("sql");
    expect(props.onPromptChange).toHaveBeenLastCalledWith("");
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("option", { name: "Current SQL" })
    ).not.toBeInTheDocument();
  });

  it("closes the @ menu with Escape and keeps the chat open", () => {
    const onClose = vi.fn();
    const { props, rerender } = renderArea({
      onClose,
      contextOptions: [
        { id: "sql", label: "Current SQL", available: true, active: false },
      ],
    });
    const textarea = screen.getByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "@" } });
    rerender(<AiAssistantChatArea {...props} prompt="@" />);
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(
      screen.queryByRole("option", { name: "Current SQL" })
    ).not.toBeInTheDocument();
    expect(props.onToggleContext).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("names its icon-only buttons", () => {
    renderArea({
      contextOptions: [
        { id: "sql", label: "Current SQL", available: true, active: true },
      ],
    });
    for (const name of [
      "Copy chat",
      "New chat",
      "Chat menu",
      "Minimize",
      "Remove Current SQL",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("ties the prompt to the @ list for screen readers", () => {
    const contextOptions = [
      { id: "connection", label: "Connection", available: true, active: false },
      { id: "sql", label: "Current SQL", available: true, active: false },
      { id: "metadata", label: "Tables", available: true, active: false },
    ];
    const { props, rerender } = renderArea({ contextOptions });
    const textarea = screen.getByPlaceholderText("Ask anything...");
    expect(textarea).toHaveAttribute("aria-haspopup", "listbox");
    expect(textarea).not.toHaveAttribute("aria-controls");
    fireEvent.input(textarea, { target: { value: "@" } });
    rerender(<AiAssistantChatArea {...props} prompt="@" />);

    const list = screen.getByRole("listbox");
    expect(textarea).toHaveAttribute("aria-controls", list.id);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    const active = document.getElementById(
      textarea.getAttribute("aria-activedescendant") ?? ""
    );
    expect(active).toHaveAttribute("role", "option");
    expect(active).toHaveAttribute("aria-selected", "true");
    expect(active).toHaveTextContent("Tables");
    expect(list.contains(active)).toBe(true);
  });

  it("keeps the highlighted @ item valid when context options shrink", () => {
    const three = [
      { id: "connection", label: "Connection", available: true, active: false },
      { id: "sql", label: "Current SQL", available: true, active: false },
      { id: "metadata", label: "Tables", available: true, active: false },
    ];
    const { props, rerender } = renderArea({ contextOptions: three });
    const textarea = screen.getByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "@" } });
    rerender(<AiAssistantChatArea {...props} prompt="@" />);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea).toHaveAttribute("aria-activedescendant", "ai-context-2");

    rerender(
      <AiAssistantChatArea {...props} prompt="@" contextOptions={[three[0]]} />
    );
    expect(textarea).toHaveAttribute("aria-activedescendant", "ai-context-0");
    expect(document.getElementById("ai-context-0")).toHaveAttribute(
      "aria-selected",
      "true"
    );

    rerender(<AiAssistantChatArea {...props} prompt="@" contextOptions={[]} />);
    expect(textarea).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(props.onToggleContext).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});
