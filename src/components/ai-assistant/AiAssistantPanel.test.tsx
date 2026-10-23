import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiAssistantPanel } from "./AiAssistantPanel";

const isGeneralChatPromptMock = vi.fn();
const chatReplyMock = vi.fn();
const confirmDialogMock = vi.fn();
const getDirectMetadataReplyMock = vi.fn();
const planAssistantTurnMock = vi.fn();
const isReadOnlySqlMock = vi.fn();
const answerFromResultMock = vi.fn();
const queryResultToObjectsMock = vi.fn();
const buildFastResultAnswerMock = vi.fn();
const getFastChatReplyMock = vi.fn();
const getAmbiguousPromptReplyMock = vi.fn();
const setSelectedAiProviderIdMock = vi.fn();
const getSelectedAiProviderIdMock = vi.fn();
const aiProviderListMock = vi.fn();
const aiLegacyModelInfoMock = vi.fn();

const runSqlQueryMock = vi.fn();

vi.mock("src/lib/ai-assistant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("src/lib/ai-assistant")>();

  return {
    ...actual,
    isGeneralChatPrompt: (...args: any[]) => isGeneralChatPromptMock(...args),
    chatReply: (...args: any[]) => chatReplyMock(...args),
    getDirectMetadataReply: (...args: any[]) =>
      getDirectMetadataReplyMock(...args),
    planAssistantTurn: (...args: any[]) => planAssistantTurnMock(...args),
    isReadOnlySql: (...args: any[]) => isReadOnlySqlMock(...args),
    answerFromResult: (...args: any[]) => answerFromResultMock(...args),
    queryResultToObjects: (...args: any[]) => queryResultToObjectsMock(...args),
    buildFastResultAnswer: (...args: any[]) =>
      buildFastResultAnswerMock(...args),
    getFastChatReply: (...args: any[]) => getFastChatReplyMock(...args),
    getAmbiguousPromptReply: (...args: any[]) =>
      getAmbiguousPromptReplyMock(...args),
  };
});

// These cases cover the legacy planner: the agent reports a model without tool support.
vi.mock("src/lib/ai-assistant/agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("src/lib/ai-assistant/agent")>();
  return {
    ...actual,
    runAgentTurn: async () => {
      throw new actual.AgentFallback("AI_AGENT_TOOLS_UNSUPPORTED");
    },
  };
});

vi.mock("src/lib/tauri/ai", () => ({
  aiChatCancel: vi.fn(),
  aiChatComplete: vi.fn(),
  aiProviderDelete: vi.fn(),
  aiProviderList: vi.fn(),
  aiProviderSave: vi.fn(),
  aiProviderListModels: vi.fn(),
  aiProviderCancelListModels: vi.fn(),
  aiProviderTestDraft: vi.fn(),
  aiLegacyModelInfo: (...args: any[]) => aiLegacyModelInfoMock(...args),
  aiLegacyModelDelete: vi.fn(),
}));

vi.mock("src/lib/tauri/query", () => ({
  runSqlQuery: (...args: any[]) => runSqlQueryMock(...args),
}));

vi.mock("@root/src/lib/ai-assistant/providers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("src/lib/ai-assistant/providers")>();
  return {
    ...actual,
    aiProviderList: (...args: any[]) => aiProviderListMock(...args),
    getSelectedAiProviderId: (...args: any[]) =>
      getSelectedAiProviderIdMock(...args),
    setSelectedAiProviderId: (...args: any[]) =>
      setSelectedAiProviderIdMock(...args),
  };
});

const LOCAL = {
  id: "ollama-1",
  kind: "ollama",
  label: "My Ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  defaultModel: "qwen2.5-7b-instruct",
  models: ["qwen2.5-7b-instruct"],
  enabled: true,
};

const LEGACY_BUNDLED = {
  id: "local",
  kind: "ollama",
  label: "PoliteDB AI",
  baseUrl: "http://127.0.0.1:50953/v1",
  defaultModel: "Qwen2.5-Coder-7B",
  models: ["Qwen2.5-Coder-7B"],
  enabled: true,
};

vi.mock("src/lib/system-dialog", () => ({
  confirmDialog: (...args: unknown[]) => confirmDialogMock(...args),
}));

vi.mock("src/components/ai-assistant/AiAssistantMessageCard", () => ({
  AiAssistantMessageCard: ({ message }: any) => (
    <div data-testid={`message-${message.role}`}>
      <div>{message.text}</div>
      {message.sql ? <pre>{message.sql}</pre> : null}
    </div>
  ),
}));

