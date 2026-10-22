import type { ConnectionProfile } from "src/lib/tauri/types";
import type {
  AiProviderConfig,
  DatabaseEngine,
  KeychainSortMode,
} from "src/types";
import { AI_PROVIDER_LABELS } from "src/lib/ai-assistant/providers";
import { connectionProfileSummary } from "src/lib/connection/profileSummary";
import { SUPPORTED_DATABASES } from "src/constant";

/** What a keychain card shows next to its text. */
export type KeychainIcon =
  | { kind: "database"; engine: DatabaseEngine }
  | { kind: "ssh" }
  | { kind: "ai" }
  | { kind: "key" };

export type KeychainDisplay = {
  /** What the key belongs to: the connection or AI provider name. */
  title: string;
  /** Kind of key, such as "PostgreSQL", "SSH" or "AI key"; empty for other keys. */
  badge: string;
  /** Where it points: `host:port • database`, `user@ssh-host` or the model. */
  detail: string;
  icon: KeychainIcon;
  /** No connection or AI provider uses this key any more. */
  unused: boolean;
};

/**
 * Sources that give keychain entries readable names. A missing list means it is
 * not known (still loading or failed to load): its keys are then never called
 * unused, so nothing in use can be offered for cleanup.
 */
export type KeychainNameSources = {
  aiProviders?: readonly AiProviderConfig[];
  profiles?: readonly ConnectionProfile[];
};

/** Physical name of AI provider keys (`ai::provider::key_ref` in the backend). */
const AI_KEY_RE = /^politedb:ai:(.+):api_key$/;
/** Logical name of connection secrets (`credential_identity::branded_logical_key`). */
const PROFILE_KEY_RE =
  /^politedb\/profile\/([^/]+)\/credential\/(database|ssh)$/;

function engineLabel(engine: string) {
  return SUPPORTED_DATABASES.find((d) => d.engine === engine)?.label ?? engine;
}

function sshTarget(profile: ConnectionProfile) {
  const ssh = profile.input?.ssh;
  if (!ssh?.ssh_host?.trim()) return "";
  const user = ssh.ssh_user?.trim();
  const port =
    ssh.ssh_port != null && ssh.ssh_port !== 22 ? `:${ssh.ssh_port}` : "";
  return `${user ? `${user}@` : ""}${ssh.ssh_host.trim()}${port}`;
}

/**
 * Card text for a keychain entry. Keys are stored by id, so names come from the
 * current settings and follow renames/model changes:
 * - AI keys: the provider name, "AI key", and its default model.
 * - Connection secrets: the connection name, its engine (or "SSH"), and where it
 *   points, so connections with the same name can be told apart.
 * Keys nothing uses any more are marked `unused`. Other keys show their last path
 * segments, as before.
 */
