import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/lib/tauri/ai", () => ({}));

import { featuresFor } from "src/lib/distribution";
import {
  DEFAULT_LOCAL_AI_PROVIDER_ID,
  fallbackSelectedAiProviderId,
  filterAvailableAiProviders,
  getSelectedAiProviderId,
  isAiProviderKindAvailable,
} from "./providers";

const direct = featuresFor("direct");
const appStore = featuresFor("appstore");
const SELECTED_KEY = "politedb.ai.provider.selected";

describe("AI provider availability by distribution", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps local kinds in the direct build", () => {
    expect(isAiProviderKindAvailable("ollama", direct)).toBe(true);
    expect(isAiProviderKindAvailable("local_openai_compatible", direct)).toBe(
      true
    );
    expect(fallbackSelectedAiProviderId(direct)).toBe(
      DEFAULT_LOCAL_AI_PROVIDER_ID
    );
  });

  it("hides local kinds on the App Store and keeps cloud kinds", () => {
    expect(isAiProviderKindAvailable("ollama", appStore)).toBe(false);
    expect(isAiProviderKindAvailable("local_openai_compatible", appStore)).toBe(
      false
    );
    expect(isAiProviderKindAvailable("openai", appStore)).toBe(true);
    const providers = [
      { id: "local", kind: "ollama" as const },
      { id: "oa", kind: "openai" as const },
    ];
    expect(filterAvailableAiProviders(providers, appStore)).toEqual([
      { id: "oa", kind: "openai" },
    ]);
    expect(filterAvailableAiProviders(providers, direct)).toEqual(providers);
  });

  it("does not default a fresh App Store install to the bundled local provider", () => {
    expect(getSelectedAiProviderId(appStore)).toBe("");
    expect(getSelectedAiProviderId(direct)).toBe(DEFAULT_LOCAL_AI_PROVIDER_ID);
  });

  it("drops a persisted bundled-local selection only on the App Store", () => {
    localStorage.setItem(SELECTED_KEY, DEFAULT_LOCAL_AI_PROVIDER_ID);
    expect(getSelectedAiProviderId(appStore)).toBe("");
    expect(getSelectedAiProviderId(direct)).toBe(DEFAULT_LOCAL_AI_PROVIDER_ID);

    localStorage.setItem(SELECTED_KEY, "openai-1");
    expect(getSelectedAiProviderId(appStore)).toBe("openai-1");
  });
});
