import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  formatShortcutLabel,
  isMacPlatform,
} from "src/stores/keyboardShortcuts";
import { Button } from "../common/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../common/Dialog";
import type { PatchData, PatchMap } from "src/lib/patches/generateSql";
import {
  buildMongoOperations,
  generateSqlFromPatches,
} from "src/lib/patches/generateSql";
import { DATA_ACTIONS } from "src/constant";
import { DataKey } from "src/stores/connection";
import { highlightSql } from "src/screens/connection/sql/QueryHistory";
import type { DatabaseEngine } from "src/types";
import { CopyCheckIcon, CopyIcon } from "src/components/icons";
import { buildPatchDiffs } from "src/lib/patches/patchDiff";
import { sqlForDisplay } from "src/lib/sql/sqlDialect";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import { cn } from "src/utils/cn";
import type {
  ObjectChangeSummary,
  ObjectSaveNotice,
} from "src/lib/objectEditorDraftCache";
import { emptyObjectChangeSummary } from "src/lib/objectEditorDraftCache";
import {
  classifySaveStatement,
  describeDestructiveChanges,
  type SaveStatementKind,
} from "./saveReviewSql";

type ChangeSummary = {
  inserts: number;
  updates: number;
  deletes: number;
  structureChanges: number;
  constraintChanges: number;
  totalSqlStatements: number;
  sqlStatements: string[];
  /** Why the SQL could not be generated, if it could not. */
  sqlError: string | null;
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

  // A change the engine cannot express (e.g. altering a SQLite column)
  // throws; show why instead of breaking the dialog.
  let sqlStatements: string[] = [];
  let sqlError: string | null = null;
  try {
    sqlStatements =
      engine === "mongo"
        ? buildMongoOperations(patchMap, options)
        : generateSqlFromPatches(patchMap, engine, options);
  } catch (error) {
    sqlError = error instanceof Error ? error.message : String(error);
  }

  return {
    sqlError,
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

const SQL_BORDER_COLORS: Record<SaveStatementKind, string> = {
  // Prefer utilities that have html.dark remaps in styles.css (light text on tinted dark cards).
  create: "border-blue-300 bg-blue-100",
  insert: "border-green-200 bg-green-50",
  update: "border-amber-300 bg-amber-100",
  delete: "border-rose-300 bg-red-50",
  structure: "border-blue-300 bg-blue-100",
  constraint: "border-indigo-200 bg-indigo-100",
  destructive: "border-rose-300 bg-red-50 border-l-4 border-l-red-500",
};

/** A diff value: SQL NULL and an empty string never look alike. */
function DiffValue(props: {
  value: string | null | undefined;
  tone: "old" | "new";
}) {
  const { value, tone } = props;
  const base = cn(
    "truncate rounded px-2 py-1 font-mono",
    tone === "old" ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"
  );
  if (value === undefined) {
    return (
      <span
        class={cn(base, "bg-transparent text-neutral-400")}
        title="No previous value"
      >
        —
      </span>
    );
  }
  if (value === null) {
    return (
      <span class={cn(base, "italic opacity-70")} title="NULL">
        NULL
      </span>
    );
  }
  if (value === "") {
    return (
      <span class={cn(base, "italic opacity-70")} title="Empty string">
        (empty)
      </span>
    );
  }
  return (
    <span class={base} title={value}>
      {value}
    </span>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Runs the save; a rejection keeps the dialog open with its message. */
  onConfirm: () => void | Promise<void>;
  patchMap: PatchMap;
  /** Where the changes go, e.g. "Production · shop" (shown, never logged). */
  targetLabel?: string;
  engine: DatabaseEngine;
  newTableSql?: string[];
  objectSql?: string[];
  objectChangeSummary?: ObjectChangeSummary;
  /** Object drafts this save skips (and why) or runs over a newer definition. */
  objectNotices?: ObjectSaveNotice[];
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
  targetLabel,
  engine,
  newTableSql = [],
  objectSql = [],
  objectChangeSummary,
  objectNotices = [],
  activeScreen,
  getRowAt,
  getOriginalRowAt,
  offset = 0,
}: Props) {
  const isMongo = engine === "mongo";
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // A ref, so a second click before the re-render cannot start a 2nd save.
  const savingRef = useRef(false);

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

  // Only notices (e.g. an empty new function): nothing would run.
  const onlyNotices =
    allSqlStatements.length === 0 &&
    Object.keys(patchMap ?? {}).length === 0 &&
    objectNotices.length > 0;
  const skippedNotices = objectNotices.filter((n) => n.kind === "skipped");
  const conflictNotices = objectNotices.filter((n) => n.kind === "conflict");

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

  const destructiveParts = useMemo(
    () =>
      describeDestructiveChanges({
        statements: allSqlStatements,
        deletedRows: summary.deletes,
        engine,
        rowNoun: isMongo
          ? { one: "document", many: "documents" }
          : { one: "row", many: "rows" },
      }),
    [allSqlStatements, summary.deletes, isMongo, engine]
  );

  const confirm = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onConfirm();
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : String(error ?? "")
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [onConfirm]);

  const close = useCallback(() => {
    if (!savingRef.current) onClose();
  }, [onClose]);

  const destructive = destructiveParts.length > 0;
  // Only something to run can be confirmed (click or Mod+Enter).
  const canConfirm =
    !summary.sqlError && !saving && allSqlStatements.length > 0;

  // Focus starts on Save, or on Cancel when the save cannot be undone.
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!open || focusedRef.current) return;
    const target = document.querySelector<HTMLButtonElement>(
      destructive || !canConfirm
        ? "[data-review-cancel]"
        : "[data-review-confirm]"
    );
    if (!target || target.disabled) return;
    focusedRef.current = true;
    target.focus();
  }, [open, destructive, canConfirm]);

  // Mod+Enter saves, except when the save cannot be undone (click it).
  // Any Mod+Enter is kept inside the dialog (captured on window before the
  // app's shortcuts and the editor see it); only the exact chord saves.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const mac = isMacPlatform();
      const mod = mac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      e.preventDefault();
      e.stopPropagation();
      const exact = !e.shiftKey && !e.altKey && !(mac ? e.ctrlKey : e.metaKey);
      if (!exact || destructive || !canConfirm) return;
      void confirm();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, destructive, canConfirm, confirm]);

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
    objectSql?.length > 0 ||
    objectNotices.length > 0;

  const onCopyAll = useCallback(async () => {
    setCopiedAll(true);
    await navigator.clipboard.writeText(displaySqlStatements.join("\n\n"));
    setTimeout(() => setCopiedAll(false), 1000);
  }, [displaySqlStatements]);

  const toggleExpanded = useCallback((index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  // Diffs grouped by table, so the table name shows once.
  const diffsByTable = useMemo(() => {
    const groups = new Map<string, typeof rowDiffs>();
    for (const diff of rowDiffs) {
      const list = groups.get(diff.table) ?? [];
      list.push(diff);
      groups.set(diff.table, list);
    }
    return [...groups.entries()];
  }, [rowDiffs]);

  const totalChanges =
    summary.inserts +
    summary.updates +
    summary.deletes +
    summary.structureChanges +
    summary.constraintChanges +
    (newTableSql?.length ?? 0) +
    objectSummary.insertFunctions +
    objectSummary.insertProcedures +
    objectSummary.insertTriggers +
    objectSummary.updateFunctions +
    objectSummary.updateProcedures +
    objectSummary.updateTriggers;
  const confirmLabel =
    totalChanges > 0
      ? `Save ${totalChanges} ${totalChanges === 1 ? "change" : "changes"}`
      : "Save changes";

  const onCopyStatement = useCallback(async (sql: string, index: number) => {
    setCopiedIndex(index);
    await navigator.clipboard.writeText(sql);
    setTimeout(() => {
      setCopiedIndex((current) => (current === index ? null : current));
    }, 1000);
  }, []);

  // Everything was written but a later step (refresh, reopening a table)
  // failed: say so, rather than hide the dialog with its error.
  const writtenWithError = !hasChanges && !!saveError;
  if (!hasChanges && !saving && !saveError) {
    return null;
  }

  return (
    <Dialog
      size="lg"
      open={open}
      onClose={close}
      closeOnOutsideClick={false}
      className="flex max-h-[min(90vh,50rem)] flex-col overflow-hidden"
    >
      <DialogHeader className="shrink-0 border-b border-neutral-200">
        <DialogTitle className="flex items-center gap-2">
          Review changes before saving
        </DialogTitle>
        <DialogDescription>
          {targetLabel ? (
            <>
              Saving to <span class="font-medium">{targetLabel}</span>
            </>
          ) : (
            "Nothing is written until you confirm."
          )}
        </DialogDescription>
      </DialogHeader>

      <DialogContent className="min-h-0 flex-1 gap-2 overflow-hidden">
        <OverlayScrollArea
          className="h-full min-h-0"
          contentClassName="space-y-4"
        >
          {saveError ? (
            <div
              role="alert"
              class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            >
              <div class="font-medium">
                {writtenWithError
                  ? "Your changes were saved, but a later step failed."
                  : "Not everything was saved."}
              </div>
              <div class="mt-1 break-words">{saveError}</div>
              {writtenWithError ? null : (
                <div class="mt-1">
                  What is listed below is still unsaved; fix it and try again.
                </div>
              )}
            </div>
          ) : null}

          {destructiveParts.length > 0 ? (
            <div
              role="alert"
              class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            >
              <span class="font-medium">Cannot be undone:</span> this save{" "}
              {destructiveParts.join(", ")}.
            </div>
          ) : null}

          {conflictNotices.length > 0 ? (
            <div
              role="alert"
              class="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
            >
              <div class="font-medium">
                Changed in the database since you opened it:
              </div>
              <ul class="mt-1 list-disc pl-5">
                {conflictNotices.map((n) => (
                  <li key={n.key}>
                    {n.name} — saving replaces that newer definition.
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {skippedNotices.length > 0 ? (
            <div
              role="status"
              class="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-700"
            >
              <div class="font-medium">Not saved, kept as unsaved work:</div>
              <ul class="mt-1 list-disc pl-5">
                {skippedNotices.map((n) =>
                  n.kind === "skipped" ? (
                    <li key={n.key}>
                      {n.name} — {n.reason}.
                    </li>
                  ) : null
                )}
              </ul>
            </div>
          ) : null}

          {writtenWithError ? null : (
            <>
              {/* Summary Section */}
              <div class="w-full rounded-lg border border-neutral-200">
                <div class="rounded-t-lg border-b border-neutral-200 bg-neutral-50 px-4 py-2">
                  <h3 class="text-sm font-semibold text-neutral-900">
                    Summary
                  </h3>
                </div>
                <div class="grid grid-cols-1 gap-2 p-4 text-sm sm:grid-cols-2">
                  <SummaryItem
                    label="Add"
                    color="bg-green-50 text-green-700"
                    parts={insertSummaryParts}
                  />
                  <SummaryItem
                    label="Change"
                    color="bg-amber-100 text-amber-800"
                    parts={updateSummaryParts}
                  />
                  <SummaryItem
                    label="Delete"
                    color="bg-red-50 text-red-700"
                    parts={deleteSummaryParts}
                  />
                  <SummaryItem
                    label="Structure"
                    color="bg-blue-100 text-blue-800"
                    parts={structureSummaryParts}
                  />
                </div>
              </div>

              {rowDiffs.length > 0 && (
                <div class="w-full rounded-lg border border-neutral-200">
                  <div class="rounded-t-lg border-b border-neutral-200 bg-neutral-50 px-4 py-2">
                    <h3 class="text-sm font-semibold text-neutral-900">
                      Changed {rowEntityPlural} ({rowDiffs.length})
                    </h3>
                  </div>
                  <OverlayScrollArea
                    className="max-h-72 w-full"
                    contentClassName="space-y-4 p-4"
                  >
                    {diffsByTable.map(([table, diffs]) => (
                      <section key={table} class="space-y-2">
                        <h4 class="truncate font-mono text-xs font-semibold text-neutral-700">
                          {table}
                        </h4>
                        {diffs.map((diff, index) => (
                          <div
                            key={`${diff.action}:${diff.rowKey}:${index}`}
                            class="space-y-2 rounded-md border border-neutral-200 bg-white p-3"
                          >
                            <div class="flex items-center justify-between gap-2">
                              <p
                                class="min-w-0 truncate font-mono text-xs text-neutral-600"
                                title={diff.identity}
                              >
                                {diff.identity}
                              </p>
                              <span
                                class={cn(
                                  "rounded bg-neutral-100 px-2 py-0.5 text-xs font-semibold text-neutral-700 uppercase",
                                  diff.action === "insert" &&
                                    "bg-green-50 text-green-700",
                                  diff.action === "update" &&
                                    "bg-amber-50 text-amber-700",
                                  diff.action === "delete" &&
                                    "bg-red-50 text-red-700"
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
                                    <span
                                      class="truncate font-medium text-neutral-700"
                                      title={cell.column}
                                    >
                                      {cell.column}
                                    </span>
                                    <DiffValue
                                      value={cell.oldValue}
                                      tone="old"
                                    />
                                    <DiffValue
                                      value={cell.newValue}
                                      tone="new"
                                    />
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </section>
                    ))}
                  </OverlayScrollArea>
                </div>
              )}

              {/* SQL Statements Section */}
              <div class="mb-1 w-full rounded-lg border border-neutral-200">
                <div class="rounded-t-lg border-b border-neutral-200 bg-neutral-50 px-4 py-2">
                  <div class="flex items-center justify-between gap-2">
                    <h3 class="text-sm font-semibold text-neutral-900">
                      {isMongo
                        ? `Mongo operations to run (${allSqlStatements.length})`
                        : `SQL to run (${allSqlStatements.length})`}
                    </h3>
                    {allSqlStatements.length > 1 ? (
                      <Button
                        variant="ghost"
                        class="h-6 px-2 text-xs text-neutral-600"
                        onClick={() => void onCopyAll()}
                      >
                        {copiedAll ? "Copied" : "Copy all"}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <OverlayScrollArea
                  className="max-h-52 w-full"
                  contentClassName="p-4"
                >
                  {summary.sqlError ? (
                    <div
                      role="alert"
                      class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
                    >
                      These changes can't be saved: {summary.sqlError}
                    </div>
                  ) : onlyNotices ? (
                    <div class="text-sm text-neutral-600">
                      Nothing to run yet.
                    </div>
                  ) : allSqlStatements.length === 0 ? (
                    <div class="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                      {isMongo
                        ? "There are pending changes, but no Mongo operations were generated."
                        : "There are pending changes, but no SQL statements were generated. Review the diff before saving."}
                    </div>
                  ) : (
                    <div class="space-y-3">
                      {displaySqlStatements.map((sql, index) => {
                        const sqlType = classifySaveStatement(sql, engine);
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
                                    : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
                                } transition-opacity`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void onCopyStatement(sql, index);
                                }}
                                title={copied ? "Copied!" : "Copy statement"}
                                aria-label="Copy statement"
                              >
                                {copied ? (
                                  <CopyCheckIcon className="size-3.5 text-green-700" />
                                ) : (
                                  <CopyIcon className="size-3.5" />
                                )}
                              </Button>
                            </div>
                            <div
                              class={cn(
                                "pr-8 font-mono text-xs wrap-break-word",
                                !expanded.has(index) && "line-clamp-3"
                              )}
                            >
                              {highlightSql(sql)}
                            </div>
                            {sql.split("\n").length > 3 || sql.length > 240 ? (
                              <button
                                type="button"
                                class="mt-1 text-xs font-medium text-neutral-600 underline-offset-2 hover:underline"
                                aria-expanded={expanded.has(index)}
                                onClick={() => toggleExpanded(index)}
                              >
                                {expanded.has(index) ? "Show less" : "Show all"}
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </OverlayScrollArea>
              </div>
            </>
          )}
        </OverlayScrollArea>
      </DialogContent>

      <DialogFooter className="shrink-0">
        <Button
          variant="outline"
          onClick={close}
          disabled={saving}
          data-review-cancel
        >
          {writtenWithError ? "Close" : "Cancel"}
        </Button>
        <Button
          variant={destructive ? "destructive" : "default"}
          onClick={() => void confirm()}
          disabled={!canConfirm}
          aria-busy={saving}
          data-review-confirm
          title={destructive ? undefined : formatShortcutLabel("Mod+Enter")}
        >
          {saving ? "Saving…" : confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
