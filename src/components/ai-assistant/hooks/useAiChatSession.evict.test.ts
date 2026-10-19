import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/preact";
import { MAX_PERSISTED_BYTES, useAiChatSession } from "./useAiChatSession";

const SCOPE = "evict-test";
const KEY = `politedb.ai.chat.${SCOPE}`;

function legacySession(id: string, updatedAt: number, size: number) {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    messages: [
      { id: `${id}-1`, role: "user", text: "q".repeat(size) },
      { id: `${id}-2`, role: "assistant", text: "a".repeat(size) },
    ],
  };
}

function stored() {
  const raw = localStorage.getItem(KEY) ?? "";
  return { raw, bytes: new TextEncoder().encode(raw).length };
}

describe("useAiChatSession history cap", () => {
  it("evicts from the visible state, saves the same list and never resurrects it", async () => {
    // Legacy storage written before the cap: about 3 MiB in two sessions.
    localStorage.setItem(
      KEY,
      JSON.stringify({
        activeSessionId: "current",
        sessions: [
          legacySession("current", 2, 400_000),
          legacySession("older", 1, 1_200_000),
        ],
      })
    );

    const first = renderHook(() => useAiChatSession(SCOPE));
    await waitFor(() =>
      expect(first.result.current.chatSessions.map((s) => s.id)).toEqual([
        "current",
      ])
    );
    await waitFor(() => expect(stored().raw).not.toContain('"older"'));
    expect(stored().bytes).toBeLessThanOrEqual(MAX_PERSISTED_BYTES);

    // A later change keeps the eviction.
    act(() => first.result.current.appendUserMessage("follow-up"));
    await waitFor(() => expect(stored().raw).toContain("follow-up"));
    expect(first.result.current.chatSessions.map((s) => s.id)).toEqual([
      "current",
    ]);
    first.unmount();

    // Remount (memory) and a cold load (storage) see the same history.
    const second = renderHook(() => useAiChatSession(SCOPE));
    expect(second.result.current.chatSessions.map((s) => s.id)).toEqual([
      "current",
    ]);
    expect(
      second.result.current.messages.some((m) => m.text === "follow-up")
    ).toBe(true);
    second.unmount();
    expect(JSON.parse(stored().raw).sessions).toHaveLength(1);
  });

  it("bounds oversized legacy metadata on load without a render loop", async () => {
    localStorage.clear();
    localStorage.setItem(
      `politedb.ai.chat.meta-test`,
      JSON.stringify({
        activeSessionId: "x".repeat(5000),
        sessions: [
          {
            id: "x".repeat(5000),
            title: "t".repeat(MAX_PERSISTED_BYTES + 1),
            targetTable: "y".repeat(300_000),
            createdAt: 1,
            updatedAt: 1,
            messages: [
              { id: "z".repeat(5000), role: "user", text: "hello" },
              { id: "bad", role: "system", text: "dropped" },
            ],
          },
        ],
      })
    );
    let renders = 0;
    const hook = renderHook(() => {
      renders += 1;
      return useAiChatSession("meta-test");
    });
    const storedSize = () =>
      new TextEncoder().encode(
        localStorage.getItem("politedb.ai.chat.meta-test") ?? ""
      ).length;
    await waitFor(() => expect(storedSize()).toBeLessThan(10_000));
    const current = hook.result.current!;
    expect((current.chatSessions[0]?.title ?? "").length).toBeLessThanOrEqual(
      120
    );
    expect(current.messages.map((m) => m.text)).toEqual(["hello"]);
    const settled = renders;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(renders).toBe(settled);
    expect(renders).toBeLessThan(10);
    hook.unmount();
  });
});
