import { create } from "zustand";
import type { ConnectionProfile } from "src/lib/tauri";
import { profileList, profileRemove } from "src/lib/tauri";
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
      set({ profiles: list, busy: false });
    } catch (e) {
      set({ busy: false, error: toErrorMessage(e) });
    }
  },

  removeProfile: async (profileId) => {
    set({ busy: true, error: null });
    try {
      await profileRemove(profileId);
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
