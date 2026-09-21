import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { Button } from "src/components/common/Button";
import { Input } from "src/components/common/Input";
import { Select } from "src/components/common/Select";
import { Spinner } from "src/components/common/Spinner";
import { createRetryableLazy } from "src/components/common/RetryableLazy";
import { useConnectionRuntimeCtx } from "./ConnectionRuntimeContext";
import { useScreenStore } from "src/stores/screen";
import { useLoadDbObjectDefinition } from "./hooks/useLoadDbObjectDefinition";
import type {
  DatabaseObjectKind,
  DatabaseObjectManagerWindow,
} from "src/types";
import {
  buildCreateDatabaseObjectTemplate,
  buildSaveStatements,
  nextUniqueObjectDraftName,
  getDatabaseObjectCapability,
  objectKindLabel,
  objectKindSingular,
} from "src/lib/databaseObjects";
import {
  consumeObjectEditorReset,
  hasObjectEditorReset,
  objectCreateDraftCache,
  objectEditDraftCache,
} from "src/lib/objectEditorDraftCache";
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
    // Only adopt kind from window when opening an existing object / external navigation.
    // During create, local Select owns kind — echoing win.initialKind remount-loops the editor.
    if (!(win.initialObjectId ?? "").trim() && isCreateMode) return;
    const next = win.initialKind ?? "function";
    setKind((prev) => (prev === next ? prev : next));
  }, [win.initialKind, win.initialObjectId, isCreateMode]);

  useEffect(() => {
    if (!availableSchemas.length) return;
    if (schemaFilter && availableSchemas.includes(schemaFilter)) return;
    setSchemaFilter(rt.activeSchema || availableSchemas[0] || "public");
  }, [availableSchemas, schemaFilter, rt.activeSchema]);

  useEffect(() => {
    const objectId = win.initialObjectId?.trim() || "";
    if (objectId) {
      setSelectedObjectId((prev) => (prev === objectId ? prev : objectId));
      setIsCreateMode(false);
      return;
    }
    setSelectedObjectId((prev) => (prev === null ? prev : null));
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
    baselineSql,
    setBaselineSql,
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

  // Stable for the life of the window — do NOT include kind/name (remounts Monaco → reload loop).
  const editorStorageId = `db-object:${win.id}`;

  const refreshObjects = useCallback(async () => {
    await rt.refreshSchemaAndTables();
  }, [rt]);

  const collectTakenDraftNames = useCallback(
    (excludeWindowId?: string) => {
      const taken = (meta.objects ?? []).map((item) => item.name);
      const windows = useScreenStore.getState().openWindows[rt.profileId] ?? [];
      for (const w of windows) {
        if (w.type !== "db-object-manager") continue;
        if (excludeWindowId && w.id === excludeWindowId) continue;
        if ((w.initialObjectId ?? "").trim()) continue;
        if (w.title?.trim()) taken.push(w.title.trim());
      }
      return taken;
    },
    [meta.objects, rt.profileId]
  );

  const winRef = useRef(win);
  winRef.current = win;

  const syncCreateWindowNav = useCallback(
    (next: { title: string; kind: DatabaseObjectKind }) => {
      const current = useScreenStore
        .getState()
        .openWindows[rt.profileId]?.find((w) => w.id === win.id);
      if (
        current?.type === "db-object-manager" &&
        current.title === next.title &&
        (current.initialKind ?? "function") === next.kind
      ) {
        return;
      }
      useScreenStore.getState().updateWindow(rt.profileId, win.id, {
        title: next.title,
        initialKind: next.kind,
      });
    },
    [rt.profileId, win.id]
  );

  const startCreateMode = useCallback(
    (nextKind?: DatabaseObjectKind) => {
      const current = winRef.current;
      const cached = objectCreateDraftCache.get(current.id);
      if (cached && !nextKind) {
        setKind(cached.kind);
        setIsCreateMode(true);
        setSelectedObjectId(null);
        setDraft(cached.draft);
        setEditorSql(cached.sql);
        syncCreateWindowNav({ title: cached.draft.name, kind: cached.kind });
        return;
      }
      const createKind = nextKind ?? kind;
      if (nextKind && nextKind !== kind) {
        setKind(nextKind);
      }
      setIsCreateMode(true);
      setSelectedObjectId(null);
      const schema = schemaFilter || rt.activeSchema || "public";
      const preferred =
        !nextKind || nextKind === (current.initialKind ?? "function")
          ? current.title?.trim() || ""
          : "";
      const taken = collectTakenDraftNames(current.id);
      const name =
        preferred &&
        !taken.some((n) => n.toLowerCase() === preferred.toLowerCase())
          ? preferred
          : nextUniqueObjectDraftName(createKind, taken);
      const tableName =
        meta.tables?.find((table) => table.schema === schema)?.name ?? "";
      const nextDraft = { schema, name, tableName };
      const sql = buildCreateDatabaseObjectTemplate({
        engine: rt.engine,
        kind: createKind,
        schema,
        name,
        tableName,
      });
      setDraft(nextDraft);
      setEditorSql(sql);
      objectCreateDraftCache.set(current.id, {
        draft: nextDraft,
        kind: createKind,
        sql,
      });
      syncCreateWindowNav({ title: name, kind: createKind });
    },
    [
      schemaFilter,
      rt.activeSchema,
      rt.engine,
      kind,
      meta.tables,
      setEditorSql,
      collectTakenDraftNames,
      syncCreateWindowNav,
    ]
  );

  // Seed create template once per window id — never re-seed on callback identity / title sync.
  const seededCreateWindowIdRef = useRef<string | null>(null);
  useEffect(() => {
    const objectId = win.initialObjectId?.trim() || "";
    if (objectId) {
      seededCreateWindowIdRef.current = null;
      return;
    }
    if (seededCreateWindowIdRef.current === win.id) return;
    seededCreateWindowIdRef.current = win.id;
    startCreateMode(win.initialKind ?? "function");
    // intentionally only win.id / create↔edit flips; startCreateMode read via latest closure once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.id, win.initialObjectId]);

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
    const prevDefault =
      kind === "trigger" ? "new_trigger" : (`new_${kind}` as const);
    const looksDefault =
      !draft.name ||
      draft.name === prevDefault ||
      draft.name.startsWith(`${prevDefault}_`);
    const taken = collectTakenDraftNames(win.id);
    const nextName = looksDefault
      ? nextUniqueObjectDraftName(nextKind, taken)
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
    syncCreateWindowNav({ title: nextName, kind: nextKind });
  };

  const getPendingObjectSql = useCallback(() => {
    if (loadingDefinition || running) return [] as string[];
    if (isCreateMode) {
      if (!kindCapability.canCreate) return [];
    } else {
      if (!selectedObject?.capability.canEdit) return [];
      if (editorSql.trim() === baselineSql.trim()) return [];
    }
    const statements = buildSaveStatements({
      engine: rt.engine,
      item: isCreateMode ? null : selectedObject,
      sql: editorSql,
    });
    return statements;
  }, [
    loadingDefinition,
    running,
    isCreateMode,
    kindCapability.canCreate,
    selectedObject,
    editorSql,
    baselineSql,
    rt.engine,
  ]);

  const executeStatements = useCallback(
    async (statements: string[]) => {
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
    },
    [rt.runtimeConnectionId]
  );

  const saveObjectChanges = useCallback(async () => {
    const statements = getPendingObjectSql();
    if (statements.length === 0) return;

    setRunning(true);
    try {
      await executeStatements(statements);
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

      if (createdTarget) {
        pendingSelectionRef.current = createdTarget;
      }
      setIsCreateMode(false);
      setBaselineSql(editorSql);
      objectCreateDraftCache.delete(win.id);
      if (!isCreateMode && selectedObject) {
        objectEditDraftCache.set(win.id, {
          item: selectedObject,
          sql: editorSql,
          baselineSql: editorSql,
        });
      } else {
        objectEditDraftCache.delete(win.id);
      }
      useScreenStore
        .getState()
        .updateWindow(rt.profileId, win.id, { dirty: false });
      showToast("Object saved.", { tone: "success" });
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err ?? ""), {
        tone: "error",
      });
      throw err;
    } finally {
      setRunning(false);
    }
  }, [
    getPendingObjectSql,
    executeStatements,
    isCreateMode,
    kind,
    draft.schema,
    draft.name,
    selectedObject,
    refreshObjects,
    setBaselineSql,
    editorSql,
    win.id,
    rt.profileId,
  ]);

  // Register with global Cmd/Ctrl+S → SaveChangesDialog flow (like tables).
  useEffect(() => {
    const handler = {
      getPendingSql: getPendingObjectSql,
      save: saveObjectChanges,
    };
    rt.objectSaveRef.current = handler;
    return () => {
      if (rt.objectSaveRef.current === handler) {
        rt.objectSaveRef.current = null;
      }
    };
  }, [rt.objectSaveRef, getPendingObjectSql, saveObjectChanges]);

  // LeftNav edit: amber when SQL differs from loaded definition.
  // Guard with win.initialObjectId (not only local isCreateMode) so a reused
  // component instance cannot stamp an existing object id onto a create draft.
  useEffect(() => {
    const winObjectId = (win.initialObjectId ?? "").trim();
    if (isCreateMode || !winObjectId) return;
    if (!selectedObject?.id) return;
    const title = selectedObject.name || "Database Objects";
    const dirty = !loadingDefinition && editorSql.trim() !== baselineSql.trim();
    useScreenStore.getState().updateWindow(rt.profileId, win.id, {
      title,
      initialKind: kind,
      initialObjectId: selectedObject.id,
      dirty,
    });
  }, [
    isCreateMode,
    kind,
    selectedObject?.id,
    selectedObject?.name,
    editorSql,
    baselineSql,
    loadingDefinition,
    win.id,
    win.initialObjectId,
    rt.profileId,
  ]);

  // Keep create draft cache in sync so switching to an existing object and back restores it.
  useEffect(() => {
    if (!isCreateMode) return;
    if ((win.initialObjectId ?? "").trim()) return;
    objectCreateDraftCache.set(win.id, { draft, kind, sql: editorSql });
    objectEditDraftCache.delete(win.id);
  }, [isCreateMode, win.id, win.initialObjectId, draft, kind, editorSql]);

  // Keep edit draft cache in sync so inactive dirty tabs still save via global Cmd/Ctrl+S.
  useEffect(() => {
    const winObjectId = (win.initialObjectId ?? "").trim();
    if (isCreateMode || !winObjectId || !selectedObject) {
      return;
    }
    // Discard sets baseline into the cache first; don't overwrite with stale editorSql.
    if (hasObjectEditorReset(win.id)) return;
    objectEditDraftCache.set(win.id, {
      item: selectedObject,
      sql: editorSql,
      baselineSql,
    });
  }, [
    isCreateMode,
    win.id,
    win.initialObjectId,
    selectedObject,
    editorSql,
    baselineSql,
  ]);

  // Drop create cache once the window is bound to a real object (e.g. after global save).
  useEffect(() => {
    const objectId = (win.initialObjectId ?? "").trim();
    if (!objectId) return;
    objectCreateDraftCache.delete(win.id);
  }, [win.id, win.initialObjectId]);

  // After save: bump baseline to current SQL. After discard: restore editor to baseline.
  const prevDirtyRef = useRef(!!win.dirty);
  useEffect(() => {
    const wasDirty = prevDirtyRef.current;
    prevDirtyRef.current = !!win.dirty;
    if (!wasDirty || win.dirty || isCreateMode) return;

    if (consumeObjectEditorReset(win.id)) {
      const cached = objectEditDraftCache.get(win.id);
      const sql = cached?.baselineSql ?? baselineSql;
      setEditorSql(sql);
      setBaselineSql(sql);
      return;
    }

    setBaselineSql(editorSql);
  }, [
    win.dirty,
    win.id,
    isCreateMode,
    editorSql,
    baselineSql,
    setBaselineSql,
    setEditorSql,
  ]);

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
                  ? "Seed a DDL template, then save with Cmd/Ctrl+S to review and apply."
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
                  onValueChange={(value) => {
                    setDraft((prev) => ({ ...prev, name: value }));
                    syncCreateWindowNav({
                      title: value.trim() || draft.name,
                      kind,
                    });
                  }}
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
            <div class="mt-3 flex items-center gap-2">
              <Button
                variant="ghost"
                className="px-2 py-0.5 text-sm"
                onClick={regenerateTemplate}
                disabled={running}
              >
                Regenerate
              </Button>
              <span class="text-xs text-neutral-500">Save with Cmd/Ctrl+S</span>
            </div>
          </div>
        ) : null}

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
            onCommitContent={(_, next) => {
              if (next !== editorSql) setEditorSql(next);
            }}
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
    </div>
  );
}
