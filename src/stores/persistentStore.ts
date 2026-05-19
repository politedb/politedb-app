import { create } from "zustand";

import { useProfileStore } from "src/stores/profile";
import {
  ProfileTab,
  QuerySafetyMode,
  useScreenStore,
} from "src/stores/screen";

import type { ConnectionOpenLogEntry, OpenWindow, SqlEditorWindow } from "src/types";
import { useConnectionLogStore } from "src/stores/connectionLog";
import { debounce } from "../utils/common";
import {
  persistentClear,
  persistentLoad,
  persistentSave,
} from "../lib/tauri/persistent";

/**
 * Persistent Store
 *
 * Persists user-facing app state across restarts:
 * - Open profile tabs
 * - Windows and editors
 * - SQL editor content (drafts)
 *
 * Does NOT persist:
 * - Runtime DB connections
 * - Query results, caches, or metadata
 *
 * Autosave strategy (no subscribe):
 * - ScreenStore actions that mutate persistent state should call:
 *   usePersistentStore.getState().scheduleSave()
 *
 * This avoids saving on unrelated state changes and keeps autosave predictable.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

type PersistedProfileTab = Pick<
  ProfileTab,
  "id" | "label" | "engine" | "profileId" | "isLocked" | "querySafetyMode"
>;

type PersistedWindow =
  | Pick<SqlEditorWindow, "id" | "type" | "title" | "content">
  | OpenWindow;

export type PersistentSnapshotV1 = {
  version: 1;
  savedAt: number;

  activeProfileScreen: string;
  profileTabs: PersistedProfileTab[];

  /** Per-profile query safety; kept when all tabs for that profile are closed. */
  querySafetyByProfileId?: Record<string, QuerySafetyMode>;

  openWindows: Record<string, PersistedWindow[]>;
  activeWindowId: Record<string, string | null>;

  connectionOpenLog?: ConnectionOpenLogEntry[];
  activeConnectionLogByTabId?: Record<string, string>;
};

export type PersistentSnapshot = PersistentSnapshotV1;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isSnapshotV1(x: unknown): x is PersistentSnapshotV1 {
  if (!x || typeof x !== "object") return false;
  const v = x as PersistentSnapshotV1;

  return (
    v.version === 1 &&
    typeof v.savedAt === "number" &&
    typeof v.activeProfileScreen === "string" &&
    Array.isArray(v.profileTabs) &&
    typeof v.openWindows === "object" &&
    typeof v.activeWindowId === "object"
  );
}

function clampSnapshotV1(
  snap: PersistentSnapshotV1,
  opts: { maxTabs?: number; maxWindowsPerTab?: number } = {}
): PersistentSnapshotV1 {
  const maxTabs = opts.maxTabs ?? 50;
  const maxWindowsPerTab = opts.maxWindowsPerTab ?? 50;

  const profileTabs = snap.profileTabs.slice(0, maxTabs);

  const openWindows: Record<string, PersistedWindow[]> = {};
  const activeWindowId: Record<string, string | null> = {};

  for (const tab of profileTabs) {
    const list = (snap.openWindows?.[tab.id] ?? []).slice(0, maxWindowsPerTab);
    openWindows[tab.id] = list;
    const lastId = list.length > 0 ? list[list.length - 1].id : null;
    activeWindowId[tab.id] = snap.activeWindowId?.[tab.id] ?? lastId;
  }

  return { ...snap, profileTabs, openWindows, activeWindowId };
}

function normalizeSafetyMode(v: unknown): QuerySafetyMode {
  if (v === "lock" || v === "safe" || v === "default") return v;
  return "default";
}