export function keychainDisplay(
  keyName: string,
  sources: KeychainNameSources = {}
): KeychainDisplay {
  const ai = AI_KEY_RE.exec(keyName);
  if (ai) {
    const providers = sources.aiProviders;
    if (!providers) {
      return {
        title: "AI key",
        badge: "AI key",
        detail: "",
        icon: { kind: "ai" },
        unused: false,
      };
    }
    const provider =
      providers.find((p) => p.apiKeyRef === keyName) ??
      providers.find((p) => p.id === ai[1]);
    if (!provider) {
      return {
        title: "Unused AI key",
        badge: "AI key",
        detail: "",
        icon: { kind: "ai" },
        unused: true,
      };
    }
    return {
      title:
        provider.label.trim() ||
        AI_PROVIDER_LABELS[provider.kind] ||
        provider.kind,
      badge: "AI key",
      detail: provider.defaultModel.trim() || "No default model",
      icon: { kind: "ai" },
      unused: false,
    };
  }

  const profileKey = PROFILE_KEY_RE.exec(keyName);
  if (profileKey) {
    const [, profileId, purpose] = profileKey;
    const ssh = purpose === "ssh";
    if (!sources.profiles) {
      return {
        title: "Connection key",
        badge: ssh ? "SSH" : "Database",
        detail: "",
        icon: ssh ? { kind: "ssh" } : { kind: "key" },
        unused: false,
      };
    }
    const profile = sources.profiles.find(
      (p) => p.id.toLowerCase() === profileId.toLowerCase()
    );
    if (!profile) {
      return {
        title: "Unused connection key",
        badge: ssh ? "SSH" : "Database",
        detail: "",
        icon: ssh ? { kind: "ssh" } : { kind: "key" },
        unused: true,
      };
    }
    const engine = profile.engine;
    return {
      title: profile.label.trim() || "Unnamed connection",
      badge: ssh ? "SSH" : engineLabel(engine),
      detail: ssh
        ? sshTarget(profile)
        : connectionProfileSummary(profile).subtitle,
      icon: ssh ? { kind: "ssh" } : { kind: "database", engine },
      unused: false,
    };
  }

  const parts = keyName.split(":").filter(Boolean);
  const labelParts = (parts[parts.length - 1] ?? keyName).split("/").slice(-3);
  const title = labelParts.slice(-2).join("/") || keyName;
  const detail = labelParts[0] ?? "";
  return {
    title,
    badge: "",
    detail: detail === title ? "" : detail,
    icon: { kind: "key" },
    unused: false,
  };
}

/**
 * Orders keys by what their cards show (name, then kind, then target), so A-Z
 * matches the screen; the raw key breaks ties so the order is stable.
 */
export function sortKeychainKeys(
  keys: readonly string[],
  displays: ReadonlyMap<string, KeychainDisplay>,
  mode: KeychainSortMode
): string[] {
  const fields = (k: string) => {
    const d = displays.get(k);
    return [d?.title ?? k, d?.badge ?? "", d?.detail ?? ""];
  };
  const compare = (a: string, b: string) => {
    const x = fields(a);
    const y = fields(b);
    for (let i = 0; i < x.length; i++) {
      const c = x[i]!.localeCompare(y[i]!, undefined, {
        sensitivity: "base",
        numeric: true,
      });
      if (c) return c;
    }
    return a.localeCompare(b);
  };
  return [...keys].sort((a, b) =>
    mode === "label-desc" ? compare(b, a) : compare(a, b)
  );
}

export type KeychainGroupId = "ai" | "database" | "ssh" | "other" | "unused";

export type KeychainGroup = {
  id: KeychainGroupId;
  label: string;
  keys: string[];
};

const GROUP_ORDER: ReadonlyArray<{ id: KeychainGroupId; label: string }> = [
  { id: "ai", label: "AI providers" },
  { id: "database", label: "Database connections" },
  { id: "ssh", label: "SSH" },
  { id: "other", label: "Other keys" },
  // Last: keys to clean up.
  { id: "unused", label: "Unused" },
];

export function keychainGroupOf(display: KeychainDisplay): KeychainGroupId {
  if (display.unused) return "unused";
  if (display.icon.kind === "ai") return "ai";
  if (display.icon.kind === "ssh") return "ssh";
  if (display.icon.kind === "database") return "database";
  return "other";
}

/**
 * Splits already sorted keys into the screen's groups, keeping their order
 * within each group. Empty groups are left out.
 */
export function groupKeychainKeys(
  sortedKeys: readonly string[],
  displays: ReadonlyMap<string, KeychainDisplay>
): KeychainGroup[] {
  const byGroup = new Map<KeychainGroupId, string[]>();
  for (const key of sortedKeys) {
    const display = displays.get(key) ?? keychainDisplay(key);
    const id = keychainGroupOf(display);
    byGroup.set(id, [...(byGroup.get(id) ?? []), key]);
  }
  return GROUP_ORDER.flatMap(({ id, label }) => {
    const keys = byGroup.get(id);
    return keys?.length ? [{ id, label, keys }] : [];
  });
}
