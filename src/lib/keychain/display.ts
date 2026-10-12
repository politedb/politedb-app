import type { ConnectionProfile } from "src/lib/tauri/types";
import type { AiProviderConfig } from "src/types";

export type KeychainDisplay = { title: string; subtitle: string };

/** Sources that give keychain entries readable names. */
export type KeychainNameSources = {
  aiProviders?: readonly AiProviderConfig[];
  profiles?: readonly ConnectionProfile[];
};

/** Physical name of AI provider keys (`ai::provider::key_ref` in the backend). */
const AI_KEY_RE = /^politedb:ai:(.+):api_key$/;
/** Logical name of connection secrets (`credential_identity::branded_logical_key`). */
const PROFILE_KEY_RE =
  /^politedb\/profile\/([^/]+)\/credential\/(database|ssh)$/;

/**
 * Card text for a keychain entry. Keys are stored by id, so names come from the
 * current settings and follow renames/model changes:
 * - AI keys: `credential/<provider kind>`, default model as subtitle.
 * - Connection secrets: `credential/<engine>` (or `credential/ssh`), connection name
 *   as subtitle.
 * Other keys show their last path segments, as before.
 */
export function keychainDisplay(
  keyName: string,
  sources: KeychainNameSources = {}
): KeychainDisplay {
  const ai = AI_KEY_RE.exec(keyName);
  if (ai) {
    const providers = sources.aiProviders ?? [];
    const provider =
      providers.find((p) => p.apiKeyRef === keyName) ??
      providers.find((p) => p.id === ai[1]);
    if (!provider) {
      return { title: "credential/ai", subtitle: "Unused AI key" };
    }
    return {
      title: `credential/${provider.kind.toLowerCase()}`,
      subtitle: provider.defaultModel.trim() || "No default model",
    };
  }

  const profileKey = PROFILE_KEY_RE.exec(keyName);
  if (profileKey) {
    const [, profileId, purpose] = profileKey;
    const profile = (sources.profiles ?? []).find(
      (p) => p.id.toLowerCase() === profileId.toLowerCase()
    );
    const engine = purpose === "ssh" ? "ssh" : profile?.engine.toLowerCase();
    return {
      title: `credential/${engine ?? "database"}`,
      subtitle: profile
        ? profile.label.trim() || "Unnamed connection"
        : "Unused connection key",
    };
  }

  const parts = keyName.split(":").filter(Boolean);
  const labelParts = (parts[parts.length - 1] ?? keyName).split("/").slice(-3);
  const title = labelParts.slice(-2).join("/") || keyName;
  return { title, subtitle: labelParts[0] ?? "" };
}
