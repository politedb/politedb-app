import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/preact";

const runtimeCommands = vi.hoisted(() => ({
  aiRuntimeStatus: vi.fn(),
  aiRuntimeStart: vi.fn(),
  aiRuntimeStop: vi.fn(),
  aiRuntimeDownloadDefaultModel: vi.fn(),
  aiRuntimeCancelModelDownload: vi.fn(),
  aiRuntimeDeleteDefaultModel: vi.fn(),
}));
vi.mock("src/lib/tauri", () => runtimeCommands);

import { useUnavailableAiRuntimeManager } from "./useAiRuntimeManager";

describe("useUnavailableAiRuntimeManager", () => {
  it("exposes no endpoint or runtime screens and never calls runtime commands", async () => {
    const { result } = renderHook(() =>
      useUnavailableAiRuntimeManager({
        initialEndpoint: "http://127.0.0.1:8080",
        initialModel: "default",
        submitting: false,
      })
    );
    const manager = result.current;
    expect(manager.endpoint).toBe("");
    expect(manager.runtimeStatus).toBeNull();
    expect(manager.showRuntimeLoadingScreen).toBe(false);
    expect(manager.showMissingModelScreen).toBe(false);
    expect(manager.showMissingRuntimeScreen).toBe(false);

    await manager.handleStartBundledRuntime();
    await manager.handleDownloadModel();
    await manager.handleRefreshRuntimeSetup();
    for (const command of Object.values(runtimeCommands)) {
      expect(command).not.toHaveBeenCalled();
    }
  });
});
