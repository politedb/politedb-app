import { describe, expect, it } from "vitest";
import {
  createFolderInput,
  createSnippetInput,
  deleteFolder,
  findSnippetByHotkey,
  listVisibleSnippets,
  upsertSnippet,
} from "./library";
import { emptySnippetLibrary } from "./types";

describe("snippet library helpers", () => {
  it("shows global + matching profile snippets", () => {
    let library = emptySnippetLibrary();
    library = upsertSnippet(
      library,
      createSnippetInput({
        id: "g1",
        name: "Global",
        sql: "SELECT 1",
        scope: "global",
      })
    );
    library = upsertSnippet(
      library,
      createSnippetInput({
        id: "p1",
        name: "Profile A",
        sql: "SELECT 2",
        scope: "profile",
        profileId: "profile-a",
      })
    );
    library = upsertSnippet(
      library,
      createSnippetInput({
        id: "p2",
        name: "Profile B",
        sql: "SELECT 3",
        scope: "profile",
        profileId: "profile-b",
      })
    );

    const visible = listVisibleSnippets(library, "profile-a");
    expect(visible.map((item) => item.id)).toEqual(["g1", "p1"]);
  });

  it("filters by folder and query", () => {
    let library = emptySnippetLibrary();
    library = upsertSnippet(
      library,
      createSnippetInput({
        id: "s1",
        name: "Users",
        sql: "SELECT * FROM users",
        scope: "global",
        folderId: "folder-1",
      })
    );
    library = upsertSnippet(
      library,
      createSnippetInput({
        id: "s2",
        name: "Orders",
        sql: "SELECT * FROM orders",
        scope: "global",
        folderId: "folder-1",
      })
    );

    expect(
      listVisibleSnippets(library, null, {
        folderId: "folder-1",
        query: "user",
      }).map((item) => item.id)
    ).toEqual(["s1"]);
  });

  it("moves snippets to root when folder deleted", () => {
    let library = emptySnippetLibrary();
    library = {
      ...library,
      folders: [
        createFolderInput({
          id: "folder-1",
          name: "Common",
          scope: "global",
        }),
      ],
    };
    library = upsertSnippet(
      library,
      createSnippetInput({
        id: "s1",
        name: "Users",
        sql: "SELECT 1",
        scope: "global",
        folderId: "folder-1",
      })
    );

    const next = deleteFolder(library, "folder-1");
    expect(next.folders).toHaveLength(0);
    expect(next.snippets[0]?.folderId).toBeNull();
  });

  it("finds snippet by hotkey for active profile", () => {
    let library = emptySnippetLibrary();
    library = upsertSnippet(
      library,
      createSnippetInput({
        id: "s1",
        name: "Hot",
        sql: "SELECT 9",
        scope: "profile",
        profileId: "profile-a",
        hotkey: "Mod+Shift+1",
      })
    );

    expect(findSnippetByHotkey(library, "profile-a", "Mod+Shift+1")?.id).toBe(
      "s1"
    );
    expect(findSnippetByHotkey(library, "profile-b", "Mod+Shift+1")).toBeNull();
  });
});
