import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  testDraft: vi.fn(),
  listModels: vi.fn(),
}));

vi.mock("src/lib/tauri/ai", () => ({
  aiProviderDelete: vi.fn(),
  aiProviderList: vi.fn(),
  aiProviderSave: mocks.save,
  aiProviderListModels: mocks.listModels,
  aiProviderTestDraft: mocks.testDraft,
  aiProviderCancelListModels: vi.fn(),
}));

import { makeDefaultAiProvider, saveAiProvider } from "./providers";

describe("saveAiProvider (plan R3, R13)", () => {
  beforeEach(() => {
    mocks.save.mockReset();
    mocks.testDraft.mockReset();
    mocks.listModels.mockReset();
  });

  it("saves config and key change in one backend call without network checks", async () => {
    const config = makeDefaultAiProvider("openai", { id: "openai-main" });
    mocks.save.mockResolvedValue({ ...config, apiKeyRef: "ref" });
    const changed = vi.fn();
    window.addEventListener("politedb-ai-providers-changed", changed);

    const saved = await saveAiProvider({
      config,
      keyChange: { action: "set", value: "secret" },
    });

    window.removeEventListener("politedb-ai-providers-changed", changed);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith(config, {
      action: "set",
      value: "secret",
    });
    expect(mocks.testDraft).not.toHaveBeenCalled();
    expect(mocks.listModels).not.toHaveBeenCalled();
    expect(saved.apiKeyRef).toBe("ref");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("propagates ordinary failures without announcing a change", async () => {
    mocks.save.mockRejectedValue("AI_PROVIDER_API_KEY_REQUIRED");
    const changed = vi.fn();
    window.addEventListener("politedb-ai-providers-changed", changed);
    await expect(
      saveAiProvider({
        config: makeDefaultAiProvider("local_openai_compatible"),
        keyChange: { action: "keep" },
      })
    ).rejects.toBe("AI_PROVIDER_API_KEY_REQUIRED");
    window.removeEventListener("politedb-ai-providers-changed", changed);
    expect(changed).not.toHaveBeenCalled();
  });

  it("asks panels to reload from disk when rollback failed", async () => {
    mocks.save.mockRejectedValue("AI_PROVIDER_SAVE_ROLLBACK_FAILED");
    const changed = vi.fn();
    window.addEventListener("politedb-ai-providers-changed", changed);
    await expect(
      saveAiProvider({
        config: makeDefaultAiProvider("openai"),
        keyChange: { action: "set", value: "k" },
      })
    ).rejects.toBe("AI_PROVIDER_SAVE_ROLLBACK_FAILED");
    window.removeEventListener("politedb-ai-providers-changed", changed);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
