import { describe, expect, it } from "vitest";
import { buildChatReplyPlainPrompt } from "./prompts";

describe("buildChatReplyPlainPrompt", () => {
  it("answers confirmed metadata follow-ups from supplied columns", () => {
    const prompt = buildChatReplyPlainPrompt({
      engine: "mysql",
      activeSchema: "public",
      preferredReplyLanguage:
        "Vietnamese — you MUST write every word in Vietnamese only",
      schemaSummary: "- public.hosts (id, hostname, created_at)",
      conversationSummary:
        "User: cho tôi structure và column details\n\nAssistant: Bạn muốn xem public.hosts?",
      question: "ok show cho tôi",
    });

    expect(prompt).toContain("public.hosts (id, hostname, created_at)");
    expect(prompt).toContain("perform the request established");
    expect(prompt).toContain("answer directly from relevant schema metadata");
    expect(prompt).toContain("Final language check");
  });
});
