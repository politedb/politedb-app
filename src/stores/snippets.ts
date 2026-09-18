import { create } from "zustand";
import { v4 as uuid } from "uuid";
import type {
  SavedSnippet,
  SnippetFolder,
  SnippetLibrary,
  SnippetScope,
} from "src/lib/snippets/types";
import { emptySnippetLibrary } from "src/lib/snippets/types";
import {
  createFolderInput,
  createSnippetInput,
  deleteFolder,
  deleteSnippet,
  upsertFolder,
  upsertSnippet,
} from "src/lib/snippets/library";
import { loadSnippetLibrary, saveSnippetLibrary } from "src/lib/tauri/snippets";
import { normalizeShortcutBinding } from "src/stores/keyboardShortcuts";

function normalizeSnippetHotkey(binding: string | null | undefined) {
  if (!binding?.trim()) return null;
  return normalizeShortcutBinding(binding);
}

type SnippetsState = {
  library: SnippetLibrary;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  ensureLoaded: () => Promise<void>;
  reload: () => Promise<void>;
  createFolder: (args: {
    name: string;
    scope: SnippetScope;
    profileId?: string | null;
    parentId?: string | null;
  }) => Promise<SnippetFolder>;
  renameFolder: (folderId: string, name: string) => Promise<void>;
  removeFolder: (folderId: string) => Promise<void>;
  createSnippet: (args: {
    name: string;
    sql: string;
    scope: SnippetScope;
    profileId?: string | null;
    folderId?: string | null;
    hotkey?: string | null;
  }) => Promise<SavedSnippet>;
  updateSnippet: (
    snippetId: string,
    patch: Partial<
      Pick<
        SavedSnippet,
        "name" | "sql" | "folderId" | "scope" | "profileId" | "hotkey"
      >
    >
  ) => Promise<void>;
  removeSnippet: (snippetId: string) => Promise<void>;
};

let saveQueue: Promise<void> = Promise.resolve();

async function persistLibrary(library: SnippetLibrary) {
  saveQueue = saveQueue
    .catch(() => undefined)
    .then(async () => {
      await saveSnippetLibrary(library);
    });
  await saveQueue;
}

export const useSnippetsStore = create<SnippetsState>((set, get) => ({
  library: emptySnippetLibrary(),
  loaded: false,
  loading: false,
  saving: false,

  ensureLoaded: async () => {
    if (get().loaded || get().loading) return;
    set({ loading: true });
    try {
      const library = await loadSnippetLibrary();
      set({ library, loaded: true, loading: false });
    } catch {
      set({ loaded: true, loading: false });
    }
  },

  reload: async () => {
    set({ loading: true });
    try {
      const library = await loadSnippetLibrary();
      set({ library, loaded: true, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  createFolder: async (args) => {
    await get().ensureLoaded();
    const folder = createFolderInput({
      id: uuid(),
      name: args.name,
      scope: args.scope,
      profileId: args.profileId,
      parentId: args.parentId,
    });
    const library = upsertFolder(get().library, folder);
    set({ library, saving: true });
    try {
      await persistLibrary(library);
    } finally {
      set({ saving: false });
    }
    return folder;
  },

  renameFolder: async (folderId, name) => {
    await get().ensureLoaded();
    const existing = get().library.folders.find((item) => item.id === folderId);
    if (!existing) return;
    const folder = { ...existing, name: name.trim() || existing.name };
    const library = upsertFolder(get().library, folder);
    set({ library, saving: true });
    try {
      await persistLibrary(library);
    } finally {
      set({ saving: false });
    }
  },

  removeFolder: async (folderId) => {
    await get().ensureLoaded();
    const library = deleteFolder(get().library, folderId);
    set({ library, saving: true });
    try {
      await persistLibrary(library);
    } finally {
      set({ saving: false });
    }
  },

  createSnippet: async (args) => {
    await get().ensureLoaded();
    const snippet = createSnippetInput({
      id: uuid(),
      name: args.name,
      sql: args.sql,
      scope: args.scope,
      profileId: args.profileId,
      folderId: args.folderId,
      hotkey: normalizeSnippetHotkey(args.hotkey),
    });
    const library = upsertSnippet(get().library, snippet);
    set({ library, saving: true });
    try {
      await persistLibrary(library);
    } finally {
      set({ saving: false });
    }
    return snippet;
  },

  updateSnippet: async (snippetId, patch) => {
    await get().ensureLoaded();
    const existing = get().library.snippets.find(
      (item) => item.id === snippetId
    );
    if (!existing) return;

    const scope = patch.scope ?? existing.scope;
    const next: SavedSnippet = {
      ...existing,
      ...patch,
      scope,
      profileId:
        scope === "profile" ? (patch.profileId ?? existing.profileId) : null,
      hotkey:
        patch.hotkey === undefined
          ? existing.hotkey
          : normalizeSnippetHotkey(patch.hotkey),
      updatedAtMs: Date.now(),
    };
    const library = upsertSnippet(get().library, next);
    set({ library, saving: true });
    try {
      await persistLibrary(library);
    } finally {
      set({ saving: false });
    }
  },

  removeSnippet: async (snippetId) => {
    await get().ensureLoaded();
    const library = deleteSnippet(get().library, snippetId);
    set({ library, saving: true });
    try {
      await persistLibrary(library);
    } finally {
      set({ saving: false });
    }
  },
}));
