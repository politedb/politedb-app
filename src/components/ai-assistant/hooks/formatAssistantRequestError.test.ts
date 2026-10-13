import { describe, expect, it } from "vitest";
import { formatAssistantRequestError } from "./useAiAssistantSubmit";

const en = { code: "eng" } as any;
const vi = { code: "vie" } as any;

describe("formatAssistantRequestError", () => {
  it("explains refusals and token exhaustion separately", () => {
    expect(
      formatAssistantRequestError({
        error: new Error("AI_CHAT_REFUSED"),
        lang: en,
        isLocalProvider: false,
      })
    ).toMatch(/declined/);
    expect(
      formatAssistantRequestError({
        error: "AI_CHAT_REFUSED",
        lang: vi,
        isLocalProvider: false,
      })
    ).toMatch(/từ chối/);
    expect(
      formatAssistantRequestError({
        error: new Error(
          "AI_CHAT_OUTPUT_TOKEN_LIMIT: model produced no final content"
        ),
        lang: en,
        isLocalProvider: false,
      })
    ).toMatch(/did not produce a final response/);
  });

  it("explains a declined data query", () => {
    expect(
      formatAssistantRequestError({
        error: new Error("AI_DATA_APPROVAL_DENIED"),
        lang: en,
        isLocalProvider: false,
      })
    ).toMatch(/declined the AI's data query/);
    expect(
      formatAssistantRequestError({
        error: "AI_DATA_APPROVAL_DENIED",
        lang: vi,
        isLocalProvider: false,
      })
    ).toMatch(/từ chối/);
  });
});
