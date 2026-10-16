import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/preact";
import { useAiChatSession } from "./useAiChatSession";

/** Holds animation frames until the test runs them. */
function deferFrames() {
  const queued = new Map<number, FrameRequestCallback>();
  let next = 1;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    const id = next++;
    queued.set(id, cb);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    queued.delete(id);
  });
  return () => {
    const callbacks = [...queued.values()];
    queued.clear();
    for (const cb of callbacks) cb(performance.now());
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("useAiChatSession streaming updates", () => {
  it("a frame queued before the answer never overwrites the finalized text", () => {
    const runFrames = deferFrames();
    const { result } = renderHook(() => useAiChatSession("streaming-test"));

    let id = "";
    act(() => {
      id = result.current.beginStreamingAssistantMessage();
    });
    // Agent activity is queued for the next frame...
    act(() =>
      result.current.updateStreamingAssistantText(id, "Listing tables…")
    );
    // ...but the answer arrives before that frame runs.
    act(() =>
      result.current.finalizeStreamingAssistantMessage(id, {
        text: "There are 3 tables.",
      })
    );
    act(() => runFrames());

    const message = result.current.messages.find((m) => m.id === id);
    expect(message?.text).toBe("There are 3 tables.");
    expect(message?.streaming).toBe(false);
  });

  it("a frame queued for one message does not touch a finalized one", () => {
    const runFrames = deferFrames();
    const { result } = renderHook(() => useAiChatSession("streaming-test-2"));

    let first = "";
    act(() => {
      first = result.current.beginStreamingAssistantMessage();
    });
    act(() =>
      result.current.finalizeStreamingAssistantMessage(first, { text: "done" })
    );
    // A late update for the finalized message (e.g. a stale callback).
    act(() => result.current.updateStreamingAssistantText(first, "Listing…"));
    act(() => runFrames());
    expect(result.current.messages.find((m) => m.id === first)?.text).toBe(
      "done"
    );

    // Streaming text still applies while a message is streaming.
    let second = "";
    act(() => {
      second = result.current.beginStreamingAssistantMessage();
    });
    act(() => result.current.updateStreamingAssistantText(second, "partial"));
    act(() => runFrames());
    expect(result.current.messages.find((m) => m.id === second)?.text).toBe(
      "partial"
    );
  });
});
