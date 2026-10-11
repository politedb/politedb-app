import { describe, expect, it } from "vitest";
import {
  aiProviderKeyCapability,
  buildBaseUrl,
  getSelectedAiProviderId,
  isLegacyBundledProvider,
  makeDefaultAiProvider,
  normalizeAiProviderConfig,
  resolveSelectedAiProvider,
  setSelectedAiProviderId,
  splitBaseUrl,
} from "./providers";
import type { AiProviderConfig } from "src/types";

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
      defaultModel: "claude-sonnet-5-5",
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

  it("keeps local kinds and model ids exactly (plan R2)", () => {
    const ollama = normalizeAiProviderConfig({
      id: "ollama-1",
      kind: "ollama",
      label: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "llama3:8b",
      models: ["llama3:8b", "llama-3.1-8b"],
      enabled: true,
    });
    expect(ollama.defaultModel).toBe("llama3:8b");
    expect(ollama.models).toEqual(["llama3:8b", "llama-3.1-8b"]);
  });

  it("uses server-convention defaults and no placeholder model for local kinds", () => {
    expect(makeDefaultAiProvider("ollama")).toMatchObject({
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "",
      models: [],
    });
    expect(makeDefaultAiProvider("ollama").id).not.toBe(
      makeDefaultAiProvider("ollama").id
    );
  });

  it("falls back from a deleted provider id to the default enabled provider", () => {
    const local = makeDefaultAiProvider("ollama", {
      id: "local",
      isDefault: true,
    });
    const openai = makeDefaultAiProvider("openai", { id: "openai-1" });

    expect(resolveSelectedAiProvider([local, openai], "gone")?.id).toBe(
      "local"
    );
    expect(resolveSelectedAiProvider([local, openai], "openai-1")?.id).toBe(
      "openai-1"
    );
  });

  it("never selects a disabled provider (plan R5)", () => {
    const off = makeDefaultAiProvider("openai", {
      id: "openai-off",
      enabled: false,
      isDefault: true,
    });
    const on = makeDefaultAiProvider("deepseek", { id: "deepseek-on" });
    expect(resolveSelectedAiProvider([off, on], "openai-off")?.id).toBe(
      "deepseek-on"
    );
    expect(resolveSelectedAiProvider([off], "openai-off")).toBeUndefined();
    expect(resolveSelectedAiProvider([], "")).toBeUndefined();
  });

  it("stores, clears and broadcasts the selected provider", () => {
    localStorage.clear();
    const seen: string[] = [];
    const onSelected = (event: Event) =>
      seen.push(
        (event as CustomEvent<{ providerId: string }>).detail.providerId
      );
    window.addEventListener("politedb-ai-provider-selected", onSelected);
    expect(getSelectedAiProviderId()).toBe("");
    setSelectedAiProviderId("openai-1");
    expect(getSelectedAiProviderId()).toBe("openai-1");
    setSelectedAiProviderId("");
    expect(getSelectedAiProviderId()).toBe("");
    window.removeEventListener("politedb-ai-provider-selected", onSelected);
    expect(seen).toEqual(["openai-1", ""]);
  });

  it("maps key capability per kind", () => {
    expect(aiProviderKeyCapability("openai")).toBe("required");
    expect(aiProviderKeyCapability("ollama")).toBe("none");
  });
});

describe("legacy bundled provider signature (plan D11)", () => {
  const legacy: AiProviderConfig = {
    id: "local",
    kind: "ollama",
    label: "PoliteDB AI",
    baseUrl: "http://127.0.0.1:50953/v1",
    defaultModel: "Qwen2.5-Coder-7B",
    enabled: true,
  };

  it("matches the record the removed runtime created", () => {
    expect(isLegacyBundledProvider(legacy)).toBe(true);
    expect(isLegacyBundledProvider(normalizeAiProviderConfig(legacy))).toBe(
      true
    );
  });

  it("does not match user-created or edited records", () => {
    for (const variant of [
      { ...legacy, id: "ollama-1" },
      { ...legacy, label: "My Ollama" },
      { ...legacy, baseUrl: "http://127.0.0.1:11434/v1" },
      { ...legacy, baseUrl: "http://192.168.1.5:50953/v1" },
      { ...legacy, baseUrl: "https://127.0.0.1:50953/v1" },
      { ...legacy, baseUrl: "http://127.0.0.1:50953/api" },
    ]) {
      expect(isLegacyBundledProvider(variant)).toBe(false);
    }
  });
});
