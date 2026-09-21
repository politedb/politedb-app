import { useCallback, useMemo, useState } from "preact/hooks";
import { Button } from "../common/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../common/Dialog";
import type { PatchData, PatchMap } from "src/utils/generateSql";
import {
  buildMongoOperations,
  generateSqlFromPatches,
} from "src/utils/generateSql";
import { DATA_ACTIONS } from "src/constant";
import { DataKey } from "src/stores/connection";
import { highlightSql } from "src/screens/connection/QueryHistory";
import type { DatabaseEngine } from "src/types";
import { CopyCheckIcon, CopyIcon } from "src/components/icons";
import { buildPatchDiffs } from "src/utils/patchDiff";
import { sqlForDisplay } from "src/utils/sqlDialect";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import { cn } from "src/utils/cn";
import type { ObjectChangeSummary } from "src/lib/objectEditorDraftCache";
import { emptyObjectChangeSummary } from "src/lib/objectEditorDraftCache";

type ChangeSummary = {
  inserts: number;
  updates: number;
  deletes: number;
  structureChanges: number;
  constraintChanges: number;
  totalSqlStatements: number;
  sqlStatements: string[];
};

function countByAction(patches: PatchData, key: DataKey): number {
  return Object.values(DATA_ACTIONS).reduce((sum, action) => {
    const target = patches?.[action]?.[key];
    return (
      sum +
      (target && typeof target === "object" ? Object.keys(target).length : 0)
    );
  }, 0);
}

function analyzePatches(
  patchMap: PatchMap,
  engine: DatabaseEngine = "postgres",
  options?: {
    activeScreen?: string;
    getRowAt?: (key: string, rowIndex: number) => unknown[] | undefined;
    getOriginalRowAt?: (key: string, rowIndex: number) => unknown[] | undefined;
    offset?: number;
  }
): ChangeSummary {
  let inserts = 0;
  let updates = 0;
  let deletes = 0;
  let structureChanges = 0;
  let constraintChanges = 0;

  for (const { patches } of Object.values(patchMap)) {
    if (!patches) continue;

    inserts += Object.keys(patches.create?.data ?? {}).length;
    updates += Object.keys(patches.update?.data ?? {}).length;
    deletes += Object.keys(patches.delete?.data ?? {}).length;

    structureChanges += countByAction(patches, "structure");
    constraintChanges += countByAction(patches, "constraints");
  }

  const sqlStatements =
    engine === "mongo"
      ? buildMongoOperations(patchMap, options)
      : generateSqlFromPatches(patchMap, engine, options);

  return {
    inserts,
    updates,
    deletes,
    structureChanges,
    constraintChanges,
    sqlStatements,
    totalSqlStatements: sqlStatements.length,
  };
}

