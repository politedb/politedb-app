import { useEffect, useMemo, useState } from "preact/hooks";
import { ConsoleIcon, PlusIcon } from "src/components/icons";
import { Button } from "src/components/common/Button";
import { Select } from "src/components/common/Select";
import { ContextMenu, type MenuItem } from "src/components/common/ContextMenu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { cn } from "src/utils/cn";
import { useSnippetsStore } from "src/stores/snippets";
import { listVisibleSnippets } from "src/lib/snippets/library";
import type { SavedSnippet, SnippetScope } from "src/lib/snippets/types";
import { SnippetEditorDialog } from "src/components/modal/SnippetEditorDialog";
import { showToast } from "src/stores/toast";
import { formatShortcutLabel } from "src/stores/keyboardShortcuts";
import {
  tableSidebarButtonClass,
  tableSidebarIconClass,
} from "../lib/tableSidebarNameClass";
import { EmptyExpandSection } from "./EmptyExpandSection";
import { SidebarSearch } from "./SidebarSearch";
import { handleSidebarListKeyDown } from "./sidebarListKeys";

type ScopeFilter = "all" | SnippetScope;

/** The first non-empty line of a snippet's SQL, for its sidebar row. */
export function snippetPreview(sql: string): string {
  const line = sql
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return line ?? "";
}

/** Hover text: the name, where it applies, and the start of the SQL. */
function snippetTooltip(snippet: SavedSnippet): string {
  const scope =
    snippet.scope === "profile" ? "This connection only" : "All connections";
  const sql = snippet.sql.trim();
  const shown = sql.length > 500 ? `${sql.slice(0, 500)}…` : sql;
  return `${snippet.name} · ${scope}\n\n${shown}`;
}

type Props = {
  profileId: string | null;
  onInsert: (sql: string) => void | Promise<void>;
};

