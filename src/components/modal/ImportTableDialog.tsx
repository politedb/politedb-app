import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "src/components/common/Dialog";
import {
  buildDefaultImportMapping,
  DataImportPreview,
  ImportColumnMapping,
  ImportNullMode,
  type ImportIssue,
  validateImportPreview,
} from "src/hooks/useImportTableData";
import { Button } from "src/components/common/Button";
import { Checkbox } from "src/components/common/Checkbox";
import { ImportPreviewGrid } from "./import/ImportPreviewGrid";
import type { ColumnMeta } from "src/lib/tauri/types";
import { Spinner } from "src/components/common/Spinner";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import { DownloadIcon } from "../icons";

interface Props {
  open: boolean;
  schema: string;
  tableName: string;
  columns: ColumnMeta[];
  /** Columns the import must fill (NOT NULL, no default, not generated). */
  requiredColumns?: string[];
  /**
   * The import runs in one transaction on this engine: a failure usually
   * saves nothing, though that is never promised.
   */
  usesTransaction?: boolean;
  /**
   * Why importing (again) is not possible now, e.g. the connection changed
   * or the tab was locked after the import was submitted.
   */
  blockedReason?: string | null;
  /** Field separator in use (detected on load) and how to change it. */
  delimiter?: string;
  onDelimiterChange?: (delimiter: string) => void;
  dataPreview: DataImportPreview | null;
  error: string | null;
  importing: boolean;
  progress: { imported: number; total: number } | null;
  handleClose: () => void;
  onImport: (options: {
    firstIsHeaders: boolean;
    columnMapping: ImportColumnMapping;
    nullMode: ImportNullMode;
    fullValidation: boolean;
  }) => void;
}

const PREVIEW_ROWS = 10;
const ISSUE_EXAMPLES = 5;

