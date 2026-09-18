import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
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
import { Spinner } from "src/components/common/Spinner";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import { createRetryableLazy } from "src/components/common/RetryableLazy";
import { useConnectionRuntimeCtx } from "./ConnectionRuntimeContext";
import { useConnectionWindows } from "./hooks/useConnectionWindows";
import { useLoadDbObjectDefinition } from "./hooks/useLoadDbObjectDefinition";
import type {
  DatabaseObjectKind,
  DatabaseObjectManagerWindow,
} from "src/types";
import {
  buildCreateDatabaseObjectTemplate,
  buildDropDatabaseObjectSql,
  buildSaveStatements,
  getDatabaseObjectCapability,
  objectKindLabel,
  objectKindSingular,
} from "src/lib/databaseObjects";
import { runSqlQuery } from "src/lib/tauri/query";
import { operationExecuteTransaction } from "src/lib/tauri";
import { showToast } from "src/stores/toast";

const loadSqlEditorPane = () =>
  import("src/components/editor/SqlEditorPane").then((module) => ({
    default: module.SqlEditorPane,
  }));

const SqlEditorPane = createRetryableLazy(loadSqlEditorPane, {
  label: "SQL editor",
  renderFallback: () => (
    <div class="flex h-full items-center justify-center">
      <Spinner className="text-blue-600" />
    </div>
  ),
});

type ConfirmIntent =
  | { kind: "save"; statements: string[] }
  | { kind: "delete"; statements: string[] };

type DraftState = {
  schema: string;
  name: string;
  tableName: string;
};