export function LeftNavSnippetsPane({ profileId, onInsert }: Props) {
  const library = useSnippetsStore((s) => s.library);
  const ensureLoaded = useSnippetsStore((s) => s.ensureLoaded);
  const removeSnippet = useSnippetsStore((s) => s.removeSnippet);

  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorInitial, setEditorInitial] = useState<
    Partial<SavedSnippet> & { sql?: string }
  >({ scope: "global" });
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    snippet: SavedSnippet;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedSnippet | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  const snippets = useMemo(() => {
    const visible = listVisibleSnippets(library, profileId, { query });
    if (scopeFilter === "all") return visible;
    return visible.filter((snippet) => snippet.scope === scopeFilter);
  }, [library, profileId, query, scopeFilter]);

  const createScope: SnippetScope =
    scopeFilter === "profile" && profileId
      ? "profile"
      : scopeFilter === "global"
        ? "global"
        : profileId
          ? "profile"
          : "global";

  const openCreate = () => {
    setEditorInitial({ scope: createScope });
    setEditorOpen(true);
  };

  const openEdit = (snippet: SavedSnippet) => {
    setEditorInitial(snippet);
    setEditorOpen(true);
  };

  const menuItems: MenuItem[] = menu
    ? [
        {
          type: "item",
          label: "Edit snippet",
          onClick: () => openEdit(menu.snippet),
        },
        {
          type: "item",
          label: "Insert to editor",
          onClick: () => void onInsert(menu.snippet.sql),
        },
        { type: "sep" },
        {
          type: "item",
          label: "Copy name",
          onClick: () => void navigator.clipboard.writeText(menu.snippet.name),
        },
        {
          type: "item",
          label: "Copy SQL",
          onClick: () => void navigator.clipboard.writeText(menu.snippet.sql),
        },
        { type: "sep" },
        {
          type: "item",
          label: "Delete",
          color: "red",
          onClick: () => setDeleteTarget(menu.snippet),
        },
      ]
    : [];

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await removeSnippet(deleteTarget.id);
      showToast(`Deleted “${deleteTarget.name}”.`, { tone: "success" });
      setDeleteTarget(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err ?? ""), {
        tone: "error",
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SidebarSearch
        value={query}
        onChange={setQuery}
        placeholder="Search snippets…"
        label="Search snippets"
      />

      <div
        className="min-h-0 flex-1 overflow-y-auto p-2"
        data-scroll-root
        onKeyDown={handleSidebarListKeyDown}
      >
        {snippets.length === 0 ? (
          <EmptyExpandSection
            Icon={ConsoleIcon}
            description={
              query.trim() || scopeFilter !== "all"
                ? "No matching snippets"
                : "No snippets yet"
            }
          />
        ) : (
          <div class="space-y-1">
            {snippets.map((snippet) => {
              const preview = snippetPreview(snippet.sql);
              return (
                <Button
                  key={snippet.id}
                  data-density-item
                  data-sidebar-item
                  variant="ghost"
                  title={snippetTooltip(snippet)}
                  aria-label={`Insert snippet ${snippet.name}`}
                  onClick={() => void onInsert(snippet.sql)}
                  onContextMenu={(e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({ x: e.clientX, y: e.clientY, snippet });
                  }}
                  className={cn(
                    tableSidebarButtonClass({
                      isActive: false,
                      isNewTable: false,
                      hasChanges: false,
                    }),
                    "h-auto items-start"
                  )}
                >
                  <ConsoleIcon
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      tableSidebarIconClass({ isActive: false, isRedis: false })
                    )}
                  />
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5 text-left select-none">
                    <span class="flex min-w-0 items-center gap-1.5">
                      <span class="min-w-0 flex-1 truncate">
                        {snippet.name}
                      </span>
                      {snippet.hotkey ? (
                        <kbd class="shrink-0 font-sans text-[11px] font-normal text-neutral-500">
                          {formatShortcutLabel(snippet.hotkey)}
                        </kbd>
                      ) : null}
                    </span>
                    <span class="flex min-w-0 items-center gap-1.5 text-[11px] font-normal text-neutral-500">
                      <span class="shrink-0 rounded bg-neutral-200/60 px-1 leading-4">
                        {snippet.scope === "profile" ? "Connection" : "Global"}
                      </span>
                      {preview ? (
                        <span class="min-w-0 truncate font-mono">
                          {preview}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
        )}
      </div>

      <div class="border-t border-neutral-200 bg-neutral-100 p-2">
        <div class="flex items-center gap-1">
          <Button
            variant="outline"
            className={cn(
              "size-7 shrink-0 p-1 text-sm",
              "border-neutral-300 bg-white"
            )}
            title="New snippet"
            onClick={openCreate}
          >
            <PlusIcon class="size-2.5 text-neutral-800" />
          </Button>

          <Select
            aria-label="Snippet scope"
            title="Snippet scope"
            className={cn(
              "h-7 w-full border-neutral-300 text-neutral-800",
              "focus:border-neutral-300 focus:ring-2 focus:ring-black/5"
            )}
            value={scopeFilter}
            onChange={(e) =>
              setScopeFilter(
                (e.currentTarget as HTMLSelectElement).value as ScopeFilter
              )
            }
          >
            <option value="all">All snippets</option>
            <option value="global">Global</option>
            <option value="profile" disabled={!profileId}>
              This connection
            </option>
          </Select>
        </div>
      </div>

      <ContextMenu
        autoFocus
        open={!!menu}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
      />

      <SnippetEditorDialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        profileId={profileId}
        initial={editorInitial}
        title={editorInitial.id ? "Edit snippet" : "Save snippet"}
      />

      <Dialog
        open={!!deleteTarget}
        onClose={() => (deleting ? null : setDeleteTarget(null))}
        size="sm"
      >
        <DialogHeader className="border-b border-neutral-200">
          <DialogTitle>Delete snippet</DialogTitle>
        </DialogHeader>
        <DialogContent>
          <p class="text-sm text-neutral-600">
            Delete “{deleteTarget?.name}”? This cannot be undone.
          </p>
        </DialogContent>
        <DialogFooter className="justify-end pt-1">
          <Button
            variant="ghost"
            disabled={deleting}
            onClick={() => setDeleteTarget(null)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={deleting}
            onClick={() => void confirmDelete()}
          >
            Delete
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
