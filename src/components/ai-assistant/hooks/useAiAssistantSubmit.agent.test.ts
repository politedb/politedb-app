import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAgentTurn: vi.fn(),
  plan: vi.fn(),
  agentEnabled: true,
  columnDetails: true,
  safety: "read_only" as "read_only" | "unknown",
}));

vi.mock("src/lib/ai-assistant/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/ai-assistant/agent")>()),
  runAgentTurn: (...a: any[]) => mocks.runAgentTurn(...a),
}));
vi.mock("src/lib/ai-assistant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/ai-assistant")>()),
  planAssistantTurn: (...a: any[]) => mocks.plan(...a),
  getDirectAppContextReply: () => null,
}));
vi.mock("src/lib/tauri/aiAgent", () => ({
  isAiAgentEnabled: () => mocks.agentEnabled,
  isAiAgentColumnDetailsEnabled: () => mocks.columnDetails,
  aiAgentSqlSafety: async () => mocks.safety,
}));
vi.mock("src/lib/tauri/ai", () => ({ aiChatCancel: vi.fn() }));

import { AgentFallback } from "src/lib/ai-assistant/agent";
import { useAiAssistantSubmit } from "./useAiAssistantSubmit";

function setup(overrides: Record<string, unknown> = {}) {
  const finalize = vi.fn();
  const args = {
    prompt: "how many orders per customer?",
    setPrompt: vi.fn(),
    messages: [],
    appendUserMessage: vi.fn(),
    appendAssistantMessage: vi.fn(),
    beginStreamingAssistantMessage: () => "stream-1",
    updateStreamingAssistantText: vi.fn(),
    finalizeStreamingAssistantMessage: finalize,
    clearStreamingMessages: vi.fn(),
    setSubmitting: vi.fn(),
    setAssistantStatus: vi.fn(),
    providerId: "p1",
    isLocalProvider: false,
    model: "claude-opus-5-5",
    engine: "postgres",
    runtimeConnectionId: "conn-1",
    activeSchema: "public",
    tables: [{ schema: "public", name: "orders" }],
    currentSql: "SELECT 1",
    conversationState: {},
    updateConversationState: vi.fn(),
    ...overrides,
  } as any;
  const { result } = renderHook(() => useAiAssistantSubmit(args));
  return { result, finalize };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agentEnabled = true;
  mocks.columnDetails = true;
  mocks.safety = "read_only";
  mocks.plan.mockResolvedValue({ kind: "chat", answer: "legacy answer" });
});

describe("useAiAssistantSubmit with the AI agent", () => {
  it("uses the agent when enabled on a supported engine", async () => {
    mocks.runAgentTurn.mockResolvedValue({
      text: "Count them:\n```sql\nSELECT customer_id, count(*) FROM orders GROUP BY 1;\n```",
      steps: [
        { tool: "describe_table", ok: true, truncated: false, durationMs: 4 },
      ],
    });
    const { result, finalize } = setup();
    await act(() => result.current.handleSubmit());
    expect(mocks.runAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "p1",
        connectionId: "conn-1",
        editorSql: "SELECT 1",
        question: "how many orders per customer?",
      })
    );
    expect(mocks.plan).not.toHaveBeenCalled();
    const message = finalize.mock.calls[0][1];
    expect(message.parts.map((p: any) => p.type)).toEqual([
      "agentSteps",
      "text",
      "sqlPreview",
    ]);
    expect(message.parts[2].safety).toBe("read_only");
  });

  it("offers only Insert when the backend check is not sure", async () => {
    mocks.safety = "unknown";
    mocks.runAgentTurn.mockResolvedValue({
      text: "```sql\nSELECT pg_advisory_lock(1)\n```",
      steps: [],
    });
    const { result, finalize } = setup();
    await act(() => result.current.handleSubmit());
    const preview = finalize.mock.calls[0][1].parts.find(
      (p: any) => p.type === "sqlPreview"
    );
    expect(preview.safety).toBe("unknown");
  });

  it("follow-ups carry the conversation and the same context as the legacy planner", async () => {
    mocks.columnDetails = false;
    mocks.runAgentTurn.mockResolvedValue({ text: "ok", steps: [] });
    const { result } = setup({
      prompt: "giờ nhóm theo tháng",
      currentSql: undefined, // "sql" chip off
      activeTable: { schema: "public", name: "orders" },
      conversationState: {
        replyLanguageCode: "vie",
        targetTable: "public.orders",
      },
      messages: [
        { id: "1", role: "user", text: "số đơn hàng theo khách hàng?" },
        {
          id: "2",
          role: "assistant",
          text: "Đây là truy vấn.",
          sql: "SELECT customer_id, count(*) FROM orders GROUP BY 1",
        },
      ],
    });
    await act(() => result.current.handleSubmit());
    const input = mocks.runAgentTurn.mock.calls[0][0];
    expect(input).toMatchObject({
      question: "giờ nhóm theo tháng",
      activeSchema: "public",
      activeTable: "orders",
      targetTable: "public.orders",
      replyLanguage: "Vietnamese",
      includeColumnDetails: false,
    });
    expect(input.editorSql).toBeUndefined();
    expect(input.history).toEqual([
      { role: "user", text: "số đơn hàng theo khách hàng?" },
      {
        role: "assistant",
        text: "Đây là truy vấn.\n\n```sql\nSELECT customer_id, count(*) FROM orders GROUP BY 1\n```",
      },
    ]);
  });

  it("falls back to the legacy assistant when the agent cannot run", async () => {
    mocks.runAgentTurn.mockRejectedValue(
      new AgentFallback("AI_AGENT_PROVIDER_UNSUPPORTED")
    );
    const { result, finalize } = setup();
    await act(() => result.current.handleSubmit());
    expect(mocks.plan).toHaveBeenCalledTimes(1);
    expect(finalize.mock.calls[0][1].text).toBe("legacy answer");
  });

  it("does not use the agent when off, without a connection or on other engines", async () => {
    for (const overrides of [
      { __off: true },
      { runtimeConnectionId: undefined },
      { engine: "mongodb" },
    ]) {
      vi.clearAllMocks();
      mocks.agentEnabled = !("__off" in overrides);
      mocks.plan.mockResolvedValue({ kind: "chat", answer: "legacy answer" });
      const { result } = setup(overrides);
      await act(() => result.current.handleSubmit());
      expect(mocks.runAgentTurn).not.toHaveBeenCalled();
    }
  });

  it("agent errors are shown, not silently replaced by the legacy answer", async () => {
    mocks.runAgentTurn.mockRejectedValue(new Error("AI_AGENT_DEADLINE"));
    const { result, finalize } = setup();
    await act(() => result.current.handleSubmit());
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });
});
