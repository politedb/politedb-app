import { useState } from "preact/hooks";
import type { ColumnMeta } from "src/lib/tauri/types";
import { Dropdown } from "src/components/common/Dropdown";
import { Button } from "src/components/common/Button";
import { ChevronDownIcon } from "src/components/icons";
import { formatRowsForClipboard } from "src/components/table/CanvasTable";
import { saveDialog, showMessage } from "src/lib/system-dialog";
import { writeTextFile } from "src/lib/system-fs";

const numberFormat = new Intl.NumberFormat("en-US");

export function formatElapsed(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

/** What a finished statement returned, in words. */
export function describeResult(args: {
  columns: number;
  rows: number;
  truncated?: boolean;
}) {
  if (args.columns === 0 && args.rows === 0) return "Statement completed";
  const rows = `${numberFormat.format(args.rows)} ${args.rows === 1 ? "row" : "rows"}`;
  return args.truncated
    ? `${rows} (stopped at the row limit; narrow the query to see the rest)`
    : rows;
}

/**
 * The line under a finished statement's result: what it returned, how long it
 * ran, and an export of the rows.
 */
export function SqlResultSummary(props: {
  columns: ColumnMeta[];
  rowCount: number;
  getRow: (index: number) => unknown[] | undefined;
  truncated?: boolean;
  elapsedMs?: number;
}) {
  const { columns, rowCount, getRow, truncated, elapsedMs } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const elapsed = formatElapsed(elapsedMs);

  const exportAs = async (format: "csv" | "json") => {
    // One boundary for the dialog, the rows and the write; cancel is silent.
    try {
      const path = await saveDialog({
        title: "Export result",
        defaultPath: `result.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!path) return;
      const rows: unknown[][] = [];
      for (let i = 0; i < rowCount; i++) {
        const row = getRow(i);
        if (row) rows.push(row);
      }
      const text = formatRowsForClipboard({
        format: format === "csv" ? "csv-header" : "json",
        columns,
        rows,
      });
      await writeTextFile(path, text);
    } catch {
      await showMessage(
        "The result could not be exported. Check that the folder is writable, then try again.",
        { title: "Export failed", kind: "error" }
      );
    }
  };

  return (
    <div
      class="flex shrink-0 items-center gap-3 border-t border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-600"
      role="status"
    >
      <span class="min-w-0 truncate tabular-nums">
        {describeResult({ columns: columns.length, rows: rowCount, truncated })}
        {elapsed ? ` · ${elapsed}` : ""}
      </span>
      {rowCount > 0 && columns.length > 0 ? (
        <Dropdown
          open={menuOpen}
          onOpenChange={setMenuOpen}
          positions={["top"]}
          align="end"
          widthClassName="w-40"
          items={[
            { label: "CSV", onSelect: () => void exportAs("csv") },
            { label: "JSON", onSelect: () => void exportAs("json") },
          ]}
          trigger={
            <Button
              variant="ghost"
              class="ml-auto h-6 gap-1 px-2 text-xs"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="Export the result rows"
            >
              Export
              <ChevronDownIcon className="size-3" />
            </Button>
          }
        />
      ) : null}
    </div>
  );
}
