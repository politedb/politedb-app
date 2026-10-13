import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAgentTurn: vi.fn(),
  plan: vi.fn(),
  agentEnabled: true,
  columnDetails: true,
  safety: "read_only" as "read_only" | "unknown",
  granted: false,
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
  AI_DATA_ACCESS_REQUIRED: "AI_DATA_ACCESS_REQUIRED",
  aiAgentDataAccessStatus: async () => ({
    available: true,
    granted: mocks.granted,
    label: "Shop DB",
  }),
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
  mocks.granted = false;
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

  it("asks for data access when the run needs it, then can ask again", async () => {
    mocks.runAgentTurn.mockRejectedValue(new Error("AI_DATA_ACCESS_REQUIRED"));
    const { result, finalize } = setup({ querySafetyMode: "production" });
    await act(() => result.current.handleSubmit());
    expect(mocks.runAgentTurn.mock.calls[0][0].safetyMode).toBe("production");
    expect(mocks.plan).not.toHaveBeenCalled();
    const parts = finalize.mock.calls[0][1].parts;
    expect(parts[1]).toEqual({
      type: "dataAccessRequest",
      question: "how many orders per customer?",
      label: "Shop DB",
      state: "pending",
    });

    mocks.runAgentTurn.mockResolvedValue({ text: "42 orders", steps: [] });
    await act(() =>
      result.current.submitQuestion("how many orders per customer?")
    );
    expect(mocks.runAgentTurn).toHaveBeenCalledTimes(2);
    expect(finalize.mock.calls[1][1].text).toBe("42 orders");
  });

  it("marks answers that queried data, failed queries included", async () => {
    for (const ok of [true, false]) {
      mocks.runAgentTurn.mockResolvedValue({
        text: "Top: alice",
        steps: [
          { tool: "run_readonly_query", ok, truncated: false, durationMs: 3 },
        ],
      });
      const { result, finalize } = setup();
      await act(() => result.current.handleSubmit());
      expect(finalize.mock.calls[0][1].dataRead).toBe(true);
    }
    mocks.runAgentTurn.mockResolvedValue({
      text: "Schema only",
      steps: [
        { tool: "describe_table", ok: true, truncated: false, durationMs: 3 },
      ],
    });
    const again = setup();
    await act(() => again.result.current.handleSubmit());
    expect(again.finalize.mock.calls[0][1].dataRead).toBeUndefined();
  });

  it("data answers and everything after them leave only through the consent-checked agent path", async () => {
    const messages = [
      { id: "1", role: "user", text: "how many tables?" },
      { id: "2", role: "assistant", text: "orders has 5 columns" },
      { id: "3", role: "user", text: "top customers?" },
      {
        id: "4",
        role: "assistant",
        text: "alice@corp.com 12400",
        dataRead: true,
      },
      { id: "5", role: "user", text: "summarise that" },
      {
        id: "6",
        role: "assistant",
        text: "The top customer is alice@corp.com",
      },
    ];
    // Agent path: the backend checks consent before the first request.
    mocks.runAgentTurn.mockResolvedValue({ text: "ok", steps: [] });
    const { result } = setup({ messages });
    await act(() => result.current.handleSubmit());
    expect(mocks.runAgentTurn.mock.calls[0][0].historyHasData).toBe(true);

    // Legacy path without consent: nothing from the first data answer on.
    mocks.agentEnabled = false;
    const legacy = setup({ messages });
    await act(() => legacy.result.current.handleSubmit());
    const sent = JSON.stringify(mocks.plan.mock.calls[0][0].history);
    expect(sent).toContain("orders has 5 columns");
    expect(sent).not.toContain("alice@corp.com");

    // Even with consent, paths without a backend consent check never get it, and a
    // fallback after an agent attempt neither (consent may have changed meanwhile).
    mocks.granted = true;
    mocks.plan.mockClear();
    const allowed = setup({ messages });
    await act(() => allowed.result.current.handleSubmit());
    expect(JSON.stringify(mocks.plan.mock.calls[0][0].history)).not.toContain(
      "alice@corp.com"
    );
    mocks.agentEnabled = true;
    mocks.plan.mockClear();
    mocks.runAgentTurn.mockRejectedValue(
      new AgentFallback("AI_AGENT_TOOLS_UNSUPPORTED")
    );
    const fallback = setup({ messages });
    await act(() => fallback.result.current.handleSubmit());
    expect(mocks.plan).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.plan.mock.calls[0][0].history)).not.toContain(
      "alice@corp.com"
    );
  });

  it("a chat holding data marks every later message, even without new queries", async () => {
    mocks.runAgentTurn.mockResolvedValue({ text: "summary", steps: [] });
    const messages = [
      { id: "1", role: "assistant", text: "alice 12400", dataRead: true },
    ];
    const append = vi.fn();
    const { result, finalize } = setup({ messages, appendUserMessage: append });
    await act(() => result.current.handleSubmit());
    expect(append).toHaveBeenCalledWith("how many orders per customer?", {
      dataRead: true,
    });
    expect(finalize.mock.calls[0][1].dataRead).toBe(true);
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
