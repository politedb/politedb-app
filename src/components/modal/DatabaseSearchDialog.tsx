import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Dialog, DialogContent } from "src/components/common/Dialog";
import { Input } from "src/components/common/Input";
import {
  SearchIcon,
  TableIcon,
  EyeIcon,
  SchemaIcon,
  SquareFunctionIcon,
  BookmarkIcon,
} from "src/components/icons";
import { Button } from "src/components/common/Button";
import { cn } from "src/utils/cn";
import type { DatabaseObjectItem, TableItem } from "src/types";
import type { SavedSnippet } from "src/lib/snippets/types";
import { objectKindSingular } from "src/lib/databaseObjects";
import { OverlayScrollbars } from "src/components/common/OverlayScrollArea";

interface Props {
  open: boolean;
  onClose: () => void;
  onSelectTable: (table: TableItem) => void;
  onSelectSchema: (schema: string) => void;
  onSelectObject?: (object: DatabaseObjectItem) => void;
  onSelectSnippet?: (snippet: SavedSnippet) => void;
  tables: TableItem[];
  schemas: string[];
  objects?: DatabaseObjectItem[];
  snippets?: SavedSnippet[];
  /** e.g. "Database" for Mongo, "Schema" for SQL engines */
  schemaLabel?: string;
}

export type DatabaseSearchResult =
  | { type: "schema"; data: string }
  | { type: "table"; data: TableItem }
  | { type: "object"; data: DatabaseObjectItem }
  | { type: "snippet"; data: SavedSnippet };

export function getDatabaseSearchResults(args: {
  tables: TableItem[];
  schemas: string[];
  objects?: DatabaseObjectItem[];
  snippets?: SavedSnippet[];
  query: string;
}): DatabaseSearchResult[] {
  const q = args.query.trim().toLowerCase();
  const objects = args.objects ?? [];
  const snippets = args.snippets ?? [];

  const schemaResults: DatabaseSearchResult[] = args.schemas
    .filter((schema) => !q || schema.toLowerCase().includes(q))
    .map((schema) => ({ type: "schema", data: schema }));

  const tableResults: DatabaseSearchResult[] = args.tables
    .filter(
      (table) =>
        !q ||
        table.name.toLowerCase().includes(q) ||
        table.schema.toLowerCase().includes(q) ||
        `${table.schema}.${table.name}`.toLowerCase().includes(q)
    )
    .map((table) => ({ type: "table", data: table }));

  const objectResults: DatabaseSearchResult[] = objects
    .filter(
      (object) =>
        !q ||
        object.name.toLowerCase().includes(q) ||
        object.schema.toLowerCase().includes(q) ||
        object.kind.toLowerCase().includes(q) ||
        `${object.schema}.${object.name}`.toLowerCase().includes(q) ||
        (object.signature ?? "").toLowerCase().includes(q)
    )
    .map((object) => ({ type: "object", data: object }));

  const snippetResults: DatabaseSearchResult[] = snippets
    .filter(
      (snippet) =>
        !q ||
        snippet.name.toLowerCase().includes(q) ||
        snippet.sql.toLowerCase().includes(q)
    )
    .map((snippet) => ({ type: "snippet", data: snippet }));

  return [
    ...schemaResults,
    ...tableResults,
    ...objectResults,
    ...snippetResults,
  ];
}

function resultKey(res: DatabaseSearchResult): string {
  if (res.type === "schema") return `schema:${res.data}`;
  if (res.type === "table") return `table:${res.data.schema}.${res.data.name}`;
  if (res.type === "object") return `object:${res.data.id}`;
  return `snippet:${res.data.id}`;
}

function selectResult(
  result: DatabaseSearchResult,
  handlers: {
    onSelectSchema: (schema: string) => void;
    onSelectTable: (table: TableItem) => void;
    onSelectObject?: (object: DatabaseObjectItem) => void;
    onSelectSnippet?: (snippet: SavedSnippet) => void;
  }
) {
  if (result.type === "schema") {
    handlers.onSelectSchema(result.data);
    return;
  }
  if (result.type === "table") {
    handlers.onSelectTable(result.data);
    return;
  }
  if (result.type === "object") {
    handlers.onSelectObject?.(result.data);
    return;
  }
  handlers.onSelectSnippet?.(result.data);
}