export function DbObjectsManagerPane(props: {
  win: DatabaseObjectManagerWindow;
}) {
  const { win } = props;
  const rt = useConnectionRuntimeCtx();
  const { openDatabaseObjectsManager } = useConnectionWindows(rt.profileId);
  const [kind, setKind] = useState<DatabaseObjectKind>(
    win.initialKind ?? "function"
  );
  const [schemaFilter, setSchemaFilter] = useState(rt.activeSchema || "public");
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(
    win.initialObjectId ?? null
  );
  const [isCreateMode, setIsCreateMode] = useState(!win.initialObjectId);
  const [draft, setDraft] = useState<DraftState>({
    schema: rt.activeSchema || "public",
    name: "",
    tableName: "",
  });
  const [running, setRunning] = useState(false);
  const [confirmIntent, setConfirmIntent] = useState<ConfirmIntent | null>(
    null
  );
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
    const objectId = win.initialObjectId?.trim() || "";
    if (objectId) {
      setSelectedObjectId(objectId);
      setIsCreateMode(false);
      return;
    }
    setSelectedObjectId(null);
    setIsCreateMode(true);
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

  const selectedObject = useMemo(() => {
    if (!selectedObjectId) return null;
    return allObjects.find((item) => item.id === selectedObjectId) ?? null;
  }, [allObjects, selectedObjectId]);

  useEffect(() => {
    if (!selectedObject) return;
    setKind(selectedObject.kind);
    setSchemaFilter(selectedObject.schema);
  }, [selectedObject]);

  const {
    sql: editorSql,
    setSql: setEditorSql,
    loading: loadingDefinition,
    loadError,
  } = useLoadDbObjectDefinition({
    selectedObject,
    isCreateMode,
    engine: rt.engine,
    connectionId: rt.runtimeConnectionId,
  });

  useEffect(() => {
    if (!loadError) return;
    showToast(loadError, { tone: "error" });
  }, [loadError]);

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
    await rt.refreshSchemaAndTables();
  };

  const startCreateMode = useCallback(
    (nextKind?: DatabaseObjectKind) => {
      const createKind = nextKind ?? kind;
      if (nextKind && nextKind !== kind) {
        setKind(nextKind);
      }
      setIsCreateMode(true);
      setSelectedObjectId(null);
      const schema = schemaFilter || rt.activeSchema || "public";
      const name =
        createKind === "trigger" ? "new_trigger" : `new_${createKind}`;
      const tableName =
        meta.tables?.find((table) => table.schema === schema)?.name ?? "";
      setDraft({ schema, name, tableName });
      setEditorSql(
        buildCreateDatabaseObjectTemplate({
          engine: rt.engine,
          kind: createKind,
          schema,
          name,
          tableName,
        })
      );
    },
    [schemaFilter, rt.activeSchema, rt.engine, kind, meta.tables, setEditorSql]
  );

  const createSeedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const objectId = win.initialObjectId?.trim() || "";
    if (objectId) {
      createSeedKeyRef.current = null;
      return;
    }
    const key = `${win.id}:${win.initialKind ?? "function"}:create`;
    if (createSeedKeyRef.current === key) return;
    createSeedKeyRef.current = key;
    startCreateMode(win.initialKind ?? "function");
  }, [win.id, win.initialObjectId, win.initialKind, startCreateMode]);

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

  const changeCreateKind = (nextKind: DatabaseObjectKind) => {
    if (nextKind === kind) return;
    const schema = draft.schema || schemaFilter || rt.activeSchema || "public";
    const defaultNames = {
      function: "new_function",
      procedure: "new_procedure",
      trigger: "new_trigger",
    } as const;
    const prevDefault =
      kind === "trigger" ? "new_trigger" : (`new_${kind}` as const);
    const nextName =
      !draft.name || draft.name === prevDefault
        ? defaultNames[nextKind]
        : draft.name;
    const nextTable =
      nextKind === "trigger"
        ? draft.tableName ||
          meta.tables?.find((table) => table.schema === schema)?.name ||
          ""
        : "";
    setKind(nextKind);
    setDraft((prev) => ({
      ...prev,
      schema,
      name: nextName,
      tableName: nextTable,
    }));
    setEditorSql(
      buildCreateDatabaseObjectTemplate({
        engine: rt.engine,
        kind: nextKind,
        schema,
        name: nextName,
        tableName: nextTable,
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
      showToast("SQL definition is empty.", { tone: "error" });
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

      await refreshObjects();

      if (wasDelete) {
        const deletedKind = createdTarget?.kind ?? kind;
        showToast("Object deleted.", { tone: "success" });
        // Enter create immediately, then sync window (clears initialObjectId).
        startCreateMode(deletedKind);
        createSeedKeyRef.current = `${win.id}:${deletedKind}:create`;
        openDatabaseObjectsManager({ kind: deletedKind });
      } else {
        if (createdTarget) {
          pendingSelectionRef.current = createdTarget;
        }
        setIsCreateMode(false);
        showToast("Object saved.", { tone: "success" });
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err ?? ""), {
        tone: "error",
      });
    } finally {
      setConfirmIntent(null);
      setRunning(false);
    }
  };

  const toolbar = (
    <div class="flex h-10 min-w-0 items-center gap-2 overflow-x-auto border-y border-neutral-200 bg-neutral-50 px-3">
      <Button
        variant="ghost"
        className="px-2 py-0.5 text-sm"
        onClick={() => void refreshObjects()}
        disabled={running}
      >
        Refresh
      </Button>
      {isCreateMode ? (
        <Button
          variant="ghost"
          className="px-2 py-0.5 text-sm"
          onClick={regenerateTemplate}
          disabled={running}
        >
          Regenerate
        </Button>
      ) : null}
      <div class="ml-auto flex items-center gap-2">
        <Button
          variant="destructive"
          className="px-4 py-0.5 text-sm"
          onClick={openDeletePreview}
          disabled={
            !selectedObject?.capability.canDelete || isCreateMode || running
          }
        >
          Delete
        </Button>
        <Button
          variant="default"
          className="px-4 py-0.5 text-sm"
          onClick={openSavePreview}
          disabled={
            running ||
            loadingDefinition ||
            (!isCreateMode && !selectedObject?.capability.canEdit) ||
            (isCreateMode && !kindCapability.canCreate)
          }
        >
          {loadingDefinition ? (
            <div class="flex items-center gap-2">
              <Spinner className="size-3.5 text-white" />
              Loading
            </div>
          ) : (
            <>Save</>
          )}
        </Button>
      </div>
    </div>
  );

  const unsupportedText =
    selectedObject?.capability.reason || kindCapability.reason;

  return (
    <div class="flex h-full min-h-0 w-full min-w-0 overflow-hidden border-t border-neutral-200 bg-neutral-100">
      <div class="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-white">
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
                    : "Open an object from the Objects sidebar or catalog to inspect or edit it."}
              </div>
            </div>
          </div>
        </div>

        {isCreateMode ? (
          <div class="border-b border-neutral-200 bg-neutral-50 px-4 py-3">
            <div class="flex min-w-0 flex-1 flex-wrap gap-3">
              <div class="min-w-0 flex-1 basis-40 space-y-1">
                <div class="text-sm font-medium text-neutral-500">Schema</div>
                <Select
                  value={draft.schema}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      schema: (e.currentTarget as HTMLSelectElement).value,
                    }))
                  }
                  className="h-8 w-full min-w-0 border-neutral-200"
                >
                  {availableSchemas.map((schema) => (
                    <option key={schema} value={schema}>
                      {schema}
                    </option>
                  ))}
                </Select>
              </div>
              <div class="min-w-0 flex-1 basis-40 space-y-1">
                <div class="text-sm font-medium text-neutral-500">Name</div>
                <Input
                  value={draft.name}
                  className="w-full min-w-0 border border-neutral-200 bg-white py-1.25 text-sm"
                  onValueChange={(value) =>
                    setDraft((prev) => ({ ...prev, name: value }))
                  }
                />
              </div>
              <div class="min-w-0 flex-1 basis-40 space-y-1">
                <div class="text-sm font-medium text-neutral-500">
                  Object type
                </div>
                <Select
                  value={kind}
                  onChange={(e) =>
                    changeCreateKind(
                      (e.currentTarget as HTMLSelectElement)
                        .value as DatabaseObjectKind
                    )
                  }
                  className="h-8 w-full min-w-0 border-neutral-200"
                >
                  {(
                    ["function", "procedure", "trigger"] as DatabaseObjectKind[]
                  ).map((value) => (
                    <option key={value} value={value}>
                      {objectKindLabel(value)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </div>
        ) : null}

        {toolbar}

        {!rt.runtimeConnectionId ? (
          <div class="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
            Connect to a profile to manage database objects.
          </div>
        ) : null}
        {!isCreateMode && !selectedObject ? (
          <div class="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-sm text-neutral-500">
            Open a {objectKindSingular(kind)} from the Objects sidebar or
            catalog to inspect or edit it.
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

        <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
          <SqlEditorPane
            key={editorStorageId}
            win={{
              id: `${win.id}-editor`,
              type: "sql",
              title: win.title,
              content: editorSql,
            }}
            storageId={editorStorageId}
            controlledContent
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
          <OverlayScrollArea
            className="max-h-90 rounded-md border border-neutral-200 bg-neutral-50"
            contentClassName="p-3 font-mono text-xs whitespace-pre-wrap text-neutral-900"
            horizontal
            vertical
          >
            {(confirmIntent?.statements ?? []).join("\n\n")}
          </OverlayScrollArea>
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
