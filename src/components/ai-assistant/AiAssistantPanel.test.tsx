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
const planSqlFromQuestionMock = vi.fn();
const isReadOnlySqlMock = vi.fn();
const answerFromResultMock = vi.fn();
const queryResultToObjectsMock = vi.fn();

const aiRuntimeStatusMock = vi.fn();
const aiRuntimeDownloadDefaultModelMock = vi.fn();
const aiRuntimeStartMock = vi.fn();
const aiRuntimeStopMock = vi.fn();

const runSqlQueryMock = vi.fn();

vi.mock("src/lib/ai/localAssistant", () => ({
  getLocalAiSettings: (...args: any[]) => getLocalAiSettingsMock(...args),
  saveLocalAiSettings: (...args: any[]) => saveLocalAiSettingsMock(...args),
  hasSeenLocalAiModel: (...args: any[]) => hasSeenLocalAiModelMock(...args),
  markLocalAiModelSeen: (...args: any[]) => markLocalAiModelSeenMock(...args),
  listLocalAiModels: (...args: any[]) => listLocalAiModelsMock(...args),
  isGeneralChatPrompt: (...args: any[]) => isGeneralChatPromptMock(...args),
  chatReply: (...args: any[]) => chatReplyMock(...args),
  planSqlFromQuestion: (...args: any[]) => planSqlFromQuestionMock(...args),
  isReadOnlySql: (...args: any[]) => isReadOnlySqlMock(...args),
  answerFromResult: (...args: any[]) => answerFromResultMock(...args),
  queryResultToObjects: (...args: any[]) => queryResultToObjectsMock(...args),
}));

vi.mock("src/lib/tauri", () => ({
  aiRuntimeStatus: (...args: any[]) => aiRuntimeStatusMock(...args),
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
  Settings: () => <span>settings</span>,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

function renderPanel(props: Record<string, unknown> = {}) {
  return render(
    <AiAssistantPanel
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
  it("auto-downloads and starts runtime on first launch when only the model is missing", async () => {
    const downloading = deferred<any>();
    aiRuntimeStatusMock.mockImplementation(() =>
      Promise.resolve(
        status({
          phase: "missing",
          missing: [
            "Missing GGUF model. Set POLITEDB_LLM_MODEL_PATH or place default.gguf in the app data folder under ai/models/default.gguf",
          ],
        })
      )
    );
    aiRuntimeDownloadDefaultModelMock.mockReturnValueOnce(downloading.promise);

    renderPanel();

    await screen.findByText("Preparing AI Assistant");
    expect(aiRuntimeDownloadDefaultModelMock).toHaveBeenCalledTimes(1);

    downloading.resolve(
      status({
        phase: "stopped",
        model_name: "default",
        model_path: "/tmp/default.gguf",
      })
    );

    await waitFor(() => expect(aiRuntimeStartMock).toHaveBeenCalledTimes(1));
    expect(markLocalAiModelSeenMock).toHaveBeenCalled();
  });

  it("sends a general chat message and renders the assistant reply", async () => {
    renderPanel();

    const textarea = screen.getByPlaceholderText(
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
      sql: "SELECT id FROM users",
      explanation: "Use a simple query.",
      assumptions: [],
      needsClarification: false,
      clarification: "",
    });

    renderPanel({ runtimeConnectionId: "conn_1" });

    const textarea = screen.getByPlaceholderText(
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
        "SELECT id FROM users",
        {
          maxRows: 200,
          batchSize: 200,
          timeoutMs: 45_000,
        }
      )
    );

    await screen.findByText("There are 2 rows.");
  });
});
