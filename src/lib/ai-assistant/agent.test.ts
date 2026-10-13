import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(),
  safety: vi.fn(),
}));
vi.mock("src/lib/tauri/aiAgent", () => ({
  aiAgentStart: (...a: any[]) => mocks.start(...a),
  aiAgentCancel: (...a: any[]) => mocks.cancel(...a),
  aiAgentSqlSafety: (...a: any[]) => mocks.safety(...a),
}));

import {
  AGENT_HISTORY_MESSAGES,
  AgentFallback,
  agentAnswerParts,
  agentHistory,
  runAgentTurn,
  sqlSafety,
} from "./agent";

type Emit = (event: any) => void;

/** Captures the event callback so tests can play backend events. */
function capture(): { emit: () => Emit } {
  let emit: Emit = () => {};
  mocks.start.mockImplementation(async (_input: any, onEvent: Emit) => {
    emit = onEvent;
  });
  return { emit: () => emit };
}

const base = { providerId: "p", question: "q", connectionId: "c" };

beforeEach(() => {
  mocks.safety.mockReset().mockResolvedValue("read_only");
  mocks.start.mockReset();
  mocks.cancel.mockReset().mockResolvedValue(undefined);
});

describe("runAgentTurn", () => {
  it("collects steps and resolves with the answer", async () => {
    const run = capture();
    const onSteps = vi.fn();
    const promise = runAgentTurn({ ...base, editorSql: "SELECT 1", onSteps });
    await Promise.resolve();
    const emit = run.emit();
    emit({ type: "step", n: 1 });
    emit({ type: "toolStarted", tool: "list_tables" });
    emit({
      type: "toolFinished",
      tool: "list_tables",
      ok: true,
      truncated: false,
      durationMs: 12,
    });
    emit({ type: "answer", text: "Done" });
    emit({
      type: "done",
      status: "answered",
      steps: 2,
      inputTokens: 1,
      outputTokens: 1,
    });
    await expect(promise).resolves.toEqual({
      text: "Done",
      steps: [
        { tool: "list_tables", ok: true, truncated: false, durationMs: 12 },
      ],
    });
    expect(onSteps).toHaveBeenCalledTimes(1);
    const input = mocks.start.mock.calls[0][0];
    expect(input).toMatchObject({
      providerId: "p",
      connectionId: "c",
      editorSql: "SELECT 1",
    });
    expect(input.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("passes the conversation context to the backend", async () => {
    capture();
    void runAgentTurn({
      ...base,
      history: [{ role: "user", text: "earlier" }],
      activeSchema: "public",
      activeTable: "orders",
      targetTable: "orders",
      replyLanguage: "Vietnamese",
      includeColumnDetails: true,
    }).catch(() => {});
    const input = mocks.start.mock.calls[0][0];
    expect(input).toMatchObject({
      history: [{ role: "user", text: "earlier" }],
      activeSchema: "public",
      activeTable: "orders",
      targetTable: "orders",
      replyLanguage: "Vietnamese",
      includeColumnDetails: true,
    });
    // Defaults keep comments and defaults out.
    void runAgentTurn(base).catch(() => {});
    expect(mocks.start.mock.calls[1][0]).toMatchObject({
      history: [],
      includeColumnDetails: false,
    });
  });

  it("falls back when the backend refuses up front", async () => {
    mocks.start.mockRejectedValue(new Error("AI_AGENT_PROVIDER_UNSUPPORTED"));
    await expect(runAgentTurn(base)).rejects.toBeInstanceOf(AgentFallback);
    mocks.start.mockRejectedValue("AI_AGENT_ENGINE_UNSUPPORTED");
    await expect(runAgentTurn(base)).rejects.toBeInstanceOf(AgentFallback);
    mocks.start.mockRejectedValue(new Error("AI_AGENT_BUSY"));
    await expect(runAgentTurn(base)).rejects.not.toBeInstanceOf(AgentFallback);
  });

  it("falls back on unsupported tools only if no tool ran", async () => {
    const run = capture();
    const early = runAgentTurn(base);
    await Promise.resolve();
    run.emit()({ type: "error", code: "AI_AGENT_TOOLS_UNSUPPORTED" });
    run.emit()({
      type: "done",
      status: "failed",
      steps: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
    await expect(early).rejects.toBeInstanceOf(AgentFallback);

    const late = runAgentTurn(base);
    await Promise.resolve();
    run.emit()({ type: "toolStarted", tool: "list_tables" });
    run.emit()({ type: "error", code: "AI_AGENT_TOOLS_UNSUPPORTED" });
    run.emit()({
      type: "done",
      status: "failed",
      steps: 2,
      inputTokens: 0,
      outputTokens: 0,
    });
    await expect(late).rejects.toThrow("AI_AGENT_TOOLS_UNSUPPORTED");
    await expect(late).rejects.not.toBeInstanceOf(AgentFallback);
  });

  it("aborting cancels the backend run", async () => {
    capture();
    const controller = new AbortController();
    const promise = runAgentTurn({ ...base, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    const runId = mocks.start.mock.calls[0][0].runId;
    expect(mocks.cancel).toHaveBeenCalledWith(runId);
  });

  it("an already-aborted signal starts nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runAgentTurn({ ...base, signal: controller.signal })
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });
});

describe("agentAnswerParts", () => {
  it("turns the first sql block into a locally classified preview", async () => {
    const steps = [
      { tool: "describe_table", ok: true, truncated: false, durationMs: 3 },
    ];
    const result = await agentAnswerParts(
      {
        text: "Here you go:\n```sql\nSELECT * FROM orders;\n```\nIt lists orders.",
        steps,
      },
      "conn-1"
    );
    expect(mocks.safety).toHaveBeenCalledWith(
      "SELECT * FROM orders;",
      "conn-1"
    );
    expect(result.sql).toBe("SELECT * FROM orders;");
    expect(result.parts[0]).toEqual({ type: "agentSteps", steps });
    expect(result.parts[1]).toMatchObject({ type: "text" });
    expect((result.parts[1] as any).text).not.toContain("```");
    expect(result.parts[2]).toEqual({
      type: "sqlPreview",
      sql: "SELECT * FROM orders;",
      safety: "read_only",
      agent: true,
      confirmationState: "pending",
    });
  });

  it("never trusts the model about safety", async () => {
    expect(await sqlSafety("DELETE FROM orders", "conn-1")).toBe("mutating");
    expect(await sqlSafety("DROP TABLE orders", "conn-1")).toBe("ddl");
    expect(await sqlSafety("SELECT 1; DELETE FROM orders", "conn-1")).not.toBe(
      "read_only"
    );
    const { parts } = await agentAnswerParts(
      {
        text: "Safe read-only query:\n```sql\nUPDATE orders SET total = 0\n```",
        steps: [],
      },
      "conn-1"
    );
    expect(parts.find((p) => p.type === "sqlPreview")).toMatchObject({
      safety: "mutating",
    });
  });

  it("offers Run only when the backend check also says read-only", async () => {
    // Side effects the frontend heuristic misses (Codex Phase 2 review).
    mocks.safety.mockResolvedValue("unknown");
    for (const sql of [
      "PRAGMA user_version = 99",
      'SELECT 1 INTO OUTFILE "/tmp/agent-output"',
      "SELECT pg_advisory_lock(1)",
    ]) {
      expect(await sqlSafety(sql, "conn-1")).not.toBe("read_only");
    }
    const { parts } = await agentAnswerParts(
      { text: "```sql\nSELECT pg_advisory_lock(1)\n```", steps: [] },
      "conn-1"
    );
    expect(parts.find((p) => p.type === "sqlPreview")).toMatchObject({
      safety: "unknown",
    });
  });

  it("plain answers stay text", async () => {
    const result = await agentAnswerParts(
      { text: "There are 3 tables.", steps: [] },
      "conn-1"
    );
    expect(result.parts).toEqual([
      { type: "text", text: "There are 3 tables." },
    ]);
    expect(result.sql).toBeUndefined();
  });
});

describe("agentHistory", () => {
  it("sends the visible text and SQL of recent messages only", () => {
    const messages: any[] = [
      { id: "1", role: "user", text: "orders per customer?" },
      {
        id: "2",
        role: "assistant",
        text: "Here is the query.",
        parts: [
          { type: "agentSteps", steps: [{ tool: "list_tables", ok: true }] },
          {
            type: "sqlPreview",
            sql: "SELECT customer_id, count(*) FROM orders GROUP BY 1",
          },
          { type: "resultPreview", rows: [{ secret: "row data" }] },
        ],
        resultPreview: [{ secret: "row data" }],
      },
      { id: "3", role: "assistant", text: "partial", streaming: true },
    ];
    const history = agentHistory(messages);
    expect(history).toEqual([
      { role: "user", text: "orders per customer?" },
      {
        role: "assistant",
        text: "Here is the query.\n\n```sql\nSELECT customer_id, count(*) FROM orders GROUP BY 1\n```",
      },
    ]);
    expect(JSON.stringify(history)).not.toContain("row data");
    expect(JSON.stringify(history)).not.toContain("list_tables");
  });

  it("keeps only the newest messages", () => {
    const messages: any[] = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      role: i % 2 ? "assistant" : "user",
      text: `m${i}`,
    }));
    const history = agentHistory(messages);
    expect(history).toHaveLength(AGENT_HISTORY_MESSAGES);
    expect(history[history.length - 1]?.text).toBe("m29");
  });
});
