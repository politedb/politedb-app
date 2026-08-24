import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Input } from "src/components/common/Input";
import { Select } from "src/components/common/Select";
import { SqlEditorPane } from "src/components/editor/SqlEditorPane";
import {
  SearchIcon,
  SquareFunctionIcon,
  TableIcon,
} from "src/components/icons";
import { Spinner } from "src/components/common/Spinner";
import { useConnectionRuntimeCtx } from "./ConnectionRuntimeContext";
import type {
  DatabaseObjectItem,
  DatabaseObjectKind,
  DatabaseObjectManagerWindow,
} from "src/types";
import { cn } from "src/utils/cn";
import {
  buildCreateDatabaseObjectTemplate,
  buildDropDatabaseObjectSql,
  buildSaveStatements,
  getDatabaseObjectCapability,
  loadDatabaseObjectDefinition,
  objectKindLabel,
  objectKindSingular,
} from "src/lib/databaseObjects";
import { runSqlQuery } from "src/lib/tauri/query";
import { operationExecuteTransaction } from "src/lib/tauri";

type ConfirmIntent =
  | { kind: "save"; statements: string[] }
  | { kind: "delete"; statements: string[] };

type DraftState = {
  schema: string;
  name: string;
  tableName: string;
};

function ObjectKindTab(props: {
  kind: DatabaseObjectKind;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={props.onClick}
      disabled={props.disabled}
      className={cn(
        "rounded-md border-none px-2 py-1 text-xs font-semibold",
        props.active
          ? "bg-blue-600 text-white hover:bg-blue-600"
          : "text-neutral-600 hover:bg-neutral-100"
      )}
    >
      {objectKindLabel(props.kind)}
    </Button>
  );
}

function ObjectListItem(props: {
  item: DatabaseObjectItem;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={cn(
        "flex w-full items-start gap-2 rounded-md border px-2 py-2 text-left transition-colors",
        props.active
          ? "border-blue-200 bg-blue-50"
          : "border-transparent bg-white hover:border-neutral-200 hover:bg-neutral-50"
      )}
    >
      {props.item.kind === "trigger" ? (
        <TableIcon className="mt-0.5 size-4 shrink-0 text-blue-500" />
      ) : (
        <SquareFunctionIcon className="mt-0.5 size-4 shrink-0 text-blue-500" />
      )}
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold text-neutral-900">
          {props.item.name}
        </div>
        <div class="truncate text-[11px] text-neutral-500">
          {props.item.kind === "trigger"
            ? `${props.item.schema}.${props.item.tableName ?? ""}`
            : `${props.item.schema}${props.item.signature ? `(${props.item.signature})` : ""}`}
        </div>
      </div>
    </button>
  );
}

