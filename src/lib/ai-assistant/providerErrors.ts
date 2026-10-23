/**
 * Plain-language messages for AI provider errors shown in AI Provider
 * Settings. The backend sends fixed codes only (never the provider's own
 * message, which can echo the prompt); the code is kept for support.
 */
export type ProviderErrorText = {
  tone: "error" | "info";
  message: string;
  /** The raw code, shown small under the message; omitted when it adds nothing. */
  code?: string;
};

function httpStatus(raw: string): number | null {
  const match = raw.match(/^AI_CHAT_FAILED: (\d{3})\b/);
  return match ? Number(match[1]) : null;
}

export function describeProviderError(
  error: unknown,
  context: { model?: string } = {}
): ProviderErrorText {
  const raw =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  const model = context.model?.trim();
  const fail = (message: string): ProviderErrorText => ({
    tone: "error",
    message,
    code: raw,
  });

  if (raw.startsWith("AI_PROVIDER_TEST_CANCELED")) {
    return { tone: "info", message: "Test cancelled." };
  }
  if (raw.startsWith("AI_PROVIDER_TEST_TIMEOUT")) {
    return fail(
      "The provider did not answer within 30 seconds. Check the host and your network, then try again."
    );
  }

  const status = httpStatus(raw);
  if (status === 401 || status === 403) {
    return fail(
      "The provider rejected the API key, or the key has no access to this model. Check the key."
    );
  }
  if (status === 404) {
    return fail(
      model
        ? `The provider has no model "${model}" for this key at this host. Check the model ID (it must be one this key can use) and the host and sub path.`
        : "The provider could not find this model or endpoint. Check the model ID and the host and sub path."
    );
  }
  if (status === 429) {
    return fail(
      "The provider is rate-limiting this key, or its quota is used up. Wait a moment, or check the plan and billing."
    );
  }
  if (status !== null && status >= 500) {
    return fail("The provider had a server error. Try again in a moment.");
  }
  if (status === 400) {
    return fail(
      "The provider rejected the request. Check the model ID and the settings."
    );
  }

  if (raw.startsWith("AI_CHAT_REQUEST_FAILED: timeout")) {
    return fail("The request to the provider timed out. Try again.");
  }
  if (raw.startsWith("AI_CHAT_REQUEST_FAILED: connect")) {
    return fail(
      "Could not connect to the host. Check the host and your network."
    );
  }
  if (raw.startsWith("AI_CHAT_REQUEST_FAILED")) {
    return fail("The request to the provider failed. Try again.");
  }
  if (raw.startsWith("AI_PROVIDER_HTTPS_REQUIRED")) {
    return fail(
      "This host needs https. Plain http works only for localhost and LAN addresses."
    );
  }
  if (raw.startsWith("AI_PROVIDER_URL_HOST_NOT_ALLOWED")) {
    return fail("This host is not allowed. Check the host.");
  }
  if (raw.startsWith("AI_PROVIDER_URL_INVALID")) {
    return fail("The host is not a valid URL. Check the host and sub path.");
  }
  if (raw.startsWith("AI_PROVIDER_REDIRECT_BLOCKED")) {
    return fail(
      "The host redirected the request. Use the provider's final API address."
    );
  }
  if (
    raw.startsWith("AI_PROVIDER_MODEL_INVALID") ||
    raw.startsWith("AI_CHAT_OUTPUT_TOKEN_LIMIT")
  ) {
    return fail(
      "The model answered with no text. Try again, or choose another model."
    );
  }
  if (raw.startsWith("AI_CHAT_REFUSED")) {
    return fail("The model declined the test request. Try another model.");
  }
  if (raw.startsWith("AI_PROVIDER_MODEL_REQUIRED")) {
    return { tone: "error", message: "Choose a model first." };
  }
  return { tone: "error", message: raw };
}
