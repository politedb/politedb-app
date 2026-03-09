import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Dialog, DialogContent } from "src/components/common/Dialog";
import { Input } from "src/components/common/Input";
import { Search, Table, Schema } from "src/components/icons";
import { Button } from "src/components/common/Button";
import { cn } from "src/utils/cn";
import type { TableItem } from "src/types";

interface Props {
  open: boolean;
  onClose: () => void;
  onSelectTable: (table: TableItem) => void;
  onSelectSchema: (schema: string) => void;
  tables: TableItem[];
  schemas: string[];
}

type SearchResult =
  | { type: "schema"; data: string }
  | { type: "table"; data: TableItem };

export function DatabaseSearchDialog({
  open,
  onClose,
  onSelectTable,
  onSelectSchema,
  tables,
  schemas,
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
    const q = query.trim().toLowerCase();

    let schemaResults: SearchResult[] = [];
    let tableResults: SearchResult[] = [];

    if (!q) {
      schemaResults = schemas
        .slice(0, 10)
        .map((s) => ({ type: "schema", data: s }));
      tableResults = tables
        .slice(0, 40)
        .map((t) => ({ type: "table", data: t }));
      return [...schemaResults, ...tableResults];
    }

    // Filter schemas
    schemaResults = schemas
      .filter((s) => s.toLowerCase().includes(q))
      .slice(0, 10)
      .map((s) => ({ type: "schema", data: s }));

    // Filter tables
    tableResults = tables
      .filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.schema.toLowerCase().includes(q) ||
          `${t.schema}.${t.name}`.toLowerCase().includes(q)
      )
      .slice(0, 100 - schemaResults.length)
      .map((t) => ({ type: "table", data: t }));

    return [...schemaResults, ...tableResults];
  }, [tables, schemas, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        Math.min(prev + 1, filteredResults.length - 1)
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const result = filteredResults[selectedIndex];
      if (result) {
        if (result.type === "schema") {
          onSelectSchema(result.data);
        } else {
          onSelectTable(result.data);
        }
        onClose();
      }
    }
  };

  useEffect(() => {
    if (listRef.current) {
      const selectedEl = listRef.current.children[selectedIndex] as HTMLElement;
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex]);

  return (
    <Dialog open={open} size="md" showCloseButton={false} onClose={onClose}>
      <DialogContent className="flex h-[60vh] max-h-[500px] flex-col overflow-hidden p-0">
        <div class="shrink-0 border-b border-neutral-200 p-2">
          <Input
            ref={inputRef}
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={handleKeyDown}
            placeholder="Search schemas, tables, and views..."
            left={<Search className="size-4 text-neutral-500" />}
            className="rounded-lg border border-neutral-300 text-sm"
            autoFocus={true}
          />
        </div>
        <div class="flex-1 overflow-auto p-2" ref={listRef}>
          {filteredResults.length === 0 ? (
            <div class="p-4 text-center text-sm text-neutral-500">
              No results found.
            </div>
          ) : (
            <div class="flex flex-col gap-1">
              {filteredResults.map((res, idx) => {
                const key =
                  res.type === "schema"
                    ? `schema:${res.data}`
                    : `table:${res.data.schema}.${res.data.name}`;

                return (
                  <Button
                    key={key}
                    variant="ghost"
                    className={cn(
                      "justify-start px-2 py-2 text-left text-sm font-normal transition-none",
                      selectedIndex === idx && "bg-neutral-100"
                    )}
                    onClick={() => {
                      if (res.type === "schema") {
                        onSelectSchema(res.data);
                      } else {
                        onSelectTable(res.data);
                      }
                      onClose();
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <div class="flex w-full items-center justify-between gap-2">
                      {res.type === "schema" ? (
                        <>
                          <div class="flex items-center gap-2">
                            <Schema className="mr-2 size-4 shrink-0 text-amber-500" />
                            <span class="font-medium text-neutral-700">
                              {res.data}
                            </span>
                          </div>
                          <span class="text-neutral-600">Schema</span>
                        </>
                      ) : (
                        <>
                          <div class="flex items-center gap-2">
                            <Table className="mr-2 size-4 shrink-0 text-blue-500" />
                            <span class="font-medium text-neutral-700">
                              {res.data.name}
                            </span>
                          </div>
                          <span class="text-neutral-600">
                            {res.data.schema}
                          </span>
                        </>
                      )}
                    </div>
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
