import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayPlan, politeDbAiListModels } from "./ai";

vi.mock("src/lib/tauri", () => ({
  licenseStateLoad: vi.fn().mockResolvedValue({
    license_id: "license_test",
    plan_name: "ultimate",
    paid_license: true,
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gatewayPlan", () => {
  it("sends the paid tier only for an active paid license", () => {
    expect(gatewayPlan({ paid_license: true })).toBe("ultimate");
    // Trials, expired or free licenses, and an unknown state stay free; the plan name
    // alone never decides.
    for (const license of [
      { paid_license: false },
      { paid_license: false, plan_name: "Ultimate" } as {
        paid_license: boolean;
      },
      {},
      null,
      undefined,
    ]) {
      expect(gatewayPlan(license)).toBe("free");
    }
  });
});

describe("politeDb backend AI client", () => {
  it("does not duplicate /api when listing backend models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          defaultProvider: "openai",
          defaultModel: "llama-3.1-8b-instant",
          dailyRequestsLimit: 20,
          dailyTokensLimit: 50_000,
          providers: [],
          supportedTools: [],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await politeDbAiListModels("workspace_test");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://localhost:4000/api/ai/models"
    );
  });
});