const DELIMITERS: { value: string; label: string }[] = [
  { value: ",", label: "Comma (,)" },
  { value: ";", label: "Semicolon (;)" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe (|)" },
];

/** Validation issues grouped by column and problem, with example rows. */
function groupIssues(issues: ImportIssue[]) {
  const groups = new Map<
    string,
    { column: string; message: string; rows: number[] }
  >();
  for (const issue of issues) {
    const key = `${issue.column}\u0000${issue.message}`;
    const group = groups.get(key) ?? {
      column: issue.column,
      message: issue.message,
      rows: [],
    };
    group.rows.push(issue.row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * The first rows as they will land in the table: one column per mapped
 * table column, each taking its value from the chosen CSV column.
 */
export function previewTableData(
  preview: DataImportPreview,
  firstIsHeaders: boolean,
  mapped: { name: string; csvIndex: number }[],
  nullMode: ImportNullMode
) {
  const rows = firstIsHeaders
    ? preview.rows.slice(0, PREVIEW_ROWS)
    : [preview.headers, ...preview.rows.slice(0, PREVIEW_ROWS - 1)];
  return rows.map((row) => {
    const obj: Record<string, string | null> = {};
    for (const { name, csvIndex } of mapped) {
      const raw = row[csvIndex] ?? "";
      obj[name] = raw === "" && nullMode === "empty-as-null" ? null : raw;
    }
    return obj;
  });
}

export function ImportTableDialog({
  open,
  schema,
  tableName,
  columns,
  requiredColumns = [],
  usesTransaction = false,
  blockedReason = null,
  delimiter = ",",
  onDelimiterChange,
  dataPreview,
  error,
  importing,
  progress,
  handleClose,
  onImport,
}: Props) {
  const [firstIsHeaders, setFirstIsHeaders] = useState(true);
  const [nullMode, setNullMode] = useState<ImportNullMode>("empty-string");
  const [fullValidation, setFullValidation] = useState(false);
  const [columnMapping, setColumnMapping] = useState<ImportColumnMapping>({});
  // Columns the user mapped by hand: re-guessing never overrides them.
  const touchedRef = useRef(new Set<string>());

  const onClose = useCallback(() => {
    if (importing) return;
    handleClose();
  }, [importing, handleClose]);

  const mappedColumns = useMemo(
    () =>
      columns.flatMap((col) => {
        const csvIndex = columnMapping[col.name];
        // Only columns the current file has (see selectValue).
        return csvIndex != null &&
          csvIndex >= 0 &&
          csvIndex < (dataPreview?.headers.length ?? 0)
          ? [{ name: col.name, csvIndex }]
          : [];
      }),
    [columns, columnMapping, dataPreview]
  );

  // Table columns that receive a CSV value, with their types.
  const previewColumns = useMemo(
    () =>
      mappedColumns.map(
        ({ name }) =>
          columns.find((col) => col.name === name) ?? { name, db_type: "" }
      ),
    [mappedColumns, columns]
  );

  const tableData = useMemo(() => {
    if (!dataPreview) return [];
    return previewTableData(
      dataPreview,
      firstIsHeaders,
      mappedColumns,
      nullMode
    );
  }, [dataPreview, firstIsHeaders, mappedColumns, nullMode]);

  useEffect(() => {
    if (!dataPreview) return;
    const guessed = buildDefaultImportMapping(
      dataPreview,
      columns,
      firstIsHeaders
    );
    setColumnMapping((prev) => {
      const next = { ...guessed };
      for (const name of touchedRef.current) {
        const index = prev[name];
        if (index == null || index < dataPreview.headers.length) {
          next[name] = index ?? null;
        }
      }
      return next;
    });
  }, [dataPreview, columns, firstIsHeaders]);

  const missingRequired = useMemo(
    () =>
      requiredColumns.filter((name) => {
        const index = columnMapping[name];
        return index == null || index < 0;
      }),
    [requiredColumns, columnMapping]
  );

  const csvColumnsKey = dataPreview
    ? `${delimiter}\u0000${firstIsHeaders}\u0000${dataPreview.headers.join("\u0000")}`
    : "";

  // The choice to show: an index from before the CSV columns changed
  // (the mapping is re-guessed right after) shows as Skip, never blank.
  const selectValue = (name: string) => {
    const index = columnMapping[name];
    return index != null &&
      index >= 0 &&
      index < (dataPreview?.headers.length ?? 0)
      ? String(index)
      : "";
  };

  // One column only, yet it contains another separator: likely the wrong
  // separator is selected.
  const separatorHint = useMemo(() => {
    if (!dataPreview || dataPreview.headers.length !== 1) return null;
    const sample = [
      dataPreview.headers[0] ?? "",
      ...(dataPreview.rows[0] ?? []),
    ].join("\n");
    const other = DELIMITERS.find(
      (d) => d.value !== delimiter && sample.includes(d.value)
    );
    return other ?? null;
  }, [dataPreview, delimiter]);

  // Open the mapping when a column is left without a CSV column.
  const mappingNeedsAttention =
    missingRequired.length > 0 ||
    columns.some((col) => {
      const index = columnMapping[col.name];
      return index == null || index < 0;
    });

  const validationIssues = useMemo(() => {
    if (!dataPreview) return [];
    return validateImportPreview(dataPreview, columns, {
      firstIsHeaders,
      columnMapping,
      nullMode,
      fullValidation,
    });
  }, [
    dataPreview,
    columns,
    firstIsHeaders,
    columnMapping,
    nullMode,
    fullValidation,
  ]);

  const mappedColumnCount = useMemo(
    () =>
      Object.values(columnMapping).filter(
        (value): value is number => value != null && value >= 0
      ).length,
    [columnMapping]
  );

  const issueGroups = useMemo(
    () => groupIssues(validationIssues),
    [validationIssues]
  );
  // The import runs as one transaction: there is no row-by-row progress,
  // only "running" and "done".
  const done = !!progress && !importing && !dataPreview;

  return (
    <>
      {/* Header and footer stay put; only the content between them scrolls. */}
      <Dialog
        open={open}
        onClose={onClose}
        size={progress ? "sm" : "xl"}
        className="flex max-h-[85vh] flex-col overflow-hidden"
      >
        <DialogHeader className="shrink-0 border-b border-neutral-200">
          <DialogTitle className="flex items-center gap-2">
            <DownloadIcon className="size-4.5 text-neutral-600" />
            Import CSV data
          </DialogTitle>
          <DialogDescription className="truncate dark:text-neutral-400">
            Import the CSV data into the selected table.
          </DialogDescription>
        </DialogHeader>
        <DialogContent className="min-h-0 flex-1 overflow-hidden p-0">
          <OverlayScrollArea
            className="h-full min-h-0"
            contentClassName="flex flex-col gap-2 px-6 py-4"
          >
            {error ? (
              <div
                role="alert"
                class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
              >
                <div class="font-medium">
                  {done
                    ? "The rows were imported, but a later step failed."
                    : "The import stopped."}
                </div>
                <div class="mt-1 wrap-break-word">{error}</div>
                {done ? null : (
                  <div class="mt-1">
                    {usesTransaction
                      ? "It ran in a transaction, so usually nothing was saved. Check the table before importing again."
                      : "Rows before the failing one may already be saved: check the table before importing again."}
                  </div>
                )}
              </div>
            ) : null}
            {blockedReason ? (
              <div
                role="alert"
                class="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
              >
                {blockedReason}
              </div>
            ) : null}
            {missingRequired.length > 0 ? (
              <div
                role="alert"
                class="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
              >
                Choose a CSV column for {missingRequired.join(", ")}: the table
                requires a value and has no default.
              </div>
            ) : null}
            {dataPreview && (
              <>
                {/* Compact options: the data and its preview get the room. */}
                <div class="space-y-2">
                  <div class="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                    <p class="flex items-center gap-2 font-medium">
                      Table{" "}
                      <span class="rounded-md border border-neutral-200 px-2 py-1 font-mono text-xs shadow">
                        {schema}.{tableName}
                      </span>
                    </p>
                    <label class="flex items-center gap-2 text-sm">
                      Separator
                      <select
                        class="h-7 rounded border border-neutral-200 bg-white px-2 font-mono! text-xs!"
                        value={delimiter}
                        disabled={importing || !onDelimiterChange}
                        onChange={(e) =>
                          onDelimiterChange?.(
                            (e.currentTarget as HTMLSelectElement).value
                          )
                        }
                      >
                        {DELIMITERS.map((d) => (
                          <option key={d.value} value={d.value}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div class="flex flex-wrap items-center gap-x-5 gap-y-1">
                    <span title="Use the first row as column names.">
                      <Checkbox
                        checked={firstIsHeaders}
                        onChange={(e) =>
                          setFirstIsHeaders(
                            (e.target as HTMLInputElement).checked
                          )
                        }
                        label="First row is headers"
                      />
                    </span>
                    <span title="Otherwise an empty cell is saved as an empty string.">
                      <Checkbox
                        checked={nullMode === "empty-as-null"}
                        onChange={(e) =>
                          setNullMode(
                            (e.target as HTMLInputElement).checked
                              ? "empty-as-null"
                              : "empty-string"
                          )
                        }
                        label="Empty values as NULL"
                      />
                    </span>
                    <span title="Check every row, not only the first 100.">
                      <Checkbox
                        checked={fullValidation}
                        onChange={(e) =>
                          setFullValidation(
                            (e.target as HTMLInputElement).checked
                          )
                        }
                        label="Validate all rows before import"
                      />
                    </span>
                  </div>
                </div>

                <div class="rounded-lg">
                  <p class="mb-1 py-1 text-sm font-medium">
                    Preview of the rows to insert{" "}
                    <span class="font-normal text-neutral-500">
                      (first {PREVIEW_ROWS} rows)
                    </span>
                  </p>
                  {mappedColumns.length > 0 ? (
                    <ImportPreviewGrid
                      columns={previewColumns}
                      rows={tableData}
                    />
                  ) : (
                    <div
                      role="status"
                      class="rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-600"
                    >
                      {separatorHint ? (
                        <>
                          Only one column was found: the file seems to use{" "}
                          {separatorHint.label.toLowerCase()} as its separator.{" "}
                          {onDelimiterChange ? (
                            <button
                              type="button"
                              class="font-medium text-blue-600 underline-offset-2 hover:underline"
                              onClick={() =>
                                onDelimiterChange(separatorHint.value)
                              }
                            >
                              Use {separatorHint.label}
                            </button>
                          ) : null}
                        </>
                      ) : (
                        "No CSV column is matched to a table column yet. Choose them under Column mapping."
                      )}
                    </div>
                  )}
                </div>
                <p class="text-xs text-neutral-600">
                  CSV {dataPreview.headers.length} columns,{" "}
                  {dataPreview.rows.length} rows, {mappedColumnCount} mapped
                  columns
                </p>
                {issueGroups.length > 0 && (
                  <div
                    role="alert"
                    class="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700"
                  >
                    <p class="mb-1 font-medium">
                      {validationIssues.length}{" "}
                      {validationIssues.length === 1
                        ? "value needs fixing"
                        : "values need fixing"}
                      {fullValidation ? "" : ` in the first 100 rows`}:
                    </p>
                    <ul class="space-y-0.5">
                      {issueGroups.map((group) => (
                        <li key={`${group.column}:${group.message}`}>
                          <span class="font-mono">{group.column}</span>:{" "}
                          {group.message} — row
                          {group.rows.length === 1 ? "" : "s"}{" "}
                          {group.rows.slice(0, ISSUE_EXAMPLES).join(", ")}
                          {group.rows.length > ISSUE_EXAMPLES
                            ? ` and ${group.rows.length - ISSUE_EXAMPLES} more`
                            : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {/* The mapping folds away once every column is matched;
                    it opens by itself when something needs a choice. */}
                <details
                  open={mappingNeedsAttention}
                  class="rounded-lg border border-neutral-200"
                >
                  <summary class="cursor-pointer px-2 py-2 text-sm font-medium select-none">
                    Column mapping{" "}
                    <span class="font-normal text-neutral-500">
                      · {mappedColumnCount} of {columns.length} matched
                      {missingRequired.length > 0
                        ? ` · ${missingRequired.length} required not mapped`
                        : ""}
                    </span>
                  </summary>
                  <div class="overflow-x-auto border-t border-neutral-200">
                    <table class="w-full">
                      <thead class="sticky top-0 bg-neutral-50 text-sm">
                        <tr>
                          <th class="p-2 text-left font-medium">
                            Table column
                          </th>
                          <th class="p-2 text-left font-medium">Data type</th>
                          <th class="p-2 text-left font-medium">CSV column</th>
                        </tr>
                      </thead>
                      <tbody class="text-xs">
                        {columns.map((column) => (
                          <tr
                            key={column.name}
                            class="border-t border-neutral-100"
                          >
                            <td class="px-2 py-1 font-mono">
                              {column.name}
                              {requiredColumns.includes(column.name) ? (
                                <span
                                  class={
                                    missingRequired.includes(column.name)
                                      ? "ml-1.5 font-sans text-red-600"
                                      : "ml-1.5 font-sans text-neutral-400"
                                  }
                                  title="NOT NULL without a default: needs a CSV column"
                                >
                                  required
                                </span>
                              ) : null}
                            </td>
                            <td class="px-2 py-1 font-mono">
                              {column.db_type || "text"}
                            </td>
                            <td class="px-2 py-1">
                              <select
                                // New CSV columns (separator, header row):
                                // a fresh select, so it never shows a choice
                                // that no longer exists.
                                key={csvColumnsKey}
                                aria-label={`CSV column for ${column.name}`}
                                class="h-6 w-full rounded border border-neutral-200 bg-white px-2 py-1 font-mono! text-xs!"
                                value={selectValue(column.name)}
                                onChange={(e) => {
                                  const value = (
                                    e.currentTarget as HTMLSelectElement
                                  ).value;
                                  touchedRef.current.add(column.name);
                                  setColumnMapping((prev) => ({
                                    ...prev,
                                    [column.name]:
                                      value === "" ? null : Number(value),
                                  }));
                                }}
                              >
                                <option value="">Skip</option>
                                {dataPreview.headers.map((header, index) => (
                                  <option
                                    key={`${header}:${index}`}
                                    value={index}
                                  >
                                    {firstIsHeaders
                                      ? header || `Column ${index + 1}`
                                      : `Column ${index + 1}`}
                                  </option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            )}

            {progress && (
              <div
                class="flex items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50/80 p-3 text-sm"
                role="status"
              >
                {done ? (
                  <span class="text-green-700">
                    Imported {progress.imported.toLocaleString()}{" "}
                    {progress.imported === 1 ? "row" : "rows"} into{" "}
                    <span class="font-mono">
                      {schema}.{tableName}
                    </span>
                    .
                  </span>
                ) : (
                  <>
                    <Spinner className="size-4 text-blue-600" />
                    <span>
                      Importing {progress.total.toLocaleString()}{" "}
                      {progress.total === 1 ? "row" : "rows"} into{" "}
                      <span class="font-mono">
                        {schema}.{tableName}
                      </span>
                      …
                    </span>
                  </>
                )}
              </div>
            )}
          </OverlayScrollArea>
        </DialogContent>
        <DialogFooter className="shrink-0 border-t border-neutral-200">
          <Button variant="outline" onClick={onClose} disabled={importing}>
            {done ? "Close" : "Cancel"}
          </Button>
          {dataPreview && (dataPreview.rows.length > 0 || !firstIsHeaders) && (
            <Button
              variant="default"
              onClick={() =>
                onImport({
                  firstIsHeaders,
                  columnMapping,
                  nullMode,
                  fullValidation,
                })
              }
              disabled={
                importing ||
                mappedColumnCount === 0 ||
                validationIssues.length > 0 ||
                missingRequired.length > 0 ||
                !!blockedReason
              }
            >
              {importing ? "Importing…" : "Import"}
            </Button>
          )}
        </DialogFooter>
      </Dialog>
    </>
  );
}
