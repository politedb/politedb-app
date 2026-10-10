import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  FEATURE_UNAVAILABLE_IN_DISTRIBUTION,
  openExternalUrl,
} from "./license";

describe("openExternalUrl", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("opens through the backend without falling back on success", async () => {
    invokeMock.mockResolvedValue(undefined);
    const fallback = vi.fn();
    await openExternalUrl("https://example.com", fallback);
    expect(invokeMock).toHaveBeenCalledWith("license_open_external_url", {
      url: "https://example.com",
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back when the system opener fails", async () => {
    invokeMock.mockRejectedValue("FAILED_TO_OPEN_URL: exited with status 1");
    const fallback = vi.fn();
    await openExternalUrl("https://example.com", fallback);
    expect(fallback).toHaveBeenCalledWith("https://example.com");
  });

  it("never falls back when the distribution policy blocks the URL", async () => {
    invokeMock.mockRejectedValue(FEATURE_UNAVAILABLE_IN_DISTRIBUTION);
    const fallback = vi.fn();
    await openExternalUrl("https://politedb.com/pricing", fallback);
    expect(fallback).not.toHaveBeenCalled();
  });
});
