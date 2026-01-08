import { create } from "zustand";
import type { ConnectionProfile } from "src/lib/tauri";
import { profileList, profileRemove } from "src/lib/tauri";
import { DatabaseEngine } from "../types";

type ProfileState = {
  profiles: ConnectionProfile[];
  busy: boolean;
  error: string | null;

  selectedProfileId: string | undefined;
  saveProfile: (profile: ConnectionProfile) => Promise<void>;
  // UI state
  showNewConnection: boolean;
  showEditProfile: boolean;
  showDatabaseForm: DatabaseEngine | undefined;

  loadProfiles: () => Promise<void>;
  removeProfile: (profileId: string) => Promise<void>;

  getProfileById: (id: string) => ConnectionProfile | undefined;

  selectProfile: (id: string | undefined) => void;

  openNew: () => void;
  closeNew: () => void;

  openEdit: (id: string) => void;
  closeEdit: () => void;

  setShowDatabaseForm: (v: DatabaseEngine | undefined) => void;
};

export const useProfileStore = create<ProfileState>((set, get) => ({
  profiles: [],
  busy: false,
  error: null,

  selectedProfileId: undefined,

  showNewConnection: false,
  showEditProfile: false,
  showDatabaseForm: undefined,

  loadProfiles: async () => {
    set({ busy: true, error: null });
    try {
      const list = await profileList();
      set({ profiles: list, busy: false });
    } catch (e: any) {
      set({
        busy: false,
        error: e?.message ? String(e.message) : String(e),
      });
    }
  },

  removeProfile: async (profileId: string) => {
    set({ busy: true, error: null });
    try {
      await profileRemove(profileId);
      set((s) => ({
        profiles: s.profiles.filter((p) => p.id !== profileId),
        busy: false,
      }));
    } catch (e: any) {
      set({
        busy: false,
        error: e?.message ? String(e.message) : String(e),
      });
    }
  },

  saveProfile: async (profile: ConnectionProfile) => {
    set({ busy: true, error: null });
    try {
      set((s) => ({
        profiles: [...s.profiles.filter((p) => p.id !== profile.id), profile],
        busy: false,
      }));
    } catch (e: any) {
      set({
        busy: false,
        error: e?.message ? String(e.message) : String(e),
      });
    }
  },

  getProfileById: (id: string) => get().profiles.find((p) => p.id === id),

  selectProfile: (id) => set({ selectedProfileId: id }),

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
    }),

  closeEdit: () =>
    set({
      showEditProfile: false,
      selectedProfileId: undefined,
    }),

  setShowDatabaseForm: (v) => set({ showDatabaseForm: v }),
}));
