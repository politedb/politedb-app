import { afterEach, describe, expect, it, vi } from "vitest";
import { planFromLicensePlanName, politeDbAiListModels } from "./ai";

vi.mock("src/lib/tauri", () => ({
  licenseStateLoad: vi.fn().mockResolvedValue({
    license_id: "license_test",
    plan_name: "ultimate",
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("planFromLicensePlanName", () => {
  it.each(["Pro", "pro", " Pro plan ", "Ultimate", "ultimate"])(
    "maps paid plan %j to the ultimate AI tier",
    (planName) => {
      expect(planFromLicensePlanName(planName)).toBe("ultimate");
    }
  );

  it.each([null, undefined, "", "Free", "Polar License"])(
    "maps %j to the free AI tier",
    (planName) => {
      expect(planFromLicensePlanName(planName)).toBe("free");
    }
  );
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