vi.mock("src/components/common/Popover", () => ({
  Popover: ({ children, content, open }: any) => (
    <div>
      {children}
      {open ? content : null}
    </div>
  ),
}));

vi.mock("src/components/common/Button", () => ({
  Button: ({ children, loading, ...props }: any) => (
    <button {...props} disabled={props.disabled || loading}>
      {children}
    </button>
  ),
}));

vi.mock("src/components/icons", () => ({
  ArrowDown: () => <span>arrow-down</span>,
  ArrowRightIcon: () => <span>arrow-right</span>,
  BackupIcon: () => <span>backup</span>,
  ChatPlusIcon: () => <span>new-chat</span>,
  ChevronDownIcon: () => <span>chevron-down</span>,
  ChevronRightIcon: () => <span>chevron-right</span>,
  DownloadIcon: () => <span>download</span>,
  MinusIcon: () => <span>minus</span>,
  MoreVerticalIcon: () => <span>more</span>,
  VaultIcon: () => <span>vault</span>,
  PlayIcon: () => <span>play</span>,
  RefreshCwIcon: () => <span>refresh</span>,
  StopIcon: () => <span>stop</span>,
  Settings: () => <span>settings</span>,
  SettingsIcon: () => <span>settings</span>,
  ShareIcon: () => <span>share</span>,
  SparklesIcon: () => <span>sparkles</span>,
  XIcon: () => <span>x</span>,
  ClockIcon: () => <span>clock</span>,
  EditIcon: () => <span>edit</span>,
  UnlockIcon: () => <span>unlock</span>,
}));

let renderSeq = 0;

function renderPanel(props: Record<string, unknown> = {}) {
  const chatSessionKey =
    typeof props.chatSessionKey === "string"
      ? props.chatSessionKey
      : `test-session-${++renderSeq}`;

  return render(
    <AiAssistantPanel
      chatSessionKey={chatSessionKey}
      engine="postgres"
      tables={[]}
      columnsByTable={{}}
      {...props}
    />
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });

  localStorage.clear();
  aiProviderListMock.mockResolvedValue([LOCAL]);
  getSelectedAiProviderIdMock.mockReturnValue("ollama-1");
  aiLegacyModelInfoMock.mockResolvedValue({ files: [] });
  isGeneralChatPromptMock.mockReturnValue(true);
  chatReplyMock.mockResolvedValue({
    answer: "Hello! How can I help?",
    followup: "Ask me about your data.",
  });
  getDirectMetadataReplyMock.mockReturnValue(null);
  planAssistantTurnMock.mockResolvedValue({
    kind: "chat",
    answer: "Hello! How can I help?",
    sql: "",
    explanation: "",
    assumptions: [],
    safety: "unknown",
    needsClarification: false,
    clarification: "",
  });
  isReadOnlySqlMock.mockReturnValue(true);
  answerFromResultMock.mockResolvedValue({
    answer: "There are 2 rows.",
    confidence: "high",
    highlights: [],
  });
  queryResultToObjectsMock.mockReturnValue([{ id: 1 }, { id: 2 }]);
  buildFastResultAnswerMock.mockReturnValue({
    answer:
      "I ran the query and found 2 row(s). Here is a preview of the result.",
    confidence: "high",
  });
  getFastChatReplyMock.mockReturnValue(null);
  getAmbiguousPromptReplyMock.mockReturnValue(null);
  runSqlQueryMock.mockResolvedValue({
    columns: [{ name: "id", db_type: "int4" }],
    rows: [[1], [2]],
    rowCount: 2,
  });
});

