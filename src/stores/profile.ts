import { create } from "zustand";
import type { ConnectionProfile } from "src/lib/tauri";
import { profileList, profileRemove } from "src/lib/tauri";
import { usePinnedConnectionsStore } from "src/stores/pinnedConnections";
import { useScreenStore } from "src/stores/screen";
import { tabLabelFor } from "src/lib/tabs/tabTarget";
import { DatabaseEngine } from "../types";

/**
 * ProfileStore manages:
 * 1) Domain state: connection profiles list (from backend)
 * 2) UI state: which modal is open (new/edit) + which engine form is selected
 *
 * Note:
 * - busy/error are shared across load/remove/save actions (global busy).
 * - saveProfile currently updates local store only (does NOT call backend).
 */
type ProfileState = {
  /* -------------------------------------------------------------------------- */
  /* Domain state                                                               */
  /* -------------------------------------------------------------------------- */
  profiles: ConnectionProfile[];
  busy: boolean; // global "in progress" flag for profile actions
  error: string | null;

  /** Selected profile id for edit/details contexts */
  selectedProfileId: string | undefined;

  /** Fetch profiles from backend */
  loadProfiles: () => Promise<void>;

  /**
   * Publishes a complete list a backend mutation returned (an import), so
   * the tabs of changed profiles are invalidated at once, before any later
   * list request (R16).
   */
  publishProfiles: (list: ConnectionProfile[]) => void;

  /** Remove profile from backend, then from local list */
  removeProfile: (profileId: string) => Promise<void>;

  /**
   * Save/update profile in local state only.
   * If you want to persist, call backend (e.g. profileSave/profileUpsert) before this.
   */
  saveProfile: (profile: ConnectionProfile) => Promise<void>;

  /** Convenience selector */
  getProfileById: (id?: string) => ConnectionProfile | undefined;

  /** Update selected profile id */
  selectProfile: (id: string | undefined) => void;

  /* -------------------------------------------------------------------------- */
  /* UI state                                                                   */
  /* -------------------------------------------------------------------------- */
  showNewConnection: boolean; // "New connection" modal visibility
  showEditProfile: boolean; // "Edit profile" modal visibility

  /**
   * Which database form to display inside the "new connection" flow.
   * undefined = show engine picker
   */
  showDatabaseForm: DatabaseEngine | undefined;

  // Modal transitions
  openNew: () => void;
  closeNew: () => void;

  openEdit: (id: string) => void;
  closeEdit: () => void;

  setShowDatabaseForm: (v: DatabaseEngine | undefined) => void;
};

/*
 * Conservative invalidation (plan tab-database-reconnect R16): before a
 * profile whose revision changed (or that disappeared) is published, the
 * tabs of that profile lose publication authority for work started earlier.
 * Equality only: an out-of-order snapshot can only cause an extra
 * invalidation, never authorize anything (the backend decides that).
 */
const observedRevisions = new Map<string, string | undefined>();

function invalidateTabsOf(profileIds: Iterable<string>) {
  const ids = new Set(profileIds);
  if (!ids.size) return;
  const screen = useScreenStore.getState();
  screen.bumpTabEpochs(
    screen.profileTabs.filter((t) => ids.has(t.profileId)).map((t) => t.id)
  );
}

/**
 * Open tabs show their profile's current name: after a rename, wherever it
 * was saved, each tab of that profile is relabelled (keeping the database it
 * was opened on). A tab whose target is unknown keeps its label, the only
 * hint of what it was opened on.
 */
function relabelTabsOf(profiles: ConnectionProfile[], profileIds: string[]) {
  if (!profileIds.length) return;
  const ids = new Set(profileIds);
  const screen = useScreenStore.getState();
  for (const profile of profiles) {
    if (!ids.has(profile.id) || !profile.label) continue;
    for (const tab of screen.profileTabs) {
      if (tab.profileId !== profile.id || tab.target?.kind === "unknown") {
        continue;
      }
      const label = tabLabelFor(profile.label, tab.target);
      if (tab.label !== label) screen.updateTab(tab.id, { label });
    }
  }
}