export function DatabaseObjectsManagerPane(props: {
  win: DatabaseObjectManagerWindow;
}) {
  const { win } = props;
  const rt = useConnectionRuntimeCtx();
  const [kind, setKind] = useState<DatabaseObjectKind>(
    win.initialKind ?? "function"
  );
  const [search, setSearch] = useState("");
  const [schemaFilter, setSchemaFilter] = useState(rt.activeSchema || "public");
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(
    win.initialObjectId ?? null
  );
  const [isCreateMode, setIsCreateMode] = useState(false);
  const [draft, setDraft] = useState<DraftState>({
    schema: rt.activeSchema || "public",
    name: "",
    tableName: "",
  });
  const [editorSql, setEditorSql] = useState("");
  const [loadingDefinition, setLoadingDefinition] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [confirmIntent, setConfirmIntent] = useState<ConfirmIntent | null>(
    null
  );
  const requestSeqRef = useRef(0);
  const pendingSelectionRef = useRef<{
    kind: DatabaseObjectKind;
    schema: string;
    name: string;
  } | null>(null);

  const meta = useMemo(
    () =>
      rt.metadata.get({
        metaKey: rt.metaKey,
        engine: rt.engine,
        connectionId: rt.runtimeConnectionId,
        includeColumns: true,
        lazy: true,
      }),
    [rt]
  );

  const allObjects = useMemo(() => meta.objects ?? [], [meta.objects]);
  const availableSchemas = useMemo(() => meta.schemas ?? [], [meta.schemas]);
  const kindCapability = getDatabaseObjectCapability(rt.engine, kind);

  useEffect(() => {
    setKind(win.initialKind ?? "function");
  }, [win.initialKind]);

  useEffect(() => {
    if (!availableSchemas.length) return;
    if (schemaFilter && availableSchemas.includes(schemaFilter)) return;
    setSchemaFilter(rt.activeSchema || availableSchemas[0] || "public");
  }, [availableSchemas, schemaFilter, rt.activeSchema]);

  useEffect(() => {
    if (!win.initialObjectId) return;
    setSelectedObjectId(win.initialObjectId);
    setIsCreateMode(false);
  }, [win.initialObjectId]);

  useEffect(() => {
    if (!pendingSelectionRef.current) return;
    const match = allObjects.find(
      (item) =>
        item.kind === pendingSelectionRef.current?.kind &&
        item.schema === pendingSelectionRef.current?.schema &&
        item.name === pendingSelectionRef.current?.name
    );
    if (!match) return;
    setKind(match.kind);
    setSchemaFilter(match.schema);
    setSelectedObjectId(match.id);
    setIsCreateMode(false);
    pendingSelectionRef.current = null;
  }, [allObjects]);

  const filteredObjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allObjects
      .filter((item) => item.kind === kind)
      .filter((item) => (schemaFilter ? item.schema === schemaFilter : true))
      .filter((item) => {
        if (!q) return true;
        return (
          item.name.toLowerCase().includes(q) ||
          item.schema.toLowerCase().includes(q) ||
          (item.signature ?? "").toLowerCase().includes(q) ||
          (item.tableName ?? "").toLowerCase().includes(q)
        );
      });
  }, [allObjects, kind, schemaFilter, search]);

  const selectedObject = useMemo(() => {
    if (!selectedObjectId) return null;
    return allObjects.find((item) => item.id === selectedObjectId) ?? null;
  }, [allObjects, selectedObjectId]);

  const editorStorageId = useMemo(() => {
    if (selectedObject) {
      return `db-object:${rt.profileId}:${selectedObject.id}`;
    }
    return `db-object:${rt.profileId}:new:${kind}:${draft.schema}:${draft.name}:${draft.tableName}`;
  }, [
    selectedObject,
    rt.profileId,
    kind,
    draft.schema,
    draft.name,
    draft.tableName,
  ]);

  const refreshObjects = async () => {
    setError(null);
    setInfo(null);
    await rt.refreshSchemaAndTables();
  };

  const loadSelectedObjectDefinition = async (item: DatabaseObjectItem) => {
    if (!rt.runtimeConnectionId || !item.capability.canReadDefinition) return;
    const seq = ++requestSeqRef.current;
    setLoadingDefinition(true);
    setError(null);
    setInfo(null);
    try {
      const result = await loadDatabaseObjectDefinition({
        engine: rt.engine,
        connectionId: rt.runtimeConnectionId,
        item,
      });
      if (requestSeqRef.current !== seq) return;
      setEditorSql(result.sql);
    } catch (err) {
      if (requestSeqRef.current !== seq) return;
      setEditorSql("");
      setError(err instanceof Error ? err.message : String(err ?? ""));
    } finally {
      if (requestSeqRef.current === seq) {
        setLoadingDefinition(false);
      }
    }
  };

  useEffect(() => {
    if (isCreateMode || !selectedObject) return;
    void loadSelectedObjectDefinition(selectedObject);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedObject?.id, isCreateMode, loadSelectedObjectDefinition]);

  const startCreateMode = () => {
    setError(null);
    setInfo(null);
    setIsCreateMode(true);
    setSelectedObjectId(null);
    setDraft({
      schema: schemaFilter || rt.activeSchema || "public",
      name: kind === "trigger" ? "new_trigger" : `new_${kind}`,
      tableName:
        meta.tables?.find(
          (table) => table.schema === (schemaFilter || rt.activeSchema)
        )?.name ?? "",
    });
    setEditorSql(
      buildCreateDatabaseObjectTemplate({
        engine: rt.engine,
        kind,
        schema: schemaFilter || rt.activeSchema || "public",
        name: kind === "trigger" ? "new_trigger" : `new_${kind}`,
        tableName:
          meta.tables?.find(
            (table) => table.schema === (schemaFilter || rt.activeSchema)
          )?.name ?? "",
      })
    );
  };

  const regenerateTemplate = () => {
    setEditorSql(
      buildCreateDatabaseObjectTemplate({
        engine: rt.engine,
        kind,
        schema: draft.schema || schemaFilter || rt.activeSchema || "public",
        name: draft.name || `new_${kind}`,
        tableName: draft.tableName,
      })
    );
  };

  const openSavePreview = () => {
    const statements = buildSaveStatements({
      engine: rt.engine,
      item: isCreateMode ? null : selectedObject,
      sql: editorSql,
    });
    if (statements.length === 0) {
      setError("SQL definition is empty.");
      return;
    }
    setConfirmIntent({ kind: "save", statements });
  };

  const openDeletePreview = () => {
    if (!selectedObject) return;
    setConfirmIntent({
      kind: "delete",
      statements: [
        buildDropDatabaseObjectSql({
          engine: rt.engine,
          item: selectedObject,
        }),
      ],
    });
  };

  const executeStatements = async (statements: string[]) => {
    if (!rt.runtimeConnectionId) {
      throw new Error("Connect to a profile first.");
    }

    if (statements.length === 1) {
      await runSqlQuery(rt.runtimeConnectionId, statements[0]!);
      return;
    }

    await operationExecuteTransaction({
      connectionId: rt.runtimeConnectionId,
      statements,
    });
  };

  const confirmAction = async () => {
    if (!confirmIntent) return;
    setRunning(true);
    setError(null);
    setInfo(null);
    try {
      await executeStatements(confirmIntent.statements);
      const wasDelete = confirmIntent.kind === "delete";
      const createdTarget = isCreateMode
        ? {
            kind,
            schema: draft.schema,
            name: draft.name,
          }
        : selectedObject
          ? {
              kind: selectedObject.kind,
              schema: selectedObject.schema,
              name: selectedObject.name,
            }
          : null;

      setConfirmIntent(null);
      await refreshObjects();

      if (wasDelete) {
        setSelectedObjectId(null);
        setEditorSql("");
        setInfo("Object deleted.");
      } else {
        if (createdTarget) {
          pendingSelectionRef.current = createdTarget;
        }
        setIsCreateMode(false);
        setInfo("Object saved.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err ?? ""));
    } finally {
      setRunning(false);
    }
  };

  const toolbar = (
    <div class="flex h-10 items-center gap-2 border-y border-neutral-200 bg-neutral-50 px-3">
      <Button
        variant="ghost"
        className="px-2 py-1 text-xs"
        onClick={startCreateMode}
        disabled={!kindCapability.canCreate || running}
      >
        Create
      </Button>
      <Button
        variant="ghost"
        className="px-2 py-1 text-xs"
        onClick={() => void refreshObjects()}
        disabled={running}
      >
        Refresh
      </Button>
      {isCreateMode ? (
        <Button
          variant="ghost"
          className="px-2 py-1 text-xs"
          onClick={regenerateTemplate}
          disabled={running}
        >
          Regenerate
        </Button>
      ) : null}
      <div class="ml-auto flex items-center gap-2">
        <Button
          variant="destructive"
          className="px-2 py-1 text-xs"
          onClick={openDeletePreview}
          disabled={
            !selectedObject?.capability.canDelete || isCreateMode || running
          }
        >
          Delete
        </Button>
        <Button
          variant="default"
          className="px-2 py-1 text-xs"
          onClick={openSavePreview}
          disabled={
            running ||
            (!isCreateMode && !selectedObject?.capability.canEdit) ||
            (isCreateMode && !kindCapability.canCreate)
          }
        >
          Save
        </Button>
      </div>
    </div>
  );

  const unsupportedText =
    selectedObject?.capability.reason || kindCapability.reason;

  return (
    <div class="flex h-full min-h-0 border-t border-neutral-200 bg-neutral-100">
      <div class="flex w-80 min-w-72 flex-col border-r border-neutral-200 bg-neutral-100">
        <div class="border-b border-neutral-200 px-3 py-3">
          <div class="mb-2 flex items-center gap-1">
            {(["function", "procedure", "trigger"] as DatabaseObjectKind[]).map(
              (value) => (
                <ObjectKindTab
                  key={value}
                  kind={value}
                  active={kind === value}
                  onClick={() => {
                    setKind(value);
                    setSelectedObjectId(null);
                    setIsCreateMode(false);
                    setError(null);
                    setInfo(null);
                  }}
                />
              )
            )}
          </div>
          <div class="space-y-2">
            <Input
              value={search}
              placeholder={`Search ${objectKindLabel(kind).toLowerCase()}...`}
              className="border border-neutral-200 bg-white py-1.5 text-xs"
              left={<SearchIcon className="size-3.5 text-neutral-500" />}
              onValueChange={setSearch}
            />
            <Select
              value={schemaFilter}
              onChange={(e) =>
                setSchemaFilter((e.currentTarget as HTMLSelectElement).value)
              }
              className="h-6.5 rounded-md border-neutral-200 px-2 text-xs!"
            >
              {availableSchemas.map((schema) => (
                <option key={schema} value={schema}>
                  {schema}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div class="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {!kindCapability.canList ? (
            <div class="rounded-md border border-dashed border-neutral-300 bg-white px-3 py-4 text-sm text-neutral-500">
              {unsupportedText}
            </div>
          ) : filteredObjects.length === 0 ? (
            <div class="rounded-md border border-dashed border-neutral-300 bg-white px-3 py-4 text-sm text-neutral-500">
              No {objectKindLabel(kind).toLowerCase()} found.
            </div>
          ) : (
            filteredObjects.map((item) => (
              <ObjectListItem
                key={item.id}
                item={item}
                active={selectedObjectId === item.id && !isCreateMode}
                onClick={() => {
                  setSelectedObjectId(item.id);
                  setIsCreateMode(false);
                  setError(null);
                  setInfo(null);
                }}
              />
            ))
          )}
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col bg-white">
        <div class="border-b border-neutral-200 px-4 py-3">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="text-base font-semibold text-neutral-900">
                {isCreateMode
                  ? `New ${objectKindSingular(kind)}`
                  : selectedObject
                    ? selectedObject.name
                    : "Database Objects"}
              </div>
              <div class="mt-1 text-sm text-neutral-500">
                {isCreateMode
                  ? "Seed a DDL template, review it, then confirm before applying."
                  : selectedObject
                    ? `${selectedObject.schema}${selectedObject.tableName ? ` · ${selectedObject.tableName}` : ""}${selectedObject.signature ? `(${selectedObject.signature})` : ""}`
                    : "Browse functions, procedures, and triggers, then edit their DDL directly."}
              </div>
            </div>
            {loadingDefinition ? (
              <div class="flex items-center gap-2 text-sm text-neutral-500">
                <Spinner className="size-4 text-neutral-500" />
                Loading definition...
              </div>
            ) : null}
          </div>
        </div>

        {isCreateMode ? (
          <div class="grid grid-cols-3 gap-3 border-b border-neutral-200 bg-neutral-50 px-4 py-3">
            <div class="space-y-1">
              <div class="text-xs font-medium text-neutral-500">Schema</div>
              <Select
                value={draft.schema}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    schema: (e.currentTarget as HTMLSelectElement).value,
                  }))
                }
                className="h-6.5 rounded-md! border-neutral-200 px-2 text-xs!"
              >
                {availableSchemas.map((schema) => (
                  <option key={schema} value={schema}>
                    {schema}
                  </option>
                ))}
              </Select>
            </div>
            <div class="space-y-1">
              <div class="text-xs font-medium text-neutral-500">Name</div>
              <Input
                value={draft.name}
                className="border border-neutral-200 bg-white py-1.5 text-xs"
                onValueChange={(value) =>
                  setDraft((prev) => ({ ...prev, name: value }))
                }
              />
            </div>
            <div class="space-y-1">
              <div class="text-xs font-medium text-neutral-500">
                {kind === "trigger" ? "Target table" : "Object type"}
              </div>
              {kind === "trigger" ? (
                <Select
                  value={draft.tableName}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      tableName: (e.currentTarget as HTMLSelectElement).value,
                    }))
                  }
                  className="h-8 rounded-md px-2 text-xs"
                >
                  <option value="">Select table</option>
                  {(meta.tables ?? [])
                    .filter((table) => table.schema === draft.schema)
                    .map((table) => (
                      <option
                        key={`${table.schema}.${table.name}`}
                        value={table.name}
                      >
                        {table.name}
                      </option>
                    ))}
                </Select>
              ) : (
                <div class="flex h-8 items-center rounded-md border border-neutral-200 bg-white px-2 text-xs font-medium text-neutral-600">
                  {objectKindLabel(kind)}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {toolbar}

        {error ? (
          <div class="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}
        {info ? (
          <div class="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
            {info}
          </div>
        ) : null}
        {!rt.runtimeConnectionId ? (
          <div class="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
            Connect to a profile to manage database objects.
          </div>
        ) : null}
        {!isCreateMode && !selectedObject && kindCapability.canList ? (
          <div class="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-sm text-neutral-500">
            Select a {objectKindSingular(kind)} to inspect or edit it.
          </div>
        ) : null}
        {(isCreateMode || selectedObject) &&
        unsupportedText &&
        !kindCapability.canReadDefinition &&
        !isCreateMode ? (
          <div class="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
            {unsupportedText}
          </div>
        ) : null}

        <div class="min-h-0 flex-1">
          <SqlEditorPane
            key={editorStorageId}
            win={{
              id: `${win.id}-editor`,
              type: "sql",
              title: win.title,
              content: editorSql,
            }}
            storageId={editorStorageId}
            onCommitContent={(_, next) => setEditorSql(next)}
            onRunSql={undefined}
            onExplainSql={undefined}
            onCancelSql={undefined}
            isExecuting={running}
            schemas={meta.schemas ?? []}
            activeSchema={schemaFilter}
            tables={meta.tables ?? []}
            columnsByTable={meta.columnsByTable}
            engine={rt.engine}
            toolbar={null}
          />
        </div>
      </div>

      <Dialog
        open={!!confirmIntent}
        onClose={() => (running ? null : setConfirmIntent(null))}
        size="lg"
      >
        <DialogHeader>
          <DialogTitle>
            {confirmIntent?.kind === "delete"
              ? "Delete object"
              : "Apply object SQL"}
          </DialogTitle>
          <DialogDescription>
            Review the SQL below. Nothing is executed until you confirm.
          </DialogDescription>
        </DialogHeader>
        <DialogContent className="pt-0">
          <pre class="max-h-90 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs whitespace-pre-wrap text-neutral-900">
            {(confirmIntent?.statements ?? []).join("\n\n")}
          </pre>
        </DialogContent>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setConfirmIntent(null)}
            disabled={running}
          >
            Cancel
          </Button>
          <Button
            variant={
              confirmIntent?.kind === "delete" ? "destructive" : "default"
            }
            onClick={() => void confirmAction()}
            loading={running}
          >
            {confirmIntent?.kind === "delete" ? "Delete" : "Confirm & Apply"}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
