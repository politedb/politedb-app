export type SnippetScope = "global" | "profile";

export type SnippetFolder = {
  id: string;
  name: string;
  parentId: string | null;
  scope: SnippetScope;
  profileId: string | null;
  sortOrder: number;
};

export type SavedSnippet = {
  id: string;
  name: string;
  sql: string;
  folderId: string | null;
  scope: SnippetScope;
  profileId: string | null;
  hotkey: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  sortOrder: number;
};

export type SnippetLibrary = {
  version: number;
  folders: SnippetFolder[];
  snippets: SavedSnippet[];
};

export function emptySnippetLibrary(): SnippetLibrary {
  return { version: 1, folders: [], snippets: [] };
}