function formatCountPart(
  count: number,
  singular: string,
  plural = `${singular}s`
) {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildActionParts(parts: Array<string | null | undefined>): string[] {
  return parts.filter((part): part is string => !!part);
}

interface SummaryItemProps {
  label: string;
  color: string;
  parts: string[];
}

function SummaryItem({ label, color, parts }: SummaryItemProps) {
  if (parts.length === 0) return null;

  return (
    <div class="flex items-start gap-2 sm:col-span-2">
      <span class={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${color}`}>
        {label}
      </span>
      <span class="text-neutral-700">{parts.join(", ")}</span>
    </div>
  );
}

const SQL_BORDER_COLORS = {
  // Prefer utilities that have html.dark remaps in styles.css (light text on tinted dark cards).
  create: "border-blue-300 bg-blue-100",
  insert: "border-green-200 bg-green-50",
  update: "border-amber-300 bg-amber-100",
  delete: "border-rose-300 bg-red-50",
  structure: "border-blue-300 bg-blue-100",
  constraint: "border-indigo-200 bg-indigo-100",
};

function getSqlType(sql: string): keyof typeof SQL_BORDER_COLORS {
  const upperSql = sql.trim().toUpperCase();
  if (upperSql.startsWith("CREATE TABLE")) return "create";
  if (
    upperSql.startsWith("CREATE FUNCTION") ||
    upperSql.startsWith("CREATE OR REPLACE FUNCTION") ||
    upperSql.startsWith("CREATE PROCEDURE") ||
    upperSql.startsWith("CREATE OR REPLACE PROCEDURE") ||
    upperSql.startsWith("CREATE TRIGGER") ||
    upperSql.startsWith("CREATE OR REPLACE TRIGGER") ||
    upperSql.startsWith("CREATE CONSTRAINT TRIGGER")
  ) {
    return "create";
  }
  if (
    upperSql.startsWith("DROP FUNCTION") ||
    upperSql.startsWith("DROP PROCEDURE") ||
    upperSql.startsWith("DROP TRIGGER")
  ) {
    return "delete";
  }
  if (upperSql.startsWith("INSERT")) return "insert";
  if (upperSql.startsWith("UPDATE")) return "update";
  if (upperSql.startsWith("DELETE")) return "delete";
  if (upperSql.includes(".INSERTONE(") || upperSql.includes(".INSERTMANY("))
    return "insert";
  if (upperSql.includes(".UPDATEONE(") || upperSql.includes(".UPDATEMANY("))
    return "update";
  if (upperSql.includes(".DELETEONE(") || upperSql.includes(".DELETEMANY("))
    return "delete";
  if (upperSql.startsWith("ALTER TABLE")) {
    // Check if it's a constraint change
    if (
      upperSql.includes("ADD CONSTRAINT") ||
      upperSql.includes("DROP CONSTRAINT") ||
      upperSql.includes("CONSTRAINT")
    ) {
      return "constraint";
    }
    return "structure";
  }
  return "create"; // default
}

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  patchMap: PatchMap;
  engine: DatabaseEngine;
  newTableSql?: string[];
  objectSql?: string[];
  objectChangeSummary?: ObjectChangeSummary;
  activeScreen?: string;
  getRowAt?: (key: string, rowIndex: number) => unknown[] | undefined;
  getOriginalRowAt?: (key: string, rowIndex: number) => unknown[] | undefined;
  offset?: number;
}

export function SaveChangesDialog({
  open,
  onClose,
  onConfirm,
  patchMap,
  engine,
  newTableSql = [],
  objectSql = [],
  objectChangeSummary,
  activeScreen,
  getRowAt,
  getOriginalRowAt,
  offset = 0,
}: Props) {
  const isMongo = engine === "mongo";
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const summary = useMemo(
    () =>
      analyzePatches(patchMap, engine, {
        activeScreen,
        getRowAt,
        getOriginalRowAt,
        offset,
      }),
    [patchMap, engine, activeScreen, getRowAt, getOriginalRowAt, offset]
  );

  const allSqlStatements = useMemo(() => {
    const patchSql = summary.sqlStatements;
    return [...(newTableSql || []), ...(objectSql || []), ...patchSql];
  }, [summary.sqlStatements, newTableSql, objectSql]);

  const displaySqlStatements = useMemo(
    () => allSqlStatements.map((sql) => sqlForDisplay(sql, engine)),
    [allSqlStatements, engine]
  );

  const rowDiffs = useMemo(
    () =>
      buildPatchDiffs(patchMap, {
        activeScreen,
        getRowAt,
        getOriginalRowAt,
        offset,
      }),
    [patchMap, activeScreen, getRowAt, getOriginalRowAt, offset]
  );

  const objectSummary = objectChangeSummary ?? emptyObjectChangeSummary();

  const rowEntity = isMongo ? "document" : "row";
  const rowEntityPlural = isMongo ? "documents" : "rows";
  const structureEntity = isMongo ? "field" : "column";
  const structureEntityPlural = isMongo ? "fields" : "columns";

  const insertSummaryParts = useMemo(
    () =>
      buildActionParts([
        formatCountPart(newTableSql?.length ?? 0, "table"),
        formatCountPart(summary.inserts, rowEntity, rowEntityPlural),
        formatCountPart(objectSummary.insertFunctions, "function"),
        formatCountPart(objectSummary.insertProcedures, "procedure"),
        formatCountPart(objectSummary.insertTriggers, "trigger"),
      ]),
    [
      newTableSql,
      summary.inserts,
      rowEntity,
      rowEntityPlural,
      objectSummary.insertFunctions,
      objectSummary.insertProcedures,
      objectSummary.insertTriggers,
    ]
  );

  const updateSummaryParts = useMemo(
    () =>
      buildActionParts([
        formatCountPart(summary.updates, rowEntity, rowEntityPlural),
        formatCountPart(objectSummary.updateFunctions, "function"),
        formatCountPart(objectSummary.updateProcedures, "procedure"),
        formatCountPart(objectSummary.updateTriggers, "trigger"),
      ]),
    [
      summary.updates,
      rowEntity,
      rowEntityPlural,
      objectSummary.updateFunctions,
      objectSummary.updateProcedures,
      objectSummary.updateTriggers,
    ]
  );

  const deleteSummaryParts = useMemo(
    () =>
      buildActionParts([
        formatCountPart(summary.deletes, rowEntity, rowEntityPlural),
      ]),
    [summary.deletes, rowEntity, rowEntityPlural]
  );

  const structureSummaryParts = useMemo(
    () =>
      buildActionParts([
        formatCountPart(
          summary.structureChanges,
          structureEntity,
          structureEntityPlural
        ),
        formatCountPart(summary.constraintChanges, "constraint", "constraints"),
      ]),
    [
      summary.structureChanges,
      summary.constraintChanges,
      structureEntity,
      structureEntityPlural,
    ]
  );

  const hasChanges =
    summary.inserts > 0 ||
    summary.updates > 0 ||
    summary.deletes > 0 ||
    summary.structureChanges > 0 ||
    summary.constraintChanges > 0 ||
    newTableSql?.length > 0 ||
    objectSql?.length > 0;

  const onCopyStatement = useCallback(async (sql: string, index: number) => {
    setCopiedIndex(index);
    await navigator.clipboard.writeText(sql);
    setTimeout(() => {
      setCopiedIndex((current) => (current === index ? null : current));
    }, 1000);
  }, []);

  if (!hasChanges) {
    return null;
  }

  return (
    <Dialog
      size="lg"
      open={open}
      onClose={onClose}
      closeOnOutsideClick={false}
      className="flex max-h-[min(90vh,50rem)] flex-col overflow-hidden"
    >
      <DialogHeader className="shrink-0">
        <DialogTitle>Review changes before saving</DialogTitle>
        <DialogDescription>
          Review all changes before saving to the database.
        </DialogDescription>
      </DialogHeader>

      <DialogContent className="min-h-0 flex-1 overflow-hidden py-1">
        <OverlayScrollArea
          className="h-full min-h-0"
          contentClassName="space-y-4"
        >
          {/* Summary Section */}
          <div class="w-full rounded-lg border border-neutral-200">
            <div class="rounded-t-lg border-b border-neutral-200 bg-neutral-50 px-4 py-2">
              <h3 class="text-sm font-semibold text-neutral-900">
                Summary of Changes
              </h3>
            </div>
            <div class="grid grid-cols-1 gap-2 p-4 text-sm sm:grid-cols-2">
              <SummaryItem
                label="INSERT"
                color="bg-green-50 text-green-700"
                parts={insertSummaryParts}
              />
              <SummaryItem
                label="UPDATE"
                color="bg-amber-100 text-amber-800"
                parts={updateSummaryParts}
              />
              <SummaryItem
                label="DELETE"
                color="bg-red-50 text-red-700"
                parts={deleteSummaryParts}
              />
              <SummaryItem
                label="STRUCTURE"
                color="bg-blue-100 text-blue-800"
                parts={structureSummaryParts}
              />
            </div>
          </div>

          {rowDiffs.length > 0 && (
            <div class="w-full rounded-lg border border-neutral-200">
              <div class="rounded-t-lg border-b border-neutral-200 bg-neutral-50 px-4 py-2">
                <h3 class="text-sm font-semibold text-neutral-900">
                  Row & Column Diff ({rowDiffs.length})
                </h3>
              </div>
              <OverlayScrollArea
                className="max-h-45 w-full"
                contentClassName="space-y-3 p-4"
              >
                {rowDiffs.map((diff, index) => (
                  <div
                    key={`${diff.table}:${diff.action}:${diff.rowKey}:${index}`}
                    class="space-y-2 rounded-md border border-neutral-200 bg-white p-3"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <div class="min-w-0">
                        <p class="truncate font-mono text-xs text-neutral-600">
                          Table: {diff.table}
                        </p>
                        <p class="truncate font-mono text-xs text-neutral-600">
                          {diff.identity}
                        </p>
                      </div>
                      <span
                        class={cn(
                          "rounded bg-neutral-100 px-2 py-0.5 text-xs font-semibold text-neutral-700 uppercase",
                          diff.action === "insert" &&
                            "bg-green-50 text-green-700",
                          diff.action === "update" &&
                            "bg-amber-100 text-amber-700",
                          diff.action === "delete" && "bg-red-100 text-red-700"
                        )}
                      >
                        {diff.action}
                      </span>
                    </div>
                    {diff.cells.length > 0 && (
                      <div class="space-y-1">
                        {diff.cells.map((cell) => (
                          <div
                            key={cell.column}
                            class="grid grid-cols-[minmax(90px,140px)_1fr_1fr] gap-2 text-xs"
                          >
                            <span class="truncate font-medium text-neutral-700">
                              {cell.column}
                            </span>
                            <span class="truncate rounded bg-red-50 px-2 py-1 font-mono text-red-700">
                              {cell.oldValue || "NULL"}
                            </span>
                            <span class="truncate rounded bg-green-50 px-2 py-1 font-mono text-green-700">
                              {cell.newValue || "NULL"}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </OverlayScrollArea>
            </div>
          )}

          {/* SQL Statements Section */}
          <div class="mb-1 w-full rounded-lg border border-neutral-200">
            <div class="rounded-t-lg border-b border-neutral-200 bg-neutral-50 px-4 py-2">
              <h3 class="text-sm font-semibold text-neutral-900">
                {isMongo
                  ? `Mongo Operations to Execute (${allSqlStatements.length})`
                  : `SQL Statements to Execute (${allSqlStatements.length})`}
              </h3>
            </div>
            <OverlayScrollArea
              className="max-h-52 w-full"
              contentClassName="p-4"
            >
              {allSqlStatements.length === 0 ? (
                <div class="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  {isMongo
                    ? "There are pending changes, but no Mongo operations were generated."
                    : "There are pending changes, but no SQL statements were generated. Review the diff before saving."}
                </div>
              ) : (
                <div class="space-y-3">
                  {displaySqlStatements.map((sql, index) => {
                    const sqlType = getSqlType(sql);
                    const borderColor = SQL_BORDER_COLORS[sqlType];
                    const copied = copiedIndex === index;
                    return (
                      <div
                        key={index}
                        class={`group relative rounded border p-3 ${borderColor}`}
                      >
                        <div class="absolute top-2 right-2 z-10">
                          <Button
                            variant="ghost"
                            class={`h-6 px-2 text-xs text-neutral-600 hover:bg-white/60 hover:text-neutral-800 ${
                              copied
                                ? "opacity-100"
                                : "opacity-0 group-hover:opacity-100"
                            } transition-opacity`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void onCopyStatement(sql, index);
                            }}
                            title={copied ? "Copied!" : "Copy statement"}
                          >
                            {copied ? (
                              <CopyCheckIcon className="size-3.5 text-green-700" />
                            ) : (
                              <CopyIcon className="size-3.5" />
                            )}
                          </Button>
                        </div>
                        <div class="line-clamp-3 pr-8 font-mono text-xs wrap-break-word">
                          {highlightSql(sql)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </OverlayScrollArea>
          </div>
        </OverlayScrollArea>
      </DialogContent>

      <DialogFooter className="shrink-0">
        <Button className="py-1.5" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button className="py-1.5" variant="default" onClick={onConfirm}>
          Confirm & Apply
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
