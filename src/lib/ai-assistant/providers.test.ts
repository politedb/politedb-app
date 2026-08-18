import { describe, expect, it } from "vitest";
import {
  buildBaseUrl,
  makeDefaultAiProvider,
  normalizeAiProviderConfig,
  splitBaseUrl,
} from "./providers";

describe("AI provider configuration", () => {
  it("builds vendor defaults", () => {
    expect(makeDefaultAiProvider("openai")).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4.1-mini",
    });
    expect(makeDefaultAiProvider("grok")).toMatchObject({
      baseUrl: "https://api.x.ai/v1",
      defaultModel: "grok-3-mini",
    });
    expect(makeDefaultAiProvider("groq")).toMatchObject({
      baseUrl: "https://api.groq.com/openai/v1",
      defaultModel: "openai/gpt-oss-120b",
    });
    expect(makeDefaultAiProvider("anthropic")).toMatchObject({
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-sonnet-4-5",
    });
  });

  it("normalizes old baseUrl configs without replacing cloud models", () => {
    const provider = normalizeAiProviderConfig({
      id: "deepseek-main",
      kind: "deepseek",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      defaultModel: "deepseek-reasoner",
      enabled: true,
    });

    expect(provider.host).toBe("https://api.deepseek.com");
    expect(provider.subPath).toBe("/v1");
    expect(provider.defaultModel).toBe("deepseek-reasoner");
    expect(provider.models).toEqual(["deepseek-reasoner"]);
  });

  it("normalizes multiple models and includes the default model", () => {
    const provider = normalizeAiProviderConfig({
      id: "groq-main",
      kind: "groq",
      label: "Groq",
      defaultModel: "openai/gpt-oss-120b",
      models: [
        "openai/gpt-oss-20b",
        "openai/gpt-oss-120b",
        "openai/gpt-oss-20b",
      ],
      enabled: true,
    });

    expect(provider.models).toEqual([
      "openai/gpt-oss-20b",
      "openai/gpt-oss-120b",
    ]);
  });

  it("keeps host and sub-path composition stable", () => {
    expect(buildBaseUrl("https://example.com/", "v1/")).toBe(
      "https://example.com/v1"
    );
    expect(splitBaseUrl("https://example.com/v1", "openai")).toEqual({
      host: "https://example.com",
      subPath: "/v1",
    });
  });

  it("merges the legacy local API alias into PoliteDB Local", () => {
    const provider = normalizeAiProviderConfig({
      id: "local",
      kind: "local_openai_compatible",
      label: "Local API",
      baseUrl: "http://127.0.0.1:50953/v1",
      defaultModel: "default.gguf",
      enabled: true,
    });

    expect(provider.kind).toBe("ollama");
    expect(provider.label).toBe("PoliteDB Local");
  });
});
