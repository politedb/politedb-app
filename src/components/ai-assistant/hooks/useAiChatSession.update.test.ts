import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/preact";
import { useAiChatSession } from "./useAiChatSession";

afterEach(() => {
  localStorage.clear();
});

describe("useAiChatSession updateMessage", () => {
  it("updates a message in its own chat after the user switched chats", () => {
    const { result } = renderHook(() => useAiChatSession("update-test"));
    act(() => result.current.appendAssistantMessage({ text: "Run this." }));
    const chatA = result.current.activeSessionId;
    const messageId = result.current.messages[0]!.id;

    // A query started in chat A finishes while chat B is open.
    act(() => result.current.newChat());
    const chatB = result.current.activeSessionId;
    expect(chatB).not.toBe(chatA);
    const bBefore = result.current.chatSessions.find((s) => s.id === chatB);
    act(() =>
      result.current.updateMessage(messageId, {
        resultPreview: [{ n: 1 }],
        rowCount: 1,
        resultPartIndex: 0,
      })
    );

    const sessionA = result.current.chatSessions.find((s) => s.id === chatA);
    const sessionB = result.current.chatSessions.find((s) => s.id === chatB);
    expect(sessionA?.messages[0]).toMatchObject({
      resultPreview: [{ n: 1 }],
      rowCount: 1,
      resultPartIndex: 0,
    });
    expect(sessionB).toBe(bBefore);
    expect(result.current.messages).toEqual([]);

    act(() => result.current.switchSession(chatA));
    expect(result.current.messages[0]?.rowCount).toBe(1);
  });

  it("ignores an id that no chat holds", () => {
    const { result } = renderHook(() => useAiChatSession("update-test-2"));
    act(() => result.current.appendAssistantMessage({ text: "Hi." }));
    const before = result.current.chatSessions;
    act(() => result.current.updateMessage("missing", { text: "x" }));
    expect(result.current.chatSessions).toEqual(before);
  });
});