/** Profiles whose revision differs from the last observed, then records them. */
function observe(profiles: ConnectionProfile[], complete: boolean): string[] {
  const changed: string[] = [];
  for (const p of profiles) {
    if (
      !observedRevisions.has(p.id) ||
      observedRevisions.get(p.id) !== p.revision
    ) {
      changed.push(p.id);
    }
    observedRevisions.set(p.id, p.revision);
  }
  if (complete) {
    const present = new Set(profiles.map((p) => p.id));
    for (const id of [...observedRevisions.keys()]) {
      if (!present.has(id)) {
        changed.push(id);
        observedRevisions.delete(id);
      }
    }
  }
  return changed;
}

function forget(profileId: string) {
  observedRevisions.delete(profileId);
  invalidateTabsOf([profileId]);
}

function toErrorMessage(e: unknown) {
  if (e && typeof e === "object" && "message" in e)
    return String((e as any).message);
  return String(e);
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  /* -------------------------------------------------------------------------- */
  /* Domain state                                                               */
  /* -------------------------------------------------------------------------- */
  profiles: [],
  busy: false,
  error: null,
  selectedProfileId: undefined,

  loadProfiles: async () => {
    set({ busy: true, error: null });
    try {
      const list = await profileList();
      const changed = observe(list, true);
      invalidateTabsOf(changed);
      relabelTabsOf(list, changed);
      usePinnedConnectionsStore.getState().pruneMissing(list.map((p) => p.id));
      set({ profiles: list, busy: false });
    } catch (e) {
      set({ busy: false, error: toErrorMessage(e) });
    }
  },

  publishProfiles: (list) => {
    const changed = observe(list, true);
    invalidateTabsOf(changed);
    relabelTabsOf(list, changed);
    usePinnedConnectionsStore.getState().pruneMissing(list.map((p) => p.id));
    set({ profiles: list });
  },

  removeProfile: async (profileId) => {
    set({ busy: true, error: null });
    try {
      await profileRemove(profileId);
      forget(profileId);
      usePinnedConnectionsStore.getState().unpin(profileId);
      set((s) => ({
        profiles: s.profiles.filter((p) => p.id !== profileId),
        busy: false,
      }));

      // If deleted profile is currently selected, clear selection
      if (get().selectedProfileId === profileId) {
        set({ selectedProfileId: undefined });
      }
    } catch (e) {
      set({ busy: false, error: toErrorMessage(e) });
    }
  },

  saveProfile: async (profile) => {
    set({ busy: true, error: null });
    try {
      const changed = observe([profile], false);
      invalidateTabsOf(changed);
      relabelTabsOf([profile], changed);
      // Local upsert: keep stable order if you want, or append to end
      set((s) => {
        const exists = s.profiles.some((p) => p.id === profile.id);
        const profiles = exists
          ? s.profiles.map((p) => (p.id === profile.id ? profile : p))
          : [...s.profiles, profile];

        return { profiles, busy: false };
      });
    } catch (e) {
      set({ busy: false, error: toErrorMessage(e) });
    }
  },

  getProfileById: (id) => {
    if (!id) return undefined;
    return get().profiles.find((p) => p.id === id);
  },

  selectProfile: (id) => set({ selectedProfileId: id }),

  /* -------------------------------------------------------------------------- */
  /* UI state                                                                   */
  /* -------------------------------------------------------------------------- */
  showNewConnection: false,
  showEditProfile: false,
  showDatabaseForm: undefined,

  openNew: () =>
    set({
      showNewConnection: true,
      showEditProfile: false,
      selectedProfileId: undefined,
      showDatabaseForm: undefined,
    }),

  closeNew: () =>
    set({
      showNewConnection: false,
      selectedProfileId: undefined,
      showDatabaseForm: undefined,
    }),

  openEdit: (id) =>
    set({
      selectedProfileId: id,
      showEditProfile: true,
      showNewConnection: false,
      // keep showDatabaseForm as-is or reset it (your choice)
    }),

  closeEdit: () =>
    set({
      showEditProfile: false,
      selectedProfileId: undefined,
    }),

  setShowDatabaseForm: (v) => set({ showDatabaseForm: v }),
}));
