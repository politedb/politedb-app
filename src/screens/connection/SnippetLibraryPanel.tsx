import { useEffect, useMemo, useState } from "preact/hooks";
import {
  ConsoleIcon,
  FolderIcon,
  PlusIcon,
  TrashIcon,
  EditIcon,
  SearchIcon,
} from "src/components/icons";
import { Button } from "src/components/common/Button";
import { Box } from "src/components/common/Box";
import { Input } from "src/components/common/Input";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import { cn } from "src/utils/cn";
import { useSnippetsStore } from "src/stores/snippets";
import {
  listVisibleFolders,
  listVisibleSnippets,
} from "src/lib/snippets/library";
import type { SavedSnippet, SnippetScope } from "src/lib/snippets/types";
import { highlightSql } from "src/screens/connection/QueryHistory";
import { formatShortcutLabel } from "src/stores/keyboardShortcuts";
import { SnippetEditorDialog } from "src/components/modal/SnippetEditorDialog";

type Props = {
  profileId: string | null;
  onInsert: (sql: string) => void | Promise<void>;
};

export function SnippetLibraryPanel({ profileId, onInsert }: Props) {
  const library = useSnippetsStore((s) => s.library);
  const ensureLoaded = useSnippetsStore((s) => s.ensureLoaded);
  const createFolder = useSnippetsStore((s) => s.createFolder);
  const removeFolder = useSnippetsStore((s) => s.removeFolder);
  const removeSnippet = useSnippetsStore((s) => s.removeSnippet);

  const [query, setQuery] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SavedSnippet | null>(null);
  const [defaultSql, setDefaultSql] = useState("");
  const [defaultScope, setDefaultScope] = useState<SnippetScope>("global");

  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  const folders = useMemo(
    () => listVisibleFolders(library, profileId),
    [library, profileId]
  );

  const snippets = useMemo(
    () =>
      listVisibleSnippets(library, profileId, {
        folderId: selectedFolderId === null ? undefined : selectedFolderId,
        query,
      }),
    [library, profileId, selectedFolderId, query]
  );

  const openCreate = (
    scope: SnippetScope = profileId ? "profile" : "global"
  ) => {
    setEditing(null);
    setDefaultSql("");
    setDefaultScope(scope);
    setEditorOpen(true);
  };

  const openEdit = (snippet: SavedSnippet) => {
    setEditing(snippet);
    setDefaultSql(snippet.sql);
    setDefaultScope(snippet.scope);
    setEditorOpen(true);
  };

  const onNewFolder = async () => {
    const name = window.prompt("Folder name");
    if (!name?.trim()) return;
    const scope: SnippetScope = profileId ? "profile" : "global";
    await createFolder({
      name,
      scope,
      profileId: scope === "profile" ? profileId : null,
    });
  };

  return (
    <div class="flex h-full flex-col bg-white">
      <div class="flex items-center justify-between gap-2 border-b border-neutral-200 bg-white px-3 py-2">
        <div class="flex min-w-0 items-center gap-2">
          <ConsoleIcon className="size-4 shrink-0 text-neutral-500" />
          <h3 class="text-sm font-semibold text-neutral-800">Snippets</h3>
          {snippets.length > 0 ? (
            <span class="text-[11px] text-neutral-500">
              ({snippets.length})
            </span>
          ) : null}
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            class="h-7 px-2 text-xs text-neutral-600 hover:bg-neutral-100"
            onClick={() => void onNewFolder()}
            title="New folder"
          >
            <FolderIcon className="size-3.5" />
            Folder
          </Button>
          <Button
            variant="ghost"
            class="h-7 px-2 text-xs text-neutral-600 hover:bg-neutral-100"
            onClick={() => openCreate()}
            title="New snippet"
          >
            <PlusIcon className="size-3.5" />
            New
          </Button>
        </div>
      </div>

      <div class="flex min-h-0 flex-1">
        <div class="flex w-44 shrink-0 flex-col border-r border-neutral-200">
          <OverlayScrollArea className="min-h-0 flex-1" contentClassName="p-1">
            <button
              type="button"
              class={cn(
                "flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs",
                selectedFolderId === null
                  ? "bg-neutral-100 font-semibold text-neutral-800"
                  : "text-neutral-600 hover:bg-neutral-50"
              )}
              onClick={() => setSelectedFolderId(null)}
            >
              All snippets
            </button>
            {folders.map((folder) => (
              <div key={folder.id} class="group flex items-center gap-1">
                <button
                  type="button"
                  class={cn(
                    "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs",
                    selectedFolderId === folder.id
                      ? "bg-neutral-100 font-semibold text-neutral-800"
                      : "text-neutral-600 hover:bg-neutral-50"
                  )}
                  onClick={() => setSelectedFolderId(folder.id)}
                >
                  <FolderIcon className="size-3.5 shrink-0" />
                  <span class="truncate">{folder.name}</span>
                </button>
                <button
                  type="button"
                  class="mr-1 rounded p-1 opacity-0 group-hover:opacity-100 hover:bg-red-50"
                  title="Delete folder"
                  onClick={() => void removeFolder(folder.id)}
                >
                  <TrashIcon className="size-3 text-neutral-400" />
                </button>
              </div>
            ))}
          </OverlayScrollArea>
        </div>

        <div class="flex min-w-0 flex-1 flex-col">
          <div class="border-b border-neutral-100 px-2 py-1.5">
            <Input
              value={query}
              onValueChange={setQuery}
              placeholder="Filter snippets…"
              left={<SearchIcon className="size-3.5 text-neutral-400" />}
              className="h-8 text-xs"
            />
          </div>

          <OverlayScrollArea
            className="min-h-0 flex-1"
            contentClassName="h-full"
          >
            {snippets.length === 0 ? (
              <Box className="text-center">
                <ConsoleIcon className="mx-auto mb-2 size-8 text-blue-600" />
                <p class="text-sm text-neutral-500">No snippets yet</p>
                <Button
                  variant="ghost"
                  class="mt-2 h-8 px-3 text-xs"
                  onClick={() => openCreate()}
                >
                  Create your first snippet
                </Button>
              </Box>
            ) : (
              <div class="font-mono text-sm leading-5">
                {snippets.map((snippet) => (
                  <div
                    key={snippet.id}
                    class={cn(
                      "group flex items-start gap-3 px-3 py-2",
                      "border-b border-neutral-100",
                      "hover:bg-slate-50"
                    )}
                  >
                    <div class="min-w-0 flex-1">
                      <div class="mb-1 flex items-center gap-2 font-sans">
                        <span class="truncate text-xs font-semibold text-neutral-800">
                          {snippet.name}
                        </span>
                        <span class="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
                          {snippet.scope === "global" ? "Global" : "Connection"}
                        </span>
                        {snippet.hotkey ? (
                          <span class="text-[10px] text-neutral-400">
                            {formatShortcutLabel(snippet.hotkey)}
                          </span>
                        ) : null}
                      </div>
                      <div class="line-clamp-3 wrap-break-word">
                        {highlightSql(snippet.sql.trim())}
                      </div>
                    </div>

                    <div class="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        class="h-7 px-2 text-xs text-neutral-600 hover:bg-neutral-100"
                        onClick={() => void onInsert(snippet.sql)}
                        title="Insert at cursor"
                      >
                        Insert
                      </Button>
                      <Button
                        variant="ghost"
                        class="h-7 px-2 text-neutral-600 hover:bg-neutral-100"
                        onClick={() => openEdit(snippet)}
                        title="Edit"
                      >
                        <EditIcon className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        class="h-7 px-2 text-neutral-600 hover:bg-red-50"
                        onClick={() => void removeSnippet(snippet.id)}
                        title="Delete"
                      >
                        <TrashIcon className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </OverlayScrollArea>
        </div>
      </div>

      <div class="border-t border-neutral-200 bg-white px-3 py-2">
        <p class="text-[11px] text-neutral-500">
          Global snippets work everywhere. Connection snippets stay with this
          profile. Bind a hotkey to insert without opening the picker.
        </p>
      </div>

      <SnippetEditorDialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        profileId={profileId}
        initial={
          editing ?? {
            sql: defaultSql,
            scope: defaultScope,
            folderId: selectedFolderId,
          }
        }
      />
    </div>
  );
}
