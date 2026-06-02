import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiAssistantPanel } from "./AiAssistantPanel";

const getLocalAiSettingsMock = vi.fn();
const saveLocalAiSettingsMock = vi.fn();
const hasSeenLocalAiModelMock = vi.fn();
const markLocalAiModelSeenMock = vi.fn();
const listLocalAiModelsMock = vi.fn();
const isGeneralChatPromptMock = vi.fn();
const chatReplyMock = vi.fn();
const getDirectMetadataReplyMock = vi.fn();
const planSqlFromQuestionMock = vi.fn();
const isReadOnlySqlMock = vi.fn();
const answerFromResultMock = vi.fn();
const queryResultToObjectsMock = vi.fn();
const buildFastResultAnswerMock = vi.fn();
const getFastChatReplyMock = vi.fn();
const getAmbiguousPromptReplyMock = vi.fn();

const aiRuntimeStatusMock = vi.fn();
const aiRuntimeDownloadDefaultModelMock = vi.fn();
const aiRuntimeCancelModelDownloadMock = vi.fn();
const aiRuntimeStartMock = vi.fn();
const aiRuntimeStopMock = vi.fn();

const runSqlQueryMock = vi.fn();

vi.mock("src/lib/ai-assistant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("src/lib/ai-assistant")>();

  return {
    ...actual,
    getLocalAiSettings: (...args: any[]) => getLocalAiSettingsMock(...args),
    saveLocalAiSettings: (...args: any[]) => saveLocalAiSettingsMock(...args),
    hasSeenLocalAiModel: (...args: any[]) => hasSeenLocalAiModelMock(...args),
    markLocalAiModelSeen: (...args: any[]) => markLocalAiModelSeenMock(...args),
    listLocalAiModels: (...args: any[]) => listLocalAiModelsMock(...args),
    isGeneralChatPrompt: (...args: any[]) => isGeneralChatPromptMock(...args),
    chatReply: (...args: any[]) => chatReplyMock(...args),
    getDirectMetadataReply: (...args: any[]) =>
      getDirectMetadataReplyMock(...args),
    planSqlFromQuestion: (...args: any[]) => planSqlFromQuestionMock(...args),
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

vi.mock("src/lib/tauri", () => ({
  aiRuntimeStatus: (...args: any[]) => aiRuntimeStatusMock(...args),
  aiRuntimeCancelModelDownload: (...args: any[]) =>
    aiRuntimeCancelModelDownloadMock(...args),
  aiRuntimeDownloadDefaultModel: (...args: any[]) =>
    aiRuntimeDownloadDefaultModelMock(...args),
  aiRuntimeStart: (...args: any[]) => aiRuntimeStartMock(...args),
  aiRuntimeStop: (...args: any[]) => aiRuntimeStopMock(...args),
}));

vi.mock("src/lib/tauri/query", () => ({
  runSqlQuery: (...args: any[]) => runSqlQueryMock(...args),
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
  ChevronDownIcon: () => <span>chevron-down</span>,
  Settings: () => <span>settings</span>,
  SettingsIcon: () => <span>settings</span>,
}));

function status(overrides: Record<string, unknown> = {}) {
  return {
    phase: "stopped",
    endpoint: null,
    model_name: null,
    server_bin: "/tmp/llama-server",
    model_path: null,
    pid: null,
    managed_by_app: true,
    missing: [],
    last_error: null,
    model_downloaded_bytes: null,
    model_total_bytes: null,
    ...overrides,
  };
}

function missingModelStatus(overrides: Record<string, unknown> = {}) {
  return status({
    phase: "missing",
    missing: [
      "Missing GGUF model. Set POLITEDB_LLM_MODEL_PATH or place default.gguf in the app data folder under ai/models/default.gguf",
    ],
    ...overrides,
  });
}

function mockMissingModelStatus() {
  aiRuntimeStatusMock.mockImplementation(() =>
    Promise.resolve(missingModelStatus())
  );
}

function pendingPromise<T>() {
  return new Promise<T>(() => {});
}

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

  getLocalAiSettingsMock.mockReturnValue({
    endpoint: "http://127.0.0.1:8080/v1",
    model: "qwen2.5-coder:7b",
  });
  hasSeenLocalAiModelMock.mockReturnValue(false);
  listLocalAiModelsMock.mockResolvedValue(["qwen2.5-coder:7b"]);
  isGeneralChatPromptMock.mockReturnValue(true);
  chatReplyMock.mockResolvedValue({
    answer: "Hello! How can I help?",
    followup: "Ask me about your data.",
  });
  getDirectMetadataReplyMock.mockReturnValue(null);
  planSqlFromQuestionMock.mockResolvedValue({
    sql: "",
    explanation: "",
    assumptions: [],
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
  aiRuntimeStatusMock.mockResolvedValue(
    status({
      phase: "ready",
      endpoint: "http://127.0.0.1:8080/v1",
      model_name: "qwen2.5-coder:7b",
    })
  );
  aiRuntimeDownloadDefaultModelMock.mockResolvedValue(
    status({
      phase: "stopped",
      model_name: "default",
      model_path: "/tmp/default.gguf",
    })
  );
  aiRuntimeCancelModelDownloadMock.mockResolvedValue(
    status({
      phase: "missing",
      missing: [
        "Missing GGUF model. Set POLITEDB_LLM_MODEL_PATH or place default.gguf in the app data folder under ai/models/default.gguf",
      ],
      last_error: "AI model download canceled.",
    })
  );
  aiRuntimeStartMock.mockResolvedValue(
    status({
      phase: "ready",
      endpoint: "http://127.0.0.1:8080/v1",
      model_name: "qwen2.5-coder:7b",
      model_path: "/tmp/default.gguf",
    })
  );
  aiRuntimeStopMock.mockResolvedValue(
    status({
      phase: "stopped",
    })
  );
  runSqlQueryMock.mockResolvedValue({
    columns: [{ name: "id", db_type: "int4" }],
    rows: [[1], [2]],
    rowCount: 2,
  });
});

describe("AiAssistantPanel", () => {
  it("shows missing model state on first launch and downloads only after user action", async () => {
    mockMissingModelStatus();

    renderPanel();

    await screen.findByText("Missing AI model");
    expect(aiRuntimeDownloadDefaultModelMock).not.toHaveBeenCalled();
    expect(aiRuntimeStartMock).not.toHaveBeenCalled();

    const downloadedStatus = status({
      phase: "stopped",
      model_name: "default",
      model_path: "/tmp/default.gguf",
      missing: [],
    });

    aiRuntimeDownloadDefaultModelMock.mockResolvedValueOnce(downloadedStatus);
    aiRuntimeStatusMock.mockResolvedValue(downloadedStatus);
    aiRuntimeStartMock.mockResolvedValue(
      status({
        phase: "ready",
        endpoint: "http://127.0.0.1:8080/v1",
        model_name: "qwen2.5-coder:7b",
        model_path: "/tmp/default.gguf",
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Download model" }));

    await waitFor(() =>
      expect(aiRuntimeDownloadDefaultModelMock).toHaveBeenCalledTimes(1)
    );
    await waitFor(() => expect(aiRuntimeStartMock).toHaveBeenCalledTimes(1));
    expect(markLocalAiModelSeenMock).toHaveBeenCalled();
  });

  it("does not download the missing model when retrying runtime setup", async () => {
    mockMissingModelStatus();

    renderPanel();

    await screen.findByText("Missing AI model");
    expect(aiRuntimeDownloadDefaultModelMock).not.toHaveBeenCalled();
    expect(aiRuntimeStartMock).not.toHaveBeenCalled();
  });

  it("shows cancel while the model download is running", async () => {
    mockMissingModelStatus();
    aiRuntimeDownloadDefaultModelMock.mockReturnValueOnce(pendingPromise());

    renderPanel();

    await screen.findByText("Missing AI model");
    fireEvent.click(screen.getByRole("button", { name: "Download model" }));

    await screen.findByText("Downloading local AI model");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(aiRuntimeCancelModelDownloadMock).toHaveBeenCalledTimes(1)
    );
  });

  it("shows retry only after model download fails", async () => {
    mockMissingModelStatus();
    aiRuntimeDownloadDefaultModelMock.mockRejectedValueOnce(
      new Error("AI_MODEL_DOWNLOAD_FAILED: network error")
    );

    renderPanel();

    await screen.findByText("Missing AI model");
    fireEvent.click(screen.getByRole("button", { name: "Download model" }));

    await screen.findByRole("button", { name: "Retry" });
    expect(
      screen.queryByRole("button", { name: "Cancel" })
    ).not.toBeInTheDocument();
  });

  it("starts runtime automatically when runtime assets are available", async () => {
    aiRuntimeStatusMock.mockResolvedValueOnce(
      status({
        phase: "stopped",
        model_name: "default",
        model_path: "/tmp/default.gguf",
      })
    );

    renderPanel();

    await waitFor(() => expect(aiRuntimeStartMock).toHaveBeenCalledTimes(1));
    expect(aiRuntimeDownloadDefaultModelMock).not.toHaveBeenCalled();
  });

  it("sends a general chat message and renders the assistant reply", async () => {
    renderPanel();

    const textarea = await screen.findByPlaceholderText(
      "Ask AI about data, or ask it to write SQL for you..."
    );
    fireEvent.input(textarea, { target: { value: "hello" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled()
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("hello");
    await screen.findByText(/Hello! How can I help\?/);
    expect(saveLocalAiSettingsMock).toHaveBeenCalledWith({
      endpoint: "http://127.0.0.1:8080/v1",
      model: "qwen2.5-coder:7b",
    });
  });

  it("runs a read-only SQL plan and renders the answer from real data", async () => {
    isGeneralChatPromptMock.mockReturnValue(false);
    planSqlFromQuestionMock.mockResolvedValue({
      sql: "SELECT id FROM users;",
      explanation: "Use a simple query.",
      assumptions: [],
      needsClarification: false,
      clarification: "",
    });

    renderPanel({ runtimeConnectionId: "conn_1" });

    const textarea = await screen.findByPlaceholderText(
      "Ask AI about data, or ask it to write SQL for you..."
    );
    fireEvent.input(textarea, { target: { value: "list users" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled()
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(runSqlQueryMock).toHaveBeenCalledWith(
        "conn_1",
        "SELECT id FROM users;",
        {
          maxRows: 200,
          batchSize: 200,
          timeoutMs: 45_000,
        }
      )
    );

    await screen.findByText("There are 2 rows.");
  });

  it("answers metadata listing questions directly without generating SQL", async () => {
    isGeneralChatPromptMock.mockReturnValue(false);
    getDirectMetadataReplyMock.mockReturnValue({
      answer: "I can currently see 2 table(s) in public: issues, users.",
    });

    renderPanel({
      activeSchema: "public",
      tables: [
        { schema: "public", name: "issues" },
        { schema: "public", name: "users" },
      ],
      runtimeConnectionId: "conn_1",
    });

    const textarea = await screen.findByPlaceholderText(
      "Ask AI about data, or ask it to write SQL for you..."
    );
    fireEvent.input(textarea, { target: { value: "list all tables for me" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled()
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText(
      "I can currently see 2 table(s) in public: issues, users."
    );
    expect(planSqlFromQuestionMock).not.toHaveBeenCalled();
    expect(runSqlQueryMock).not.toHaveBeenCalled();
  });
});
