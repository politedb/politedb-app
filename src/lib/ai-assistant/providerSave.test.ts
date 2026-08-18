import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validate: vi.fn(),
  save: vi.fn(),
  setKey: vi.fn(),
}));

vi.mock("src/lib/tauri/ai", () => ({
  aiProviderDelete: vi.fn(),
  aiProviderList: vi.fn(),
  aiProviderSaveConfig: mocks.save,
  aiProviderSetKey: mocks.setKey,
  aiProviderTest: vi.fn(),
  aiProviderValidateConfig: mocks.validate,
}));

import {
  makeDefaultAiProvider,
  saveAiProviderWithOptionalKey,
} from "./providers";

describe("saveAiProviderWithOptionalKey", () => {
  beforeEach(() => {
    mocks.validate.mockReset();
    mocks.save.mockReset();
    mocks.setKey.mockReset();
  });

  it("validates cloud model before persisting config or key", async () => {
    const config = makeDefaultAiProvider("openai", { id: "openai-main" });
    mocks.validate.mockRejectedValue(new Error("model_not_found"));

    await expect(
      saveAiProviderWithOptionalKey({ config, apiKey: "secret" })
    ).rejects.toThrow("model_not_found");

    expect(mocks.validate).toHaveBeenCalledWith(config, "secret");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.setKey).not.toHaveBeenCalled();
  });

  it("persists config and key after successful validation", async () => {
    const config = makeDefaultAiProvider("deepseek", {
      id: "deepseek-main",
    });
    mocks.validate.mockResolvedValue(undefined);
    mocks.save.mockResolvedValue(config);
    mocks.setKey.mockResolvedValue({ ...config, apiKeyRef: "stored" });

    const saved = await saveAiProviderWithOptionalKey({
      config,
      apiKey: "secret",
    });

    expect(mocks.validate).toHaveBeenCalledBefore(mocks.save);
    expect(mocks.save).toHaveBeenCalledBefore(mocks.setKey);
    expect(saved.apiKeyRef).toBe("stored");
  });
});
