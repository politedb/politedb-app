import { create } from "zustand";

type PinnedConnectionsSnapshot = {
  pinnedIds: string[];
};

type PinnedConnectionsState = PinnedConnectionsSnapshot & {
  loaded: boolean;
  ensureLoaded: () => void;
  isPinned: (profileId: string) => boolean;
  togglePin: (profileId: string) => void;
  unpin: (profileId: string) => void;
  pruneMissing: (existingProfileIds: string[]) => void;
};

const STORAGE_KEY = "politedb.pinned-connections.v1";

function safeRead(): PinnedConnectionsSnapshot {
  if (typeof window === "undefined") {
    return { pinnedIds: [] };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { pinnedIds: [] };
    const parsed = JSON.parse(raw) as Partial<PinnedConnectionsSnapshot>;
    const pinnedIds = Array.isArray(parsed.pinnedIds)
      ? parsed.pinnedIds.filter(
          (id): id is string => typeof id === "string" && !!id
        )
      : [];
    return { pinnedIds: Array.from(new Set(pinnedIds)) };
  } catch {
    return { pinnedIds: [] };
  }
}

function safeWrite(snapshot: PinnedConnectionsSnapshot) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore storage failures
  }
}

export const usePinnedConnectionsStore = create<PinnedConnectionsState>(
  (set, get) => ({
    loaded: false,
    pinnedIds: [],

    ensureLoaded: () => {
      if (get().loaded) return;
      const snapshot = safeRead();
      set({ loaded: true, pinnedIds: snapshot.pinnedIds });
    },

    isPinned: (profileId) => get().pinnedIds.includes(profileId),

    togglePin: (profileId) => {
      get().ensureLoaded();
      const { pinnedIds } = get();
      const next = pinnedIds.includes(profileId)
        ? pinnedIds.filter((id) => id !== profileId)
        : [profileId, ...pinnedIds.filter((id) => id !== profileId)];
      const snapshot = { pinnedIds: next };
      safeWrite(snapshot);
      set(snapshot);
    },

    unpin: (profileId) => {
      get().ensureLoaded();
      if (!get().pinnedIds.includes(profileId)) return;
      const snapshot = {
        pinnedIds: get().pinnedIds.filter((id) => id !== profileId),
      };
      safeWrite(snapshot);
      set(snapshot);
    },

    pruneMissing: (existingProfileIds) => {
      get().ensureLoaded();
      const existing = new Set(existingProfileIds);
      const next = get().pinnedIds.filter((id) => existing.has(id));
      if (next.length === get().pinnedIds.length) return;
      const snapshot = { pinnedIds: next };
      safeWrite(snapshot);
      set(snapshot);
    },
  })
);