describe("AiAssistantPanel", () => {
  it("shows a setup state without requests when no provider is enabled", async () => {
    aiProviderListMock.mockResolvedValue([{ ...LOCAL, enabled: false }]);

    renderPanel({ presentation: "floating" });

    expect(screen.getByPlaceholderText("Ask anything...")).toBeInTheDocument();
    await waitFor(() =>
      expect(setSelectedAiProviderIdMock).toHaveBeenCalledWith("")
    );
    fireEvent.click(screen.getByRole("button", { name: "Select AI model" }));
    await screen.findByText("Add a provider in Settings to choose models.");

    const textarea = screen.getByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(chatReplyMock).not.toHaveBeenCalled();
  });

  it("opens AI settings from the panel header", async () => {
    renderPanel({ presentation: "panel" });

    fireEvent.click(await screen.findByTitle("AI settings"));
    await screen.findByText("AI Provider Settings");
    expect(screen.getAllByText("Ollama").length).toBeGreaterThan(0);
    expect(
      screen.queryByText("LM Studio / OpenAI-compatible")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Download model/ })
    ).not.toBeInTheDocument();
  });

  it("shows a dismissible notice for the removed built-in provider without changing it", async () => {
    aiProviderListMock.mockResolvedValue([LEGACY_BUNDLED, LOCAL]);

    renderPanel();

    await screen.findByText(/built-in AI was removed/);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(
        screen.queryByText(/built-in AI was removed/)
      ).not.toBeInTheDocument()
    );
    expect(
      localStorage.getItem("politedb.ai.legacyLocalNotice.dismissed")
    ).toBe("1");
  });

  it("does not silently switch providers when the selected one is unavailable", async () => {
    const cloud = {
      id: "openai-1",
      kind: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4.1-mini",
      models: ["gpt-4.1-mini"],
      enabled: true,
    };
    getSelectedAiProviderIdMock.mockReturnValue("local-gone");
    // Reloads after Continue stay pending, so only Continue itself can set the model.
    aiProviderListMock
      .mockResolvedValueOnce([cloud])
      .mockReturnValue(new Promise(() => {}));

    renderPanel();

    await screen.findByText(/no longer available\. Continue with OpenAI\?/);
    const textarea = screen.getByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(chatReplyMock).not.toHaveBeenCalled();
    expect(setSelectedAiProviderIdMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(setSelectedAiProviderIdMock).toHaveBeenCalledWith("openai-1");
    await waitFor(() =>
      expect(screen.queryByText(/no longer available/)).not.toBeInTheDocument()
    );
    fireEvent.input(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() =>
      expect(chatReplyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "openai-1",
          model: "gpt-4.1-mini",
        })
      )
    );
  });

  it("asks before continuing a chat whose original provider is gone", async () => {
    const key = "history-provider-test";
    localStorage.setItem(
      "politedb.ai.chat." + key,
      JSON.stringify({
        activeSessionId: "s1",
        sessions: [
          {
            id: "s1",
            title: "Old local chat",
            providerId: "local",
            messages: [{ id: "m1", role: "user", text: "old question" }],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      })
    );

    renderPanel({ chatSessionKey: key });

    await screen.findByText(/This chat was started with an AI provider/);
    const textarea = screen.getByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "next" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(chatReplyMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.input(textarea, { target: { value: "next" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(chatReplyMock).toHaveBeenCalled());
    expect(screen.getByText("old question")).toBeInTheDocument();
  });

  it("accepts an explicit model pick for a chat whose provider is gone", async () => {
    const key = "history-pick-test";
    localStorage.setItem(
      "politedb.ai.chat." + key,
      JSON.stringify({
        activeSessionId: "s1",
        sessions: [
          {
            id: "s1",
            title: "Old local chat",
            providerId: "local",
            messages: [{ id: "m1", role: "user", text: "old question" }],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      })
    );

    renderPanel({ chatSessionKey: key });

    await screen.findByText(/This chat was started with an AI provider/);
    fireEvent.click(screen.getByRole("button", { name: "Select AI model" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /qwen2\.5-7b-instruct/ })
    );
    await waitFor(() =>
      expect(
        screen.queryByText(/This chat was started with an AI provider/)
      ).not.toBeInTheDocument()
    );

    const textarea = screen.getByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "next" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() =>
      expect(chatReplyMock).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: "ollama-1" })
      )
    );
  });

  it("asks before switching when the selected provider is deleted in settings", async () => {
    const cloud = {
      id: "openai-1",
      kind: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4.1-mini",
      models: ["gpt-4.1-mini"],
      enabled: true,
    };
    aiProviderListMock.mockResolvedValue([LOCAL, cloud]);
    renderPanel();
    await screen.findByPlaceholderText("Ask anything...");
    await waitFor(() => expect(aiProviderListMock).toHaveBeenCalled());

    // Settings deleted the selected local provider and only broadcast the change.
    aiProviderListMock.mockResolvedValue([cloud]);
    window.dispatchEvent(new Event("politedb-ai-providers-changed"));

    await screen.findByText(/no longer available\. Continue with OpenAI\?/);
    const textarea = screen.getByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(chatReplyMock).not.toHaveBeenCalled();
    expect(setSelectedAiProviderIdMock).not.toHaveBeenCalledWith("openai-1");
  });

  it("accepts Auto as an explicit choice for a chat whose provider is gone", async () => {
    const key = "history-auto-test";
    localStorage.setItem(
      "politedb.ai.chat." + key,
      JSON.stringify({
        activeSessionId: "s1",
        sessions: [
          {
            id: "s1",
            title: "Old local chat",
            providerId: "local",
            messages: [{ id: "m1", role: "user", text: "old question" }],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      })
    );

    renderPanel({ chatSessionKey: key });

    await screen.findByText(/This chat was started with an AI provider/);
    fireEvent.click(screen.getByRole("button", { name: "Select AI model" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto/ }));
    await waitFor(() =>
      expect(
        screen.queryByText(/This chat was started with an AI provider/)
      ).not.toBeInTheDocument()
    );
    const textarea = screen.getByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "next" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(chatReplyMock).toHaveBeenCalled());
  });

  it("sends a general chat message and renders the assistant reply", async () => {
    renderPanel();

    const textarea = await screen.findByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await screen.findByText("hello");
    await screen.findByText(/Hello! How can I help\?/);
    expect(chatReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "ollama-1",
        model: "qwen2.5-7b-instruct",
      })
    );
  });

  it("opens the model picker and selects the local server model", async () => {
    renderPanel();

    await screen.findByPlaceholderText("Ask anything...");
    fireEvent.click(screen.getByRole("button", { name: "Select AI model" }));

    await screen.findByText("Select a model");
    expect(screen.getAllByText("qwen2.5-7b-instruct").length).toBeGreaterThan(
      0
    );
    fireEvent.click(
      screen.getByRole("button", { name: /qwen2\.5-7b-instruct/ })
    );

    expect(setSelectedAiProviderIdMock).toHaveBeenCalledWith("ollama-1");
  });

  it("previews a read-only SQL plan without running it automatically", async () => {
    isGeneralChatPromptMock.mockReturnValue(false);
    planAssistantTurnMock.mockResolvedValue({
      kind: "sql",
      answer: "Use a simple query.",
      sql: "SELECT id FROM users;",
      explanation: "Use a simple query.",
      assumptions: [],
      needsClarification: false,
      clarification: "",
    });

    renderPanel({ runtimeConnectionId: "conn_1" });

    const textarea = await screen.findByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "list users" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await screen.findByText("Use a simple query.");
    await screen.findByText("SELECT id FROM users;");
    expect(runSqlQueryMock).not.toHaveBeenCalled();
    expect(planAssistantTurnMock).toHaveBeenCalledTimes(1);
  });

  it("uses model chat outside a connection instead of generating SQL", async () => {
    renderPanel();

    const textarea = await screen.findByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "list users" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await screen.findByText(/Hello! How can I help\?/);
    expect(planAssistantTurnMock).not.toHaveBeenCalled();
    expect(chatReplyMock).toHaveBeenCalled();
    expect(runSqlQueryMock).not.toHaveBeenCalled();
  });

  it("does not offer stale connection context outside a connection", async () => {
    renderPanel();

    const textarea = await screen.findByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, {
      target: { value: "@", selectionStart: 1 },
    });

    await screen.findByText("Open a connection to add context");
    expect(screen.queryByText("Current connection")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Visible schema metadata")
    ).not.toBeInTheDocument();
  });

  it("answers metadata listing questions through model chat", async () => {
    renderPanel({
      activeSchema: "public",
      tables: [
        { schema: "public", name: "issues" },
        { schema: "public", name: "users" },
      ],
      runtimeConnectionId: "conn_1",
    });

    const textarea = await screen.findByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "list all tables for me" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await screen.findByText(/Hello! How can I help\?/);
    expect(planAssistantTurnMock).toHaveBeenCalledTimes(1);
    expect(chatReplyMock).not.toHaveBeenCalled();
    expect(runSqlQueryMock).not.toHaveBeenCalled();
  });

  it("keeps the resolved target table for a follow-up turn", async () => {
    planAssistantTurnMock
      .mockResolvedValueOnce({
        kind: "metadata",
        answer: "Users table selected.",
        targetTable: "public.users",
        sql: "",
        explanation: "",
        assumptions: [],
        safety: "unknown",
        needsClarification: false,
        clarification: "",
      })
      .mockResolvedValueOnce({
        kind: "metadata",
        answer: "The table has id and email columns.",
        targetTable: "public.users",
        sql: "",
        explanation: "",
        assumptions: [],
        safety: "unknown",
        needsClarification: false,
        clarification: "",
      });

    renderPanel({
      runtimeConnectionId: "conn_1",
      activeSchema: "public",
      tables: [{ schema: "public", name: "users" }],
      columnsByTable: { "public.users": ["id", "email"] },
    });

    const textarea = await screen.findByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "tell me about users" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await screen.findByText("Users table selected.");

    fireEvent.input(textarea, { target: { value: "show its structure" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await screen.findByText("The table has id and email columns.");

    expect(planAssistantTurnMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ targetTable: "public.users" })
    );
  });

  it("supports chat menu actions for rename, delete, history, and settings", async () => {
    renderPanel({ chatSessionKey: "menu-actions-test" });

    const textarea = await screen.findByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "first chat" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await screen.findByText("first chat");
    await screen.findByText(/Hello! How can I help\?/);

    fireEvent.click(screen.getByTitle("Chat menu"));
    expect(
      screen.queryByRole("button", { name: "New Chat" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear Chat" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete Chat" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename Chat" }));
    const renameInput = screen.getByRole("textbox", { name: "Chat name" });
    fireEvent.change(renameInput, { target: { value: "Renamed chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    fireEvent.click(screen.getByTitle("Chat menu"));
    fireEvent.click(screen.getByRole("button", { name: "History" }));

    await screen.findByText("Chat History");
    expect(screen.getByText("Renamed chat")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Chat menu"));
    fireEvent.click(screen.getByRole("button", { name: "Settings..." }));

    await screen.findByText("AI Provider Settings");
  });

  it("asks before deleting a chat, from the menu and from History", async () => {
    renderPanel({ chatSessionKey: "delete-confirm-test" });
    const textarea = await screen.findByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "keep me" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await screen.findByText(/Hello! How can I help\?/);

    confirmDialogMock.mockResolvedValue(false);
    fireEvent.click(screen.getByTitle("Chat menu"));
    fireEvent.click(screen.getByRole("button", { name: "Delete Chat" }));
    await waitFor(() => expect(confirmDialogMock).toHaveBeenCalledTimes(1));
    expect(confirmDialogMock.mock.calls[0][0]).toContain('"keep me"');
    expect(confirmDialogMock.mock.calls[0][1]).toMatchObject({
      okLabel: "Delete",
    });
    expect(screen.getByText("keep me")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Chat menu"));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await screen.findByText("Chat History");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(confirmDialogMock).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("keep me").length).toBeGreaterThan(0);

    confirmDialogMock.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.queryByText("keep me")).not.toBeInTheDocument()
    );
  });
});

describe("AiAssistantPanel composer", () => {
  it("focuses the prompt when the chat opens", async () => {
    renderPanel({ presentation: "floating" });
    const textarea = await screen.findByPlaceholderText("Ask anything...");
    expect(document.activeElement).toBe(textarea);
  });

  it("does not send on the Enter that ends an IME composition", async () => {
    renderPanel({ presentation: "floating" });
    const textarea = await screen.findByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "xin chào" } });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
    expect(textarea).toHaveValue("xin chào");
    expect(screen.queryByTestId("message-user")).not.toBeInTheDocument();
  });

  it("lets the next question be typed during an answer without sending it", async () => {
    planAssistantTurnMock.mockReturnValue(new Promise(() => {}));
    chatReplyMock.mockReturnValue(new Promise(() => {}));
    renderPanel({ presentation: "floating" });
    const textarea = await screen.findByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "first" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await screen.findByRole("button", { name: "Stop" });

    expect(textarea).not.toBeDisabled();
    fireEvent.input(textarea, { target: { value: "second" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea).toHaveValue("second");
    expect(screen.getAllByTestId("message-user")).toHaveLength(1);
    // Enter neither sends nor stops the running answer.
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("keeps focus inside History when its active chat is deleted", async () => {
    renderPanel({ presentation: "floating" });
    const textarea = await screen.findByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "older chat" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await screen.findByText(/Hello! How can I help\?/);
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    fireEvent.click(screen.getByTitle("Chat menu"));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await screen.findByText("Chat History");
    confirmDialogMock.mockResolvedValue(true);
    const deletes = screen.getAllByRole("button", { name: "Delete" });
    // Newest first: the empty chat just started is the active one.
    fireEvent.click(deletes[0]);

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1)
    );
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("older chat")
    );
    expect(document.activeElement).not.toBe(
      screen.getByPlaceholderText("Ask anything...")
    );

    // Picking a chat closes History and returns to the prompt.
    fireEvent.click(document.activeElement as HTMLElement);
    await waitFor(() =>
      expect(screen.queryByText("Chat History")).not.toBeInTheDocument()
    );
    expect(document.activeElement).toBe(
      screen.getByPlaceholderText("Ask anything...")
    );
  });
});
