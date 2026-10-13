import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: (event: T) => void = () => {};
  }
  return { Channel, invoke: (...a: any[]) => mocks.invoke(...a) };
});

import {
  AI_AGENT_ENABLED_KEY,
  aiAgentCancel,
  aiAgentStart,
  isAiAgentEnabled,
  type AiAgentEvent,
} from "./aiAgent";

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  localStorage.setItem(AI_AGENT_ENABLED_KEY, "1");
});

describe("aiAgent wrappers", () => {
  it("is off unless the hidden setting is enabled", async () => {
    localStorage.removeItem(AI_AGENT_ENABLED_KEY);
    expect(isAiAgentEnabled()).toBe(false);
    await expect(
      aiAgentStart({ runId: "r1", providerId: "p1", question: "hi" }, () => {})
    ).rejects.toThrow("AI_AGENT_DISABLED");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("starts a run with a channel that forwards events", async () => {
    const events: AiAgentEvent[] = [];
    await aiAgentStart({ runId: "r1", providerId: "p1", question: "hi" }, (e) =>
      events.push(e)
    );
    const [cmd, args] = mocks.invoke.mock.calls[0];
    expect(cmd).toBe("ai_agent_start");
    expect(args.input).toEqual({
      runId: "r1",
      providerId: "p1",
      question: "hi",
    });
    args.onEvent.onmessage({ type: "answer", text: "ok" });
    expect(events).toEqual([{ type: "answer", text: "ok" }]);
  });

  it("cancels by run id", async () => {
    await aiAgentCancel("r1");
    expect(mocks.invoke).toHaveBeenCalledWith("ai_agent_cancel", {
      runId: "r1",
    });
  });
});
