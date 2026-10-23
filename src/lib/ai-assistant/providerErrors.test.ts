import { describe, expect, it } from "vitest";
import { describeProviderError } from "./providerErrors";

const message = (raw: string, model?: string) =>
  describeProviderError(raw, { model }).message;

describe("describeProviderError", () => {
  it("explains HTTP failures and keeps the code", () => {
    const key = describeProviderError(
      new Error("AI_CHAT_FAILED: 401 Unauthorized invalid_api_key")
    );
    expect(key).toEqual({
      tone: "error",
      message: expect.stringContaining("rejected the API key"),
      code: "AI_CHAT_FAILED: 401 Unauthorized invalid_api_key",
    });
    expect(message("AI_CHAT_FAILED: 403 Forbidden")).toContain("API key");
    expect(message("AI_CHAT_FAILED: 429 Too Many Requests")).toContain(
      "rate-limiting"
    );
    expect(message("AI_CHAT_FAILED: 503 Service Unavailable")).toContain(
      "server error"
    );
    expect(message("AI_CHAT_FAILED: 400 Bad Request")).toContain(
      "rejected the request"
    );
  });

  it("names the model on a 404", () => {
    expect(
      message("AI_CHAT_FAILED: 404 Not Found NOT_FOUND", " gemini-2.5-flash ")
    ).toContain('no model "gemini-2.5-flash"');
    expect(message("AI_CHAT_FAILED: 404 Not Found")).toContain(
      "could not find this model"
    );
  });

  it("explains timeouts, connection and URL errors", () => {
    expect(message("AI_PROVIDER_TEST_TIMEOUT")).toContain("30 seconds");
    expect(message("AI_CHAT_REQUEST_FAILED: connect")).toContain(
      "Could not connect"
    );
    expect(message("AI_CHAT_REQUEST_FAILED: timeout")).toContain("timed out");
    expect(message("AI_PROVIDER_HTTPS_REQUIRED")).toContain("https");
    expect(message("AI_PROVIDER_REDIRECT_BLOCKED: 301")).toContain(
      "redirected"
    );
    expect(message("AI_PROVIDER_MODEL_INVALID: empty response")).toContain(
      "no text"
    );
  });

  it("reports a cancelled test as information, without a code", () => {
    expect(describeProviderError("AI_PROVIDER_TEST_CANCELED")).toEqual({
      tone: "info",
      message: "Test cancelled.",
    });
  });

  it("explains key and model-list problems", () => {
    expect(describeProviderError("AI_PROVIDER_API_KEY_MISSING")).toEqual({
      tone: "error",
      message: "Enter an API key first.",
    });
    expect(message("AI_PROVIDER_API_KEY_REQUIRED")).toContain(
      "needs an API key"
    );
    expect(message("AI_PROVIDER_KEYCHAIN_FAILED")).toContain("keychain");
    expect(message("AI_PROVIDER_MODELS_INVALID")).toContain("model list");
  });

  it("keeps unknown errors as they are", () => {
    expect(describeProviderError("AI_PROVIDER_LABEL_REQUIRED")).toEqual({
      tone: "error",
      message: "AI_PROVIDER_LABEL_REQUIRED",
    });
    expect(message("AI_CHAT_FAILED: 4040")).toBe("AI_CHAT_FAILED: 4040");
  });
});
