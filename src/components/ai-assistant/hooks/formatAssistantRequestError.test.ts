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

  it("does not point a generic agent error at a removed setting", () => {
    for (const lang of [en, vi]) {
      const text = formatAssistantRequestError({
        error: new Error("AI_AGENT_PROTOCOL"),
        lang,
        isLocalProvider: false,
      });
      expect(text).toMatch(/AI agent/);
      expect(text).not.toMatch(/beta|turn off|tắt/);
    }
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

  it("maps the Ollama native codes to fixed copy without echoing provider text", () => {
    const secret =
      ": SELECT * FROM customers WHERE email = 'a@b.c' sk-live-123";
    const cases: [string, RegExp, RegExp][] = [
      [
        "AI_AGENT_CONTEXT_FULL",
        /did not fit the model's context/,
        /vượt quá context/,
      ],
      ["AI_OLLAMA_UPDATE_REQUIRED", /0\.12\.6 or newer/, /0\.12\.6 trở lên/],
      [
        "AI_OLLAMA_MODEL_NOT_FOUND",
        /not found on the Ollama server/,
        /Không tìm thấy model/,
      ],
      [
        "AI_OLLAMA_MODEL_INFO_UNAVAILABLE",
        /context size/,
        /kích thước context/,
      ],
      ["AI_OLLAMA_LOAD_FAILED", /enough memory/, /đủ bộ nhớ/],
      ["AI_PROVIDER_UNREACHABLE", /Couldn't reach/, /Không kết nối được/],
      ["AI_PROVIDER_CONTEXT_SIZE_INVALID", /2048–262144/, /2048–262144/],
    ];
    for (const [code, english, vietnamese] of cases) {
      for (const [lang, pattern] of [
        [en, english],
        [vi, vietnamese],
      ] as const) {
        const text = formatAssistantRequestError({
          error: new Error(code + secret),
          lang,
          isLocalProvider: true,
        });
        expect(text, code).toMatch(pattern);
        expect(text, code).not.toMatch(/SELECT|sk-live|a@b\.c/);
      }
    }
    // The context-full copy never claims the context was shortened.
    expect(
      formatAssistantRequestError({
        error: new Error("AI_AGENT_CONTEXT_FULL"),
        lang: en,
        isLocalProvider: true,
      })
    ).not.toMatch(/reduced/);
  });
});
