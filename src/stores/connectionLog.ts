import { create } from "zustand";
import { v4 as uuid } from "uuid";

import type { ConnectionProfile } from "src/lib/tauri";
import type { ProfileTab } from "src/stores/screen";
import {
  getLogDeviceName,
  profileConnectionHost,
  profileDbUser,
} from "src/utils/connectionLog";
import type { ConnectionOpenLogEntry } from "src/types";
import type { DatabaseEngine } from "src/types";

const MAX_ENTRIES = 300;

export type ConnectionLogTabRef = Pick<
  ProfileTab,
  "id" | "profileId" | "label" | "engine"
>;

type ConnectionLogState = {
  entries: ConnectionOpenLogEntry[];
  activeByTabId: Record<string, string>;

  hydrate: (
    entries: ConnectionOpenLogEntry[],
    activeByTabId?: Record<string, string>
  ) => void;
  openSession: (tab: ProfileTab, profile: ConnectionProfile) => Promise<void>;
  failSession: (
    tab: ConnectionLogTabRef,
    error: string,
    profile?: ConnectionProfile | null
  ) => Promise<void>;
  endSession: (tabId: string, status?: "closed" | "failed", error?: string) => void;
  closeOrphanedActiveSessions: (closedAt?: number) => void;
  clearLog: () => void;
  getPersistedSnapshot: () => {
    entries: ConnectionOpenLogEntry[];
    activeByTabId: Record<string, string>;
  };
};

function schedulePersistentSave() {
  queueMicrotask(async () => {
    const mod = await import("src/stores/persistentStore");
    mod.usePersistentStore.getState().scheduleSave();
  });
}

function clampEntries(entries: ConnectionOpenLogEntry[]) {
  if (entries.length <= MAX_ENTRIES) return entries;
  return entries.slice(entries.length - MAX_ENTRIES);
}

export const useConnectionLogStore = create<ConnectionLogState>((set, get) => ({
  entries: [],
  activeByTabId: {},

  hydrate: (entries, activeByTabId = {}) => {
    set({
      entries: clampEntries(entries),
      activeByTabId: { ...activeByTabId },
    });
  },

  openSession: async (tab, profile) => {
    if (get().activeByTabId[tab.id]) return;

    const deviceName = await getLogDeviceName();
    const id = uuid();
    const entry: ConnectionOpenLogEntry = {
      id,
      tabId: tab.id,
      profileId: profile.id,
      profileLabel: tab.label || profile.label || "Unnamed Connection",
      engine: tab.engine || profile.engine,
      host: profileConnectionHost(profile),
      dbUser: profileDbUser(profile),
      deviceName,
      openedAt: Date.now(),
      status: "active",
    };

    set((s) => ({
      entries: clampEntries([...s.entries, entry]),
      activeByTabId: { ...s.activeByTabId, [tab.id]: id },
    }));
    schedulePersistentSave();
  },

  failSession: async (tab, error, profile) => {
    const { useProfileStore } = await import("src/stores/profile");
    const resolved =
      profile ??
      useProfileStore.getState().profiles.find((p) => p.id === tab.profileId);

    const deviceName = await getLogDeviceName();
    const now = Date.now();
    const entry: ConnectionOpenLogEntry = {
      id: uuid(),
      tabId: tab.id,
      profileId: tab.profileId || resolved?.id || "",
      profileLabel:
        tab.label || resolved?.label || "Unnamed Connection",
      engine: (tab.engine || resolved?.engine || "postgres") as DatabaseEngine,
      host: resolved ? profileConnectionHost(resolved) : tab.label,
      dbUser: resolved ? profileDbUser(resolved) : undefined,
      deviceName,
      openedAt: now,
      closedAt: now,
      status: "failed",
      error: error.trim().slice(0, 500),
    };

    set((s) => ({
      entries: clampEntries([...s.entries, entry]),
    }));
    schedulePersistentSave();
  },

  endSession: (tabId, status = "closed", error) => {
    const logId = get().activeByTabId[tabId];
    if (!logId) return;

    const closedAt = Date.now();
    set((s) => {
      const { [tabId]: _removed, ...activeByTabId } = s.activeByTabId;
      return {
        activeByTabId,
        entries: s.entries.map((entry) =>
          entry.id === logId
            ? {
                ...entry,
                closedAt,
                status,
                error: error ?? entry.error,
              }
            : entry
        ),
      };
    });
    schedulePersistentSave();
  },

  closeOrphanedActiveSessions: (closedAt = Date.now()) => {
    const activeIds = new Set(Object.values(get().activeByTabId));
    if (activeIds.size === 0) return;

    set((s) => ({
      activeByTabId: {},
      entries: s.entries.map((entry) =>
        activeIds.has(entry.id) && entry.status === "active"
          ? { ...entry, closedAt, status: "closed" as const }
          : entry
      ),
    }));
    schedulePersistentSave();
  },

  clearLog: () => {
    set({ entries: [], activeByTabId: {} });
    schedulePersistentSave();
  },

  getPersistedSnapshot: () => ({
    entries: get().entries,
    activeByTabId: get().activeByTabId,
  }),
}));

async function resolveProfile(profileId: string) {
  const { useProfileStore } = await import("src/stores/profile");
  return useProfileStore.getState().profiles.find((p) => p.id === profileId);
}

export async function recordConnectionSessionOpened(tab: ProfileTab) {
  const profile = await resolveProfile(tab.profileId);
  if (!profile) return;
  await useConnectionLogStore.getState().openSession(tab, profile);
}

export async function recordConnectionSessionFailed(
  tab: ConnectionLogTabRef,
  error: string,
  profile?: ConnectionProfile | null
) {
  const resolved =
    profile ?? (tab.profileId ? await resolveProfile(tab.profileId) : null);
  await useConnectionLogStore.getState().failSession(tab, error, resolved);
}
