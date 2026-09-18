import type {
  SavedSnippet,
  SnippetFolder,
  SnippetLibrary,
  SnippetScope,
} from "./types";
import { emptySnippetLibrary } from "./types";

export function normalizeSnippetName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

export function isSnippetVisibleForProfile(
  item: { scope: SnippetScope; profileId: string | null },
  profileId: string | null | undefined
) {
  if (item.scope === "global") return true;
  if (!profileId) return false;
  return item.profileId === profileId;
}

export function listVisibleFolders(
  library: SnippetLibrary,
  profileId: string | null | undefined
) {
  return library.folders
    .filter((folder) => isSnippetVisibleForProfile(folder, profileId))
    .slice()
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}

export function listVisibleSnippets(
  library: SnippetLibrary,
  profileId: string | null | undefined,
  opts?: { folderId?: string | null; query?: string }
) {
  const q = (opts?.query ?? "").trim().toLowerCase();
  return library.snippets
    .filter((snippet) => isSnippetVisibleForProfile(snippet, profileId))
    .filter((snippet) => {
      if (opts?.folderId === undefined) return true;
      return (snippet.folderId ?? null) === (opts.folderId ?? null);
    })
    .filter((snippet) => {
      if (!q) return true;
      return (
        snippet.name.toLowerCase().includes(q) ||
        snippet.sql.toLowerCase().includes(q)
      );
    })
    .slice()
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}

export function findSnippetByHotkey(
  library: SnippetLibrary,
  profileId: string | null | undefined,
  binding: string
) {
  const normalized = binding.trim();
  if (!normalized) return null;
  return (
    listVisibleSnippets(library, profileId).find(
      (snippet) => snippet.hotkey === normalized
    ) ?? null
  );
}

export function upsertFolder(
  library: SnippetLibrary,
  folder: SnippetFolder
): SnippetLibrary {
  const existingIndex = library.folders.findIndex(
    (item) => item.id === folder.id
  );
  const folders = library.folders.slice();
  if (existingIndex >= 0) {
    folders[existingIndex] = folder;
  } else {
    folders.push(folder);
  }
  return { ...library, folders };
}

export function deleteFolder(
  library: SnippetLibrary,
  folderId: string
): SnippetLibrary {
  const folders = library.folders.filter((folder) => folder.id !== folderId);
  const snippets = library.snippets.map((snippet) =>
    snippet.folderId === folderId ? { ...snippet, folderId: null } : snippet
  );
  return { ...library, folders, snippets };
}

export function upsertSnippet(
  library: SnippetLibrary,
  snippet: SavedSnippet
): SnippetLibrary {
  const existingIndex = library.snippets.findIndex(
    (item) => item.id === snippet.id
  );
  const snippets = library.snippets.slice();
  if (existingIndex >= 0) {
    snippets[existingIndex] = snippet;
  } else {
    snippets.push(snippet);
  }
  return { ...library, snippets };
}

export function deleteSnippet(
  library: SnippetLibrary,
  snippetId: string
): SnippetLibrary {
  return {
    ...library,
    snippets: library.snippets.filter((snippet) => snippet.id !== snippetId),
  };
}

export function createFolderInput(args: {
  id: string;
  name: string;
  scope: SnippetScope;
  profileId?: string | null;
  parentId?: string | null;
  sortOrder?: number;
}): SnippetFolder {
  const name = normalizeSnippetName(args.name);
  return {
    id: args.id,
    name: name || "Untitled folder",
    parentId: args.parentId ?? null,
    scope: args.scope,
    profileId: args.scope === "profile" ? (args.profileId ?? null) : null,
    sortOrder: args.sortOrder ?? Date.now(),
  };
}

export function createSnippetInput(args: {
  id: string;
  name: string;
  sql: string;
  scope: SnippetScope;
  profileId?: string | null;
  folderId?: string | null;
  hotkey?: string | null;
  sortOrder?: number;
  nowMs?: number;
}): SavedSnippet {
  const now = args.nowMs ?? Date.now();
  const name = normalizeSnippetName(args.name);
  return {
    id: args.id,
    name: name || "Untitled snippet",
    sql: args.sql,
    folderId: args.folderId ?? null,
    scope: args.scope,
    profileId: args.scope === "profile" ? (args.profileId ?? null) : null,
    hotkey: args.hotkey?.trim() ? args.hotkey.trim() : null,
    createdAtMs: now,
    updatedAtMs: now,
    sortOrder: args.sortOrder ?? now,
  };
}

function isScope(value: unknown): value is SnippetScope {
  return value === "global" || value === "profile";
}

export function parseSnippetLibrary(raw: unknown): SnippetLibrary {
  if (!raw || typeof raw !== "object") return emptySnippetLibrary();
  const value = raw as Record<string, unknown>;
  const foldersRaw = Array.isArray(value.folders) ? value.folders : [];
  const snippetsRaw = Array.isArray(value.snippets) ? value.snippets : [];

  const folders: SnippetFolder[] = foldersRaw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const folder = item as Record<string, unknown>;
    if (typeof folder.id !== "string" || typeof folder.name !== "string") {
      return [];
    }
    if (!isScope(folder.scope)) return [];
    return [
      {
        id: folder.id,
        name: folder.name,
        parentId: typeof folder.parentId === "string" ? folder.parentId : null,
        scope: folder.scope,
        profileId:
          typeof folder.profileId === "string" ? folder.profileId : null,
        sortOrder: typeof folder.sortOrder === "number" ? folder.sortOrder : 0,
      },
    ];
  });

  const snippets: SavedSnippet[] = snippetsRaw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const snippet = item as Record<string, unknown>;
    if (
      typeof snippet.id !== "string" ||
      typeof snippet.name !== "string" ||
      typeof snippet.sql !== "string"
    ) {
      return [];
    }
    if (!isScope(snippet.scope)) return [];
    return [
      {
        id: snippet.id,
        name: snippet.name,
        sql: snippet.sql,
        folderId:
          typeof snippet.folderId === "string" ? snippet.folderId : null,
        scope: snippet.scope,
        profileId:
          typeof snippet.profileId === "string" ? snippet.profileId : null,
        hotkey: typeof snippet.hotkey === "string" ? snippet.hotkey : null,
        createdAtMs:
          typeof snippet.createdAtMs === "number" ? snippet.createdAtMs : 0,
        updatedAtMs:
          typeof snippet.updatedAtMs === "number" ? snippet.updatedAtMs : 0,
        sortOrder:
          typeof snippet.sortOrder === "number" ? snippet.sortOrder : 0,
      },
    ];
  });

  return {
    version: typeof value.version === "number" ? value.version : 1,
    folders,
    snippets,
  };
}