export function DatabaseSearchDialog({
  open,
  onClose,
  onSelectTable,
  onSelectSchema,
  onSelectObject,
  onSelectSnippet,
  tables,
  schemas,
  objects = [],
  snippets = [],
  schemaLabel = "Schema",
}: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const filteredResults = useMemo(() => {
    return getDatabaseSearchResults({
      tables,
      schemas,
      objects,
      snippets,
      query,
    });
  }, [tables, schemas, objects, snippets, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handlers = {
    onSelectSchema,
    onSelectTable,
    onSelectObject,
    onSelectSnippet,
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        Math.min(prev + 1, Math.max(filteredResults.length - 1, 0))
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const result = filteredResults[selectedIndex];
      if (result) {
        selectResult(result, handlers);
        onClose();
      }
    }
  };

  useEffect(() => {
    if (listRef.current) {
      const selectedEl = listRef.current.querySelector<HTMLElement>(
        `[data-search-result-index="${selectedIndex}"]`
      );
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: "nearest" });
      }
    }
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
            placeholder={`Search ${schemaLabel.toLowerCase()}s, tables, and views...`}
            left={<SearchIcon className="size-4 text-neutral-500" />}
            className="h-8 rounded-lg border border-neutral-300 text-sm"
            autoFocus={true}
          />
        </div>
        <div class="relative min-h-0 flex-1 overflow-hidden">
          <div class="no-scrollbar h-full overflow-auto p-2" ref={listRef}>
            {filteredResults.length === 0 ? (
              <div class="p-4 text-center text-sm text-neutral-500">
                No results found.
              </div>
            ) : (
              <div class="flex flex-col gap-1">
                {filteredResults.map((res, idx) => {
                  return (
                    <Button
                      key={resultKey(res)}
                      data-search-result-index={idx}
                      variant="ghost"
                      className={cn(
                        "justify-start p-2 text-left text-sm font-normal transition-none",
                        selectedIndex === idx && "bg-neutral-100"
                      )}
                      onClick={() => {
                        selectResult(res, handlers);
                        onClose();
                      }}
                      onMouseEnter={() => setSelectedIndex(idx)}
                    >
                      <div class="flex w-full items-center justify-between gap-2">
                        {res.type === "schema" ? (
                          <>
                            <div class="flex min-w-0 items-center gap-2">
                              <SchemaIcon className="mr-2 size-4 shrink-0 text-amber-500" />
                              <span class="truncate font-medium text-neutral-700">
                                {res.data}
                              </span>
                            </div>
                            <span class="shrink-0 text-neutral-600">
                              {schemaLabel}
                            </span>
                          </>
                        ) : null}
                        {res.type === "table" ? (
                          <>
                            <div class="flex min-w-0 items-center gap-2">
                              {res.data.kind === "view" ? (
                                <EyeIcon className="mr-2 size-4 shrink-0 text-sky-500" />
                              ) : (
                                <TableIcon className="mr-2 size-4 shrink-0 text-blue-500" />
                              )}
                              <span class="truncate font-medium text-neutral-700">
                                {res.data.name}
                              </span>
                            </div>
                            <span
                              class="shrink-0 text-neutral-600"
                              title={
                                res.data.kind === "view" ? "View" : schemaLabel
                              }
                            >
                              {res.data.schema}
                            </span>
                          </>
                        ) : null}
                        {res.type === "object" ? (
                          <>
                            <div class="flex min-w-0 items-center gap-2">
                              <SquareFunctionIcon className="mr-2 size-4 shrink-0 text-violet-500" />
                              <span class="truncate font-medium text-neutral-700">
                                {res.data.name}
                              </span>
                            </div>
                            <span class="shrink-0 text-neutral-600 capitalize">
                              {objectKindSingular(res.data.kind)}
                            </span>
                          </>
                        ) : null}
                        {res.type === "snippet" ? (
                          <>
                            <div class="flex min-w-0 items-center gap-2">
                              <BookmarkIcon className="mr-2 size-4 shrink-0 text-emerald-500" />
                              <span class="truncate font-medium text-neutral-700">
                                {res.data.name}
                              </span>
                            </div>
                            <span class="shrink-0 text-neutral-600">
                              Snippet
                            </span>
                          </>
                        ) : null}
                      </div>
                    </Button>
                  );
                })}
              </div>
            )}
          </div>
          <OverlayScrollbars scrollerRef={listRef} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
