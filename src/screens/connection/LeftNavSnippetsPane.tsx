import { useEffect, useMemo, useState } from "preact/hooks";
import { ConsoleIcon, PlusIcon, SearchIcon } from "src/components/icons";
import { Button } from "src/components/common/Button";
import { Input } from "src/components/common/Input";
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
import {
  tableSidebarButtonClass,
  tableSidebarIconClass,
  tableSidebarNameClass,
} from "./tableSidebarNameClass";
import { EmptyExpandSection } from "./EmptyExpandSection";

type ScopeFilter = "all" | SnippetScope;

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
      <div data-density-sidebar-header class="p-2">
        <div class="relative">
          <Input
            type="text"
            placeholder="Search snippets…"
            left={<SearchIcon className="size-4 text-neutral-500" />}
            value={query}
            onValueChange={setQuery}
            className={cn(
              "rounded-lg border border-neutral-200 bg-white py-1.5 text-sm"
            )}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2" data-scroll-root>
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
            {snippets.map((snippet) => (
              <Button
                key={snippet.id}
                data-density-item
                variant="ghost"
                title={snippet.name}
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
                  })
                )}
              >
                <ConsoleIcon
                  className={cn(
                    "size-4 shrink-0",
                    tableSidebarIconClass({ isActive: false, isRedis: false })
                  )}
                />
                <span
                  class={cn(
                    "min-w-0 flex-1 truncate text-left select-none",
                    tableSidebarNameClass({
                      isActive: false,
                      isNewTable: false,
                      hasChanges: false,
                    })
                  )}
                >
                  {snippet.name}
                </span>
              </Button>
            ))}
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
        <DialogHeader>
          <DialogTitle>Delete snippet</DialogTitle>
        </DialogHeader>
        <DialogContent>
          <p class="text-sm text-neutral-600">
            Delete “{deleteTarget?.name}”? This cannot be undone.
          </p>
        </DialogContent>
        <DialogFooter>
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
