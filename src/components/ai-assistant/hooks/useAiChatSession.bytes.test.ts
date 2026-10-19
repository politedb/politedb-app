import { describe, expect, it } from "vitest";
import type { AiChatSession, ChatMessage } from "src/types";
import {
  MAX_PERSISTED_BYTES,
  OVERSIZED_MESSAGE_TEXT,
  fitSessionsForStorage,
} from "./useAiChatSession";

function session(
  id: string,
  updatedAt: number,
  size: number,
  count = 2
): AiChatSession {
  return {
    id,
    scopeKey: "s",
    title: id,
    messages: Array.from(
      { length: count },
      (_, i): ChatMessage => ({
        id: `${id}-${i + 1}`,
        role: i % 2 ? "assistant" : "user",
        text: (i % 2 ? "y" : "x").repeat(size),
      })
    ),
    createdAt: updatedAt,
    updatedAt,
  };
}

/** Bytes of the envelope actually written to storage. */
function storedBytes(sessions: AiChatSession[], activeSessionId: string) {
  return new TextEncoder().encode(
    JSON.stringify({
      scopeKey: "scope",
      activeSessionId,
      sessions,
      updatedAt: Date.now(),
    })
  ).length;
}

describe("fitSessionsForStorage", () => {
  it("returns the same list when everything fits", () => {
    const sessions = [session("a", 3, 10), session("b", 2, 10)];
    const fitted = fitSessionsForStorage("scope", sessions, "a", 10_000);
    expect(fitted.changed).toBe(false);
    expect(fitted.sessions).toBe(sessions);
  });

  it("drops the oldest sessions first, never the active one", () => {
    const sessions = [
      session("new", 3, 400),
      session("mid", 2, 400),
      session("old", 1, 400),
    ];
    const fitted = fitSessionsForStorage("scope", sessions, "old", 2_300);
    expect(fitted.changed).toBe(true);
    expect(fitted.sessions.map((s) => s.id)).toEqual(["new", "old"]);
    expect(storedBytes(fitted.sessions, "old")).toBeLessThanOrEqual(2_300);
  });

  it("trims the active session's oldest messages next", () => {
    const fitted = fitSessionsForStorage(
      "scope",
      [session("only", 1, 2_000)],
      "only",
      2_500
    );
    expect(fitted.sessions[0].messages.map((m) => m.id)).toEqual(["only-2"]);
  });

  it("counts the whole envelope, including multi-byte text", () => {
    const sessions = [session("a", 2, 300_000), session("b", 1, 300_000)];
    sessions[0].messages[0].text = "é".repeat(300_000);
    // Only fits once the second session is gone.
    const max = storedBytes([sessions[0]], "a") + 10;
    const fitted = fitSessionsForStorage("scope", sessions, "a", max);
    expect(fitted.sessions.map((s) => s.id)).toEqual(["a"]);
    expect(storedBytes(fitted.sessions, "a")).toBeLessThanOrEqual(max);
  });

  it("replaces a single oversized message instead of keeping it", () => {
    const huge = session("only", 1, MAX_PERSISTED_BYTES + 1_000, 1);
    huge.messages[0].parts = [
      { type: "sqlPreview", sql: "SELECT 1", confirmationState: "pending" },
    ];
    const fitted = fitSessionsForStorage("scope", [huge], "only");
    const [message] = fitted.sessions[0].messages;
    expect(message.text).toBe(OVERSIZED_MESSAGE_TEXT);
    expect(message.parts).toBeUndefined();
    expect(storedBytes(fitted.sessions, "only")).toBeLessThanOrEqual(
      MAX_PERSISTED_BYTES
    );
  });

  it("applies the message and session count limits", () => {
    const many = Array.from({ length: 25 }, (_, i) => session(`s${i}`, i, 5));
    many[0] = session("s0", 0, 5, 90);
    const fitted = fitSessionsForStorage("scope", many, "s0", 1_000_000);
    expect(fitted.sessions).toHaveLength(20);
    // The active session stays even though it is the oldest.
    const active = fitted.sessions.find((s) => s.id === "s0");
    expect(active?.messages).toHaveLength(80);
    expect(active?.messages[0].id).toBe("s0-11");
    // Fitting the result again changes nothing (no render loop).
    const again = fitSessionsForStorage(
      "scope",
      fitted.sessions,
      "s0",
      1_000_000
    );
    expect(again.changed).toBe(false);
  });

  it("fails closed on oversized metadata and stays idempotent", () => {
    const legacy = {
      ...session("only", 1, 5, 1),
      title: "t".repeat(MAX_PERSISTED_BYTES + 1),
      targetTable: "x".repeat(10_000),
    };
    const fitted = fitSessionsForStorage("scope", [legacy], "only");
    expect(fitted.changed).toBe(true);
    expect(storedBytes(fitted.sessions, "only")).toBeLessThanOrEqual(
      MAX_PERSISTED_BYTES
    );
    expect(fitted.sessions[0].id).toBe("only");
    const again = fitSessionsForStorage("scope", fitted.sessions, "only");
    expect(again.changed).toBe(false);
    expect(again.sessions).toBe(fitted.sessions);
  });
});
