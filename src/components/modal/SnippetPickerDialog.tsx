import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Dialog, DialogContent } from "src/components/common/Dialog";
import { Input } from "src/components/form/Input";
import { Button } from "src/components/common/Button";
import {
  ConsoleIcon,
  EditIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from "src/components/icons";
import { cn } from "src/utils/cn";
import { OverlayScrollbars } from "src/components/common/OverlayScrollArea";
import {
  listVisibleFolders,
  listVisibleSnippets,
} from "src/lib/snippets/library";
import { useSnippetsStore } from "src/stores/snippets";
import type { SavedSnippet } from "src/lib/snippets/types";
import {
  formatShortcutLabel,
  useKeyboardShortcutsStore,
} from "src/stores/keyboardShortcuts";
import { highlightSql } from "src/screens/connection/QueryHistory";

type Props = {
  open: boolean;
  onClose: () => void;
  profileId: string | null;
  onInsert: (sql: string) => void | Promise<void>;
  onCreate?: () => void;
  onEdit?: (snippet: SavedSnippet) => void;
};

type PickerRow =
  | { type: "folder"; id: string; name: string; scope: string }
  | { type: "snippet"; snippet: SavedSnippet; folderName: string | null };

export function SnippetPickerDialog({
  open,
  onClose,
  profileId,
  onInsert,
  onCreate,
  onEdit,
}: Props) {
  const library = useSnippetsStore((s) => s.library);
  const ensureLoaded = useSnippetsStore((s) => s.ensureLoaded);
  const removeSnippet = useSnippetsStore((s) => s.removeSnippet);
  const openSnippetsBinding = useKeyboardShortcutsStore(
    (s) => s.shortcuts.openSnippets
  );

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void ensureLoaded();
    setQuery("");
    setSelectedIndex(0);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open, ensureLoaded]);

  const rows = useMemo((): PickerRow[] => {
    const folders = listVisibleFolders(library, profileId);
    const folderNameById = new Map(folders.map((f) => [f.id, f.name]));
    const snippets = listVisibleSnippets(library, profileId, { query });

    if (query.trim()) {
      return snippets.map((snippet) => ({
        type: "snippet" as const,
        snippet,
        folderName: snippet.folderId
          ? (folderNameById.get(snippet.folderId) ?? null)
          : null,
      }));
    }

    const unfiled = snippets.filter((snippet) => !snippet.folderId);
    const result: PickerRow[] = [];
    for (const folder of folders) {
      const inFolder = snippets.filter(
        (snippet) => snippet.folderId === folder.id
      );
      if (inFolder.length === 0) continue;
      result.push({
        type: "folder",
        id: folder.id,
        name: folder.name,
        scope: folder.scope,
      });
      for (const snippet of inFolder) {
        result.push({
          type: "snippet",
          snippet,
          folderName: folder.name,
        });
      }
    }
    for (const snippet of unfiled) {
      result.push({ type: "snippet", snippet, folderName: null });
    }
    return result;
  }, [library, profileId, query]);

  const selectable = useMemo(
    () =>
      rows
        .map((row, index) => ({ row, index }))
        .filter((item) => item.row.type === "snippet"),
    [rows]
  );

  useEffect(() => {
    setSelectedIndex(selectable[0]?.index ?? 0);
  }, [query, selectable]);

  const insertAt = async (index: number) => {
    const row = rows[index];
    if (!row || row.type !== "snippet") return;
    await onInsert(row.snippet.sql);
    onClose();
  };

  const deleteAt = async (index: number) => {
    const row = rows[index];
    if (!row || row.type !== "snippet") return;
    await removeSnippet(row.snippet.id);
    inputRef.current?.focus();
  };

  const editAt = (index: number) => {
    const row = rows[index];
    if (!row || row.type !== "snippet" || !onEdit) return;
    onClose();
    onEdit(row.snippet);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const current = selectable.findIndex(
        (item) => item.index === selectedIndex
      );
      const next = selectable[Math.min(current + 1, selectable.length - 1)];
      if (next) setSelectedIndex(next.index);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const current = selectable.findIndex(
        (item) => item.index === selectedIndex
      );
      const next = selectable[Math.max(current - 1, 0)];
      if (next) setSelectedIndex(next.index);
    } else if (e.key === "Enter") {
      e.preventDefault();
      void insertAt(selectedIndex);
    } else if (
      (e.key === "Backspace" || e.key === "Delete") &&
      !query &&
      selectable.length > 0
    ) {
      e.preventDefault();
      void deleteAt(selectedIndex);
    }
  };

  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.querySelector<HTMLElement>(
      `[data-snippet-index="${selectedIndex}"]`
    );
    selectedEl?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <Dialog open={open} size="md" showCloseButton={false} onClose={onClose}>
      <DialogContent className="relative flex h-[60vh] max-h-125 flex-col gap-1 overflow-hidden p-0">
        <div class="shrink-0 border-b border-neutral-200 p-3">
          <Input
            ref={inputRef}
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={handleKeyDown}
            placeholder="Search snippets…"
            left={<SearchIcon className="size-4 text-neutral-400" />}
          />
          <p class="mt-2 text-[11px] text-neutral-500">
            Enter to insert · Delete to remove ·{" "}
            {formatShortcutLabel(openSnippetsBinding)} to open
          </p>
        </div>

        <div class="relative min-h-0 flex-1 overflow-hidden">
          <div class="no-scrollbar h-full overflow-auto p-2" ref={listRef}>
            {rows.length === 0 ? (
              <div class="flex flex-col items-center justify-center px-3 py-8">
                <div class="flex flex-col items-center justify-center gap-2">
                  <ConsoleIcon className="size-8 text-neutral-400" />
                  <span class="text-sm text-neutral-500">No snippets yet.</span>
                </div>
              </div>
            ) : (
              rows.map((row, index) => {
                if (row.type === "folder") {
                  return (
                    <div
                      key={`folder-${row.id}`}
                      class="flex items-center gap-2 px-2 py-1.5 text-[11px] font-semibold tracking-wide text-neutral-500 uppercase"
                    >
                      <FolderIcon className="size-3.5" />
                      {row.name}
                      <span class="font-normal text-neutral-400 normal-case">
                        · {row.scope === "global" ? "Global" : "Connection"}
                      </span>
                    </div>
                  );
                }

                const active = index === selectedIndex;
                return (
                  <div
                    key={row.snippet.id}
                    data-snippet-index={index}
                    class={cn(
                      "group flex w-full items-center gap-1 rounded-lg px-2 py-2",
                      active ? "bg-slate-100" : "hover:bg-neutral-100"
                    )}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-start gap-2 overflow-hidden px-1 text-left"
                      onClick={() => void insertAt(index)}
                    >
                      <ConsoleIcon className="mt-0.5 size-5 shrink-0 text-neutral-500" />
                      <div class="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden">
                        <div class="flex min-w-0 items-center gap-2">
                          <span class="min-w-0 flex-1 truncate text-sm font-medium text-neutral-800">
                            {row.snippet.name}
                          </span>
                          {row.snippet.hotkey ? (
                            <span
                              class={cn(
                                "shrink-0 rounded border border-neutral-200 bg-white",
                                "px-1.5 py-0.5 text-xs text-neutral-500"
                              )}
                            >
                              {formatShortcutLabel(row.snippet.hotkey)}
                            </span>
                          ) : null}
                          <span class="shrink-0 text-xs text-neutral-400">
                            {row.snippet.scope === "global"
                              ? "Global"
                              : "Connection"}
                          </span>
                        </div>
                        <div class="line-clamp-2 min-w-0 overflow-hidden font-mono text-[11px] leading-4 break-all text-neutral-600">
                          {highlightSql(row.snippet.sql.trim())}
                        </div>
                      </div>
                    </button>
                    <div class="flex shrink-0 items-center gap-0.5">
                      {onEdit ? (
                        <Button
                          variant="outline"
                          class={cn(
                            "size-7 shrink-0 p-0 text-neutral-400",
                            "opacity-0 group-hover:opacity-100 hover:bg-neutral-200 hover:text-neutral-700",
                            active && "opacity-100"
                          )}
                          title="Edit snippet"
                          onClick={(e) => {
                            e.stopPropagation();
                            editAt(index);
                          }}
                        >
                          <EditIcon className="size-4" />
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        class={cn(
                          "size-7 shrink-0 p-0 text-neutral-400",
                          "opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-600",
                          active && "opacity-100"
                        )}
                        title="Delete snippet"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteAt(index);
                        }}
                      >
                        <TrashIcon className="size-4" />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <OverlayScrollbars scrollerRef={listRef} />
        </div>

        {onCreate ? (
          <div class="flex shrink-0 items-center justify-end border-t border-neutral-200 px-3 py-2">
            <Button
              variant="primary"
              class="h-8 gap-1.5 px-3"
              onClick={() => {
                onClose();
                onCreate();
              }}
            >
              <PlusIcon className="size-3.5" />
              New snippet
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
