import { create } from "zustand";
import type { ConnectionProfile } from "src/lib/tauri";
import { profileList, profileRemove } from "src/lib/tauri";

type ProfileState = {
  profiles: ConnectionProfile[];
  busy: boolean;
  error: string | null;

  selectedProfileId: string | null;

  // UI state
  showNewConnection: boolean;
  showEditProfile: boolean;
  showDatabaseForm: boolean;

  loadProfiles: () => Promise<void>;
  removeProfile: (profileId: string) => Promise<void>;

  getProfileById: (id: string) => ConnectionProfile | undefined;

  selectProfile: (id: string | null) => void;

  openNew: () => void;
  closeNew: () => void;

  openEdit: (id: string) => void;
  closeEdit: () => void;

  setShowDatabaseForm: (v: boolean) => void;
};

export const useProfileStore = create<ProfileState>((set, get) => ({
  profiles: [],
  busy: false,
  error: null,

  selectedProfileId: null,

  showNewConnection: false,
  showEditProfile: false,
  showDatabaseForm: false,

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
      console.log(e);
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
      selectedProfileId: null,
      showDatabaseForm: false,
    }),

  closeNew: () =>
    set({
      showNewConnection: false,
      selectedProfileId: null,
      showDatabaseForm: false,
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
      selectedProfileId: null,
    }),

  setShowDatabaseForm: (v) => set({ showDatabaseForm: v }),
}));