function buildSnapshotFromScreen(): PersistentSnapshotV1 {
  const s = useScreenStore.getState();

  const querySafetyByProfileId: Record<string, QuerySafetyMode> = {
    ...s.querySafetyByProfileId,
  };
  for (const t of s.profileTabs) {
    const mode =
      t.querySafetyMode ?? (t.isLocked ? "lock" : ("default" as const));
    querySafetyByProfileId[t.profileId] = normalizeSafetyMode(mode);
  }

  const logSnap = useConnectionLogStore.getState().getPersistedSnapshot();

  return {
    version: 1,
    savedAt: Date.now(),

    activeProfileScreen: s.activeProfileScreen,
    profileTabs: s.profileTabs.map((t) => ({
      id: t.id,
      label: t.label,
      engine: t.engine,
      profileId: t.profileId,
      isLocked: t.isLocked,
      querySafetyMode: t.querySafetyMode,
    })),

    querySafetyByProfileId,

    openWindows: s.openWindows,
    activeWindowId: s.activeWindowId,

    connectionOpenLog: logSnap.entries,
    activeConnectionLogByTabId: logSnap.activeByTabId,
  };
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

type PersistentStoreState = {
  installed: boolean;
  restoredOnce: boolean;
  busy: boolean;
  error: string | null;

  autosaveEnabled: boolean;
  autosaveDebounceMs: number;

  lastSavedAt: number | null;

  /**
   * Install autosave plumbing (no subscriptions).
   * Keep this call to establish internal debounced writer.
   */
  install: () => void;

  /**
   * Call this from persist-worthy actions in ScreenStore.
   * It will debounce and save the latest snapshot to backend.
   */
  scheduleSave: () => void;

  saveNow: () => Promise<void>;
  clear: () => Promise<void>;

  restore: () => Promise<void>;
};

let debouncedWriter: null | (() => void) = null;

export const usePersistentStore = create<PersistentStoreState>((set, get) => ({
  installed: false,
  restoredOnce: false,
  busy: false,
  error: null,

  autosaveEnabled: true,
  autosaveDebounceMs: 800,

  lastSavedAt: null,

  install: () => {
    if (get().installed) return;

    // Create a single debounced writer instance.
    debouncedWriter = debounce(async () => {
      if (!get().autosaveEnabled) return;

      try {
        const snap = buildSnapshotFromScreen();
        await persistentSave(snap);
        set({ lastSavedAt: snap.savedAt, error: null });
      } catch (e: any) {
        set({ error: e?.message ? String(e.message) : String(e) });
      }
    }, get().autosaveDebounceMs);

    set({ installed: true });
  },

  scheduleSave: () => {
    // install() must be called once at startup
    if (!get().installed) return;
    if (!get().autosaveEnabled) return;

    // In case install() wasn't called for some reason, be defensive.
    if (!debouncedWriter) {
      debouncedWriter = debounce(async () => {
        if (!get().autosaveEnabled) return;

        try {
          const snap = buildSnapshotFromScreen();
          await persistentSave(snap);
          set({ lastSavedAt: snap.savedAt, error: null });
        } catch (e: any) {
          set({ error: e?.message ? String(e.message) : String(e) });
        }
      }, get().autosaveDebounceMs);
    }

    debouncedWriter();
  },

  saveNow: async () => {
    set({ busy: true, error: null });
    try {
      const snap = buildSnapshotFromScreen();
      await persistentSave(snap);
      set({ busy: false, lastSavedAt: snap.savedAt });
    } catch (e: any) {
      set({ busy: false, error: e?.message ? String(e.message) : String(e) });
    }
  },

  clear: async () => {
    set({ busy: true, error: null });
    try {
      await persistentClear();
      set({ busy: false });
    } catch (e: any) {
      set({ busy: false, error: e?.message ? String(e.message) : String(e) });
    }
  },

  restore: async () => {
    if (get().restoredOnce) return;

    set({ busy: true, error: null });

    try {
      // Load profiles first so profileId can be validated
      await useProfileStore.getState().loadProfiles();

      const raw = await persistentLoad();
      if (!isSnapshotV1(raw)) {
        set({ busy: false, restoredOnce: true });
        return;
      }

      const snap = clampSnapshotV1(raw);

      useConnectionLogStore
        .getState()
        .hydrate(
          Array.isArray(snap.connectionOpenLog) ? snap.connectionOpenLog : [],
          snap.activeConnectionLogByTabId ?? {}
        );
      useConnectionLogStore
        .getState()
        .closeOrphanedActiveSessions(snap.savedAt);

      const profiles = useProfileStore.getState().profiles;
      const profileIdSet = new Set(profiles.map((p) => p.id));

      const profileTabs = snap.profileTabs
        .filter((t) => profileIdSet.has(t.profileId))
        .map((t) => {
          const mode = normalizeSafetyMode(
            t.querySafetyMode ?? (t.isLocked ? "lock" : "default")
          );
          return {
            ...t,
            querySafetyMode: mode,
            isLocked: mode === "lock",
          };
        });

      const querySafetyByProfileId: Record<string, QuerySafetyMode> = {};
      const rawMap = snap.querySafetyByProfileId;
      if (rawMap && typeof rawMap === "object") {
        for (const [pid, v] of Object.entries(rawMap)) {
          if (profileIdSet.has(pid)) {
            querySafetyByProfileId[pid] = normalizeSafetyMode(v);
          }
        }
      }
      for (const t of profileTabs) {
        querySafetyByProfileId[t.profileId] = normalizeSafetyMode(
          t.querySafetyMode ?? (t.isLocked ? "lock" : "default")
        );
      }

      const openWindows: Record<string, PersistedWindow[]> = {};
      const activeWindowId: Record<string, string | null> = {};

      for (const tab of profileTabs) {
        const list = snap.openWindows[tab.id] ?? [];
        openWindows[tab.id] = list;
        const lastId = list.length > 0 ? list[list.length - 1].id : null;
        activeWindowId[tab.id] = snap.activeWindowId[tab.id] ?? lastId;
      }

      const nextActive =
        profileTabs.length === 0
          ? "main"
          : snap.activeProfileScreen === "main"
            ? profileTabs[0].id
            : profileTabs.some((t) => t.id === snap.activeProfileScreen)
              ? snap.activeProfileScreen
              : profileTabs[0].id;

      useScreenStore.setState({
        activeProfileScreen: nextActive,
        profileTabs: profileTabs,
        querySafetyByProfileId,
        openWindows: openWindows,
        activeWindowId,
      });

      set({ busy: false, restoredOnce: true });
    } catch (e: any) {
      set({
        busy: false,
        restoredOnce: true,
        error: e?.message ? String(e.message) : String(e),
      });
    }
  },
}));
