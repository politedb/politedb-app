import { useEffect, useMemo, useState } from "preact/hooks";
import { ConsoleIcon, PlusIcon, SearchIcon } from "src/components/icons";
import { Button } from "src/components/common/Button";
import { Input } from "src/components/common/Input";
import { Select } from "src/components/common/Select";
import { cn } from "src/utils/cn";
import { useSnippetsStore } from "src/stores/snippets";
import { listVisibleSnippets } from "src/lib/snippets/library";
import type { SnippetScope } from "src/lib/snippets/types";
import { SnippetEditorDialog } from "src/components/modal/SnippetEditorDialog";
import {
  tableSidebarButtonClass,
  tableSidebarIconClass,
  tableSidebarNameClass,
} from "./tableSidebarNameClass";

type ScopeFilter = "all" | SnippetScope;

type Props = {
  profileId: string | null;
  onInsert: (sql: string) => void | Promise<void>;
};

export function LeftNavSnippetsPane({ profileId, onInsert }: Props) {
  const library = useSnippetsStore((s) => s.library);
  const ensureLoaded = useSnippetsStore((s) => s.ensureLoaded);

  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [editorOpen, setEditorOpen] = useState(false);

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
          <div class="rounded-xl border border-dashed border-neutral-200 bg-white/80 px-3 py-4 text-center shadow-sm">
            <div class="mx-auto mb-2 flex size-8 items-center justify-center rounded-full bg-neutral-100">
              <ConsoleIcon className="size-4 text-neutral-500" />
            </div>
            <div class="text-sm font-medium text-neutral-700">
              {query.trim() || scopeFilter !== "all"
                ? "No matching snippets"
                : "No snippets yet"}
            </div>
          </div>
        ) : (
          <div class="space-y-1">
            {snippets.map((snippet) => (
              <Button
                key={snippet.id}
                data-density-item
                variant="ghost"
                title={snippet.name}
                onClick={() => void onInsert(snippet.sql)}
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
            onClick={() => setEditorOpen(true)}
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

      <SnippetEditorDialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        profileId={profileId}
        initial={{
          scope: createScope,
        }}
        title="Save snippet"
      />
    </div>
  );
}
