import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Box } from "src/components/common/Box";
import { Input } from "src/components/common/Input";
import { TableSizeInfo } from "src/types";
import type { SelectedRowDetail } from "src/stores/connection";
import { useConnectionStore } from "src/stores/connection";
import { cn } from "src/utils/cn";
import { ChevronDownIcon, SearchIcon } from "src/components/icons";
import { defaultCellEditValue } from "src/lib/table-data/cellEditValue";
import { Button } from "src/components/common/Button";

interface Props {
  sizeInfo: TableSizeInfo | null;
  selectedRowDetail: SelectedRowDetail | null;
  tableLoadKey: string | null;
  dataReadOnly?: boolean;
}

function isJsonDataType(dataType?: string | null) {
  return /\bjsonb?\b/i.test(dataType ?? "");
}

function hasColumnDefault(field: SelectedRowDetail["fields"][number]) {
  return !!field.columnDefault?.trim();
}

function SpecialValueDropdown(props: {
  field: SelectedRowDetail["fields"][number];
  open: boolean;
  onToggle: () => void;
  onSelect: (action: "null" | "default") => void;
}) {
  const { field, open, onToggle, onSelect } = props;

  return (
    <div class="absolute top-1 right-1 shrink-0">
      <Button
        variant="ghost"
        class="p-0.5 hover:bg-neutral-100"
        title="Set special value"
        aria-label={`Set special value for ${field.name}`}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          onToggle();
        }}
      >
        <ChevronDownIcon className="size-3" />
      </Button>

      {open ? (
        <div class="absolute top-5 right-0 z-50 min-w-24 overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-xl">
          <button
            type="button"
            class="block w-full px-3 py-0.5 text-left text-sm font-medium text-neutral-800 hover:bg-neutral-100"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect("null")}
          >
            NULL
          </button>
          <button
            type="button"
            class={cn(
              "block w-full px-3 py-0.5 text-left text-sm font-medium text-neutral-800 hover:bg-neutral-100",
              "hover:bg-transparent disabled:opacity-50"
            )}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect("default")}
            disabled={!hasColumnDefault(field)}
          >
            DEFAULT
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EditableRowFieldList({
  rowIndex,
  fields,
  readOnly,
  tableLoadKey,
}: {
  rowIndex: number;
  fields: SelectedRowDetail["fields"];
  readOnly?: boolean;
  tableLoadKey: string | null;
}) {
  const commitField = useConnectionStore((s) =>
    tableLoadKey ? s.rowFieldEditHandlerByKey[tableLoadKey] : undefined
  );

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [openSpecialField, setOpenSpecialField] = useState<string | null>(null);
  const draftsRef = useRef<Record<string, string>>({});
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const field of fields) {
      next[field.name] = field.isNull ? "" : field.value;
    }
    draftsRef.current = next;
    setDrafts(next);
    setOpenSpecialField(null);
  }, [fields, rowIndex]);

  const commit = useCallback(
    (name: string, value?: unknown) => {
      if (readOnly || !commitField) return;

      const field = fields.find((f) => f.name === name);
      if (field?.readonly) return;

      const draft =
        value === undefined ? (draftsRef.current[name] ?? "") : value;
      const prevDisplay = field?.isNull ? "" : (field?.value ?? "");
      if (typeof draft === "string" && draft.trim() === prevDisplay.trim()) {
        return;
      }

      commitField(rowIndex, name, draft);
    },
    [readOnly, commitField, fields, rowIndex]
  );

  const setDraftValue = useCallback((name: string, value: string) => {
    setDrafts((prev) => {
      const next = { ...prev, [name]: value };
      draftsRef.current = next;
      return next;
    });
  }, []);

  const applySpecialValue = useCallback(
    (
      field: SelectedRowDetail["fields"][number],
      action: "null" | "default"
    ) => {
      if (field.readonly || readOnly) return;

      if (action === "null") {
        setDraftValue(field.name, "");
        commit(field.name, null);
        return;
      }

      if (!hasColumnDefault(field)) return;
      setDraftValue(field.name, "DEFAULT");
      commit(field.name, defaultCellEditValue());
    },
    [commit, readOnly, setDraftValue]
  );

  const commitAllDirty = useCallback(() => {
    for (const field of fields) {
      if (field.readonly) continue;
      commit(field.name);
    }
  }, [fields, commit]);

  // Canvas/table clicks may not blur sidebar inputs — flush on outside pointerdown.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const root = panelRef.current;
      if (!root || root.contains(e.target as Node)) return;
      commitAllDirty();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [commitAllDirty]);

  return (
    <div ref={panelRef} class="space-y-2 border-t border-neutral-200 pt-3">
      {fields.map((field) => {
        const fieldReadOnly = readOnly || field.readonly;
        const draft = drafts[field.name] ?? "";
        const isJsonField = isJsonDataType(field.dataType);
        const specialOpen = openSpecialField === field.name;

        return (
          <div key={field.name} class="space-y-1 rounded-md">
            <div class="flex items-baseline justify-between gap-2">
              <div class="text-xs font-medium text-neutral-500">
                {field.name}
              </div>
              {field.dataType ? (
                <div class="shrink-0 text-[10px] text-neutral-500">
                  {field.dataType}
                </div>
              ) : null}
            </div>
            {fieldReadOnly ? (
              <div class="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-sm break-all text-neutral-900">
                {field.isNull && !draft.trim() ? (
                  <span class="text-neutral-400 italic">NULL</span>
                ) : (
                  draft
                )}
              </div>
            ) : (
              <div class="relative flex items-start gap-1">
                {isJsonField ? (
                  <textarea
                    class={cn(
                      "min-h-26 min-w-0 flex-1 resize-y rounded-md border border-slate-300 px-2 py-1.5 pr-6 font-mono text-xs leading-5",
                      "bg-white text-neutral-900 focus:bg-white focus:outline-2 focus:outline-blue-500"
                    )}
                    value={draft}
                    placeholder={field.isNull ? "NULL" : undefined}
                    onInput={(e) =>
                      setDraftValue(field.name, e.currentTarget.value)
                    }
                    onFocus={() => setOpenSpecialField(null)}
                    onBlur={(e) => commit(field.name, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                    }}
                  />
                ) : (
                  <div class="min-w-0 flex-1">
                    <Input
                      className="border border-slate-300 bg-white py-1 pr-8! text-sm"
                      value={draft}
                      placeholder={field.isNull ? "NULL" : undefined}
                      onFocus={() => setOpenSpecialField(null)}
                      onValueChange={(value) =>
                        setDraftValue(field.name, value)
                      }
                      onBlur={(e) =>
                        commit(
                          field.name,
                          (e.currentTarget as HTMLInputElement).value
                        )
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          (e.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                    />
                  </div>
                )}
                <SpecialValueDropdown
                  field={field}
                  open={specialOpen}
                  onToggle={() =>
                    setOpenSpecialField((current) =>
                      current === field.name ? null : field.name
                    )
                  }
                  onSelect={(action) => {
                    applySpecialValue(field, action);
                    setOpenSpecialField(null);
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TableSizeSection({
  sizeInfo,
  search = "",
}: {
  sizeInfo: TableSizeInfo;
  search?: string;
}) {
  const q = search.trim().toLowerCase();
  const rows = [
    { label: "Total Size", value: sizeInfo.totalSize || "0 KB" },
    { label: "Data Size", value: sizeInfo.dataSize || "0 KB" },
    { label: "Indexes Size", value: sizeInfo.indexSize || "0 KB" },
  ].filter((row) => {
    if (!q) return true;
    return (
      row.label.toLowerCase().includes(q) || row.value.toLowerCase().includes(q)
    );
  });

  return (
    <div class="space-y-2 border-t border-neutral-200 pt-3">
      {rows.length ? (
        rows.map((row) => (
          <div key={row.label} class="space-y-1 rounded-md">
            <div class="mb-1 text-xs font-medium text-neutral-500">
              {row.label}
            </div>
            <div class="rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm font-semibold capitalize">
              {row.value}
            </div>
          </div>
        ))
      ) : (
        <p class="text-xs text-neutral-500">No matching data info.</p>
      )}
    </div>
  );
}

function DataInfoSearch(props: {
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <Input
      value={props.value}
      placeholder="Search fields..."
      className="border border-neutral-200 bg-white py-1.5 text-xs"
      left={<SearchIcon className="size-3.5 text-neutral-500" />}
      onValueChange={props.onValueChange}
    />
  );
}

function DataInfoPane({
  sizeInfo,
  selectedRowDetail,
  tableLoadKey,
  dataReadOnly,
}: {
  sizeInfo: TableSizeInfo | null;
  selectedRowDetail: SelectedRowDetail | null;
  tableLoadKey: string | null;
  dataReadOnly?: boolean;
}) {
  const [search, setSearch] = useState("");
  const hasRow = !!selectedRowDetail?.fields.length;
  const q = search.trim().toLowerCase();
  const filteredFields = q
    ? (selectedRowDetail?.fields ?? []).filter((field) => {
        return field.name.toLowerCase().includes(q);
      })
    : (selectedRowDetail?.fields ?? []);

  if (!hasRow && !sizeInfo) {
    return (
      <Box className="p-4 text-center">
        <p class="text-sm text-neutral-500">No table selected</p>
      </Box>
    );
  }

  if (!hasRow) {
    return (
      <div class="flex h-full flex-col gap-2 overflow-y-auto bg-neutral-100 px-3 py-2">
        <DataInfoSearch value={search} onValueChange={setSearch} />
        {sizeInfo ? (
          <TableSizeSection sizeInfo={sizeInfo} search={search} />
        ) : null}
      </div>
    );
  }

  return (
    <div class="flex h-full flex-col gap-2 overflow-y-auto bg-neutral-100 px-3 py-2">
      <DataInfoSearch value={search} onValueChange={setSearch} />
      <EditableRowFieldList
        rowIndex={selectedRowDetail.rowIndex}
        fields={filteredFields}
        readOnly={dataReadOnly}
        tableLoadKey={tableLoadKey}
      />
    </div>
  );
}

export function RightNav({
  sizeInfo,
  selectedRowDetail,
  tableLoadKey,
  dataReadOnly,
}: Props) {
  return (
    <div class="flex h-full min-h-0 flex-col bg-neutral-100">
      <div class="min-h-0 flex-1 overflow-hidden">
        <DataInfoPane
          sizeInfo={sizeInfo}
          selectedRowDetail={selectedRowDetail}
          tableLoadKey={tableLoadKey}
          dataReadOnly={dataReadOnly}
        />
      </div>
    </div>
  );
}
