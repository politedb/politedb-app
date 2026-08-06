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
const setSelectedAiProviderIdMock = vi.fn();

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

vi.mock("src/lib/aiProviders", () => ({
  DEFAULT_LOCAL_AI_PROVIDER_ID: "local",
  normalizeAiProviderConfig: (provider: any) => provider,
  ensureLocalAiProvider: vi.fn().mockResolvedValue({
    id: "local",
    kind: "local_openai_compatible",
    label: "Local API",
    baseUrl: "http://127.0.0.1:8080/v1",
    defaultModel: "qwen2.5-coder:7b",
    enabled: true,
  }),
  getSelectedAiProviderId: vi.fn(() => "local"),
  setSelectedAiProviderId: (...args: any[]) =>
    setSelectedAiProviderIdMock(...args),
  makeDefaultAiProvider: (kind: string, overrides: any = {}) => ({
    id: overrides.id ?? kind,
    kind,
    label: overrides.label ?? kind,
    defaultModel: overrides.defaultModel ?? "model",
    enabled: true,
    ...overrides,
  }),
  saveAiProviderWithOptionalKey: vi.fn(async ({ config }: any) => config),
  aiProviderTest: vi.fn(),
  aiProviderDelete: vi.fn(),
  buildBaseUrl: (host: string, subPath: string) => `${host}${subPath}`,
  AI_PROVIDER_LABELS: {
    ollama: "Ollama",
    local_openai_compatible: "Local API",
  },
  DEFAULT_HOSTS: {
    ollama: "http://127.0.0.1:11434",
    local_openai_compatible: "http://127.0.0.1:11434",
  },
  DEFAULT_SUB_PATHS: {
    ollama: "/v1",
    local_openai_compatible: "/v1",
  },
  DEFAULT_MODELS: {
    ollama: "qwen2.5-coder:7b",
    local_openai_compatible: "qwen2.5-coder:7b",
  },
  aiProviderList: vi.fn().mockResolvedValue([
    {
      id: "local",
      kind: "local_openai_compatible",
      label: "Local API",
      baseUrl: "http://127.0.0.1:8080/v1",
      defaultModel: "qwen2.5-coder:7b",
      enabled: true,
    },
  ]),
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
  BackupIcon: () => <span>backup</span>,
  ChevronDownIcon: () => <span>chevron-down</span>,
  MoreVerticalIcon: () => <span>more</span>,
  VaultIcon: () => <span>vault</span>,
  PlayIcon: () => <span>play</span>,
  RefreshCwIcon: () => <span>refresh</span>,
  StopIcon: () => <span>stop</span>,
  Settings: () => <span>settings</span>,
  SettingsIcon: () => <span>settings</span>,
  SparklesIcon: () => <span>sparkles</span>,
  XIcon: () => <span>x</span>,
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

    const textarea = await screen.findByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await screen.findByText("hello");
    await screen.findByText(/Hello! How can I help\?/);
    expect(saveLocalAiSettingsMock).toHaveBeenCalledWith({
      endpoint: "http://127.0.0.1:8080/v1",
      model: "qwen2.5-coder:7b",
    });
  });

  it("opens the model picker and selects the local model", async () => {
    renderPanel();

    await screen.findByPlaceholderText("Ask anything...");
    fireEvent.click(screen.getByRole("button", { name: "Select AI model" }));

    await screen.findByText("Select a model");
    expect(screen.getAllByText("qwen2.5-coder:7b").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /qwen2\.5-coder:7b/ }));

    expect(setSelectedAiProviderIdMock).toHaveBeenCalledWith("local");
  });

  it("previews a read-only SQL plan without running it automatically", async () => {
    isGeneralChatPromptMock.mockReturnValue(false);
    planSqlFromQuestionMock.mockResolvedValue({
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

    const textarea = await screen.findByPlaceholderText("Ask anything...");
    fireEvent.input(textarea, { target: { value: "list all tables for me" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await screen.findByText(
      "I can currently see 2 table(s) in public: issues, users."
    );
    expect(planSqlFromQuestionMock).not.toHaveBeenCalled();
    expect(runSqlQueryMock).not.toHaveBeenCalled();
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

    const promptSpy = vi
      .spyOn(window, "prompt")
      .mockReturnValue("Renamed chat");
    fireEvent.click(screen.getByRole("button", { name: "Rename Chat" }));
    expect(promptSpy).toHaveBeenCalledWith("Rename chat", "first chat");
    promptSpy.mockRestore();

    fireEvent.click(screen.getByTitle("Chat menu"));
    fireEvent.click(screen.getByRole("button", { name: "History" }));

    await screen.findByText("Chat History");
    expect(screen.getByText("Renamed chat")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Chat menu"));
    fireEvent.click(screen.getByRole("button", { name: "Settings.." }));

    await screen.findByText("AI Provider Settings");
  });
});
