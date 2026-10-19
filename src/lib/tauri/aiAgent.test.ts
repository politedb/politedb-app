import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: (event: T) => void = () => {};
  }
  return { Channel, invoke: (...a: any[]) => mocks.invoke(...a) };
});

import {
  LEGACY_AI_AGENT_KEYS,
  aiAgentCancel,
  aiAgentStart,
  type AiAgentEvent,
} from "./aiAgent";

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
});

describe("aiAgent wrappers", () => {
  it("runs without an opt-in and clears the old agent settings", async () => {
    for (const legacy of [null, "0", "1"]) {
      mocks.invoke.mockClear();
      if (legacy)
        for (const key of LEGACY_AI_AGENT_KEYS)
          localStorage.setItem(key, legacy);
      await aiAgentStart(
        { runId: "r1", providerId: "p1", question: "hi" },
        () => {}
      );
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
      for (const key of LEGACY_AI_AGENT_KEYS)
        expect(localStorage.getItem(key)).toBeNull();
    }
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
