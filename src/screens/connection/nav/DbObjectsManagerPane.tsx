import { useCallback, useEffect, useMemo } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { Input } from "src/components/common/Input";
import { Select } from "src/components/common/Select";
import { Spinner } from "src/components/common/Spinner";
import { createRetryableLazy } from "src/components/common/RetryableLazy";
import { useConnectionRuntimeCtx } from "../workspace/ConnectionRuntimeContext";
import { useScreenStore } from "src/stores/screen";
import { useLoadDbObjectDefinition } from "../hooks/useLoadDbObjectDefinition";
import type {
  DatabaseObjectKind,
  DatabaseObjectManagerWindow,
} from "src/types";
import {
  buildCreateDatabaseObjectTemplate,
  nextUniqueObjectDraftName,
  getDatabaseObjectCapability,
  objectKindLabel,
  objectKindSingular,
} from "src/lib/databaseObjects";
import { draftKeyForWindow, isCreateDraftKey } from "src/lib/objectDraftKey";
import {
  objectDraftsForTab,
  useObjectDraftStore,
} from "src/stores/objectDrafts";
import { newObjectDraftInit } from "../lib/objectWindows";
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

/**
 * One function/procedure/trigger window: a new object or an existing one.
 * Its SQL and fields live in the object draft store, so closing and
 * reopening the window (or switching tabs) keeps the unsaved work; saving
 * and discarding go through the connection's Save / Discard.
 */
export function DbObjectsManagerPane(props: {
  win: DatabaseObjectManagerWindow;
}) {
  const { win } = props;
  const rt = useConnectionRuntimeCtx();
  const tabId = rt.profileId;
  const draftKey = draftKeyForWindow(win);
  const isCreate = isCreateDraftKey(draftKey);
  const draft = useObjectDraftStore((s) => s.drafts[tabId]?.[draftKey]);
  const drafts = useObjectDraftStore.getState();

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

  const objectId = (win.initialObjectId ?? "").trim();
  const selectedObject = useMemo(() => {
    if (isCreate || !objectId) return null;
    return (
      allObjects.find((item) => item.id === objectId) ?? draft?.item ?? null
    );
  }, [isCreate, objectId, allObjects, draft?.item]);

  const kind: DatabaseObjectKind =
    draft?.kind ?? selectedObject?.kind ?? win.initialKind ?? "function";
  const kindCapability = getDatabaseObjectCapability(rt.engine, kind);

  const takenNames = useCallback(
    (excludeKey?: string) => [
      ...allObjects.map((item) => item.name),
      ...objectDraftsForTab(tabId)
        .filter((d) => d.mode === "create" && d.key !== excludeKey)
        .map((d) => d.form.name),
    ],
    [allObjects, tabId]
  );

  // A new-object window without a draft (opened without a template, or
  // restored from an earlier session): seed it once.
  useEffect(() => {
    if (!isCreate || draft) return;
    const init = newObjectDraftInit({
      tabId,
      engine: rt.engine,
      kind: win.initialKind ?? "function",
      schema: rt.activeSchema || availableSchemas[0] || "public",
      tables: meta.tables ?? [],
      existingNames: allObjects.map((item) => item.name),
    });
    const preferred = win.title?.trim();
    if (
      preferred &&
      !takenNames(draftKey).some(
        (name) => name.toLowerCase() === preferred.toLowerCase()
      )
    ) {
      init.form = { ...init.form, name: preferred };
      init.sql = buildCreateDatabaseObjectTemplate({
        engine: rt.engine,
        kind: init.kind,
        ...init.form,
      });
    }
    useObjectDraftStore.getState().ensureCreateDraft(tabId, draftKey, init);
    // Seed once per window; later metadata changes must not re-seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCreate, draft, tabId, draftKey]);

  // An existing object without a draft yet: start a clean one.
  useEffect(() => {
    if (isCreate || draft || !selectedObject) return;
    useObjectDraftStore
      .getState()
      .ensureEditDraft(tabId, draftKey, selectedObject);
  }, [isCreate, draft, selectedObject, tabId, draftKey]);

  const { loadError } = useLoadDbObjectDefinition({
    tabId,
    draftKey,
    item: isCreate ? null : selectedObject,
    engine: rt.engine,
    connectionId: rt.runtimeConnectionId,
    draftGeneration: draft?.mode === "edit" ? draft.generation : undefined,
  });

  useEffect(() => {
    if (!loadError) return;
    showToast(loadError, { tone: "error" });
  }, [loadError]);

  // The tab shows the object's (or new object's) current name.
  useEffect(() => {
    const title = isCreate ? draft?.form.name : selectedObject?.name;
    if (!title) return;
    const current = useScreenStore
      .getState()
      .openWindows[tabId]?.find((w) => w.id === win.id);
    if (
      current?.type === "db-object-manager" &&
      current.title === title &&
      (current.initialKind ?? "function") === kind
    ) {
      return;
    }
    useScreenStore
      .getState()
      .updateWindow(tabId, win.id, { title, initialKind: kind });
  }, [isCreate, draft?.form.name, selectedObject?.name, kind, tabId, win.id]);

  // One editor per screen tab and draft (the same object can be open in two
  // connection tabs); stable across kind/name changes.
  const editorStorageId = `db-object:${tabId}:${draftKey}`;
  const sql = draft?.sql ?? "";
  const savingCreate = isCreate && !!draft?.saving;
  const form = draft?.form ?? { schema: "", name: "", tableName: "" };

  const setCreateFields = (
    patch: Parameters<typeof drafts.setCreateFields>[2]
  ) => useObjectDraftStore.getState().setCreateFields(tabId, draftKey, patch);

  const regenerateTemplate = () =>
    setCreateFields({
      sql: buildCreateDatabaseObjectTemplate({
        engine: rt.engine,
        kind,
        schema: form.schema || rt.activeSchema || "public",
        name: form.name || `new_${kind}`,
        tableName: form.tableName,
      }),
    });

  const changeCreateKind = (nextKind: DatabaseObjectKind) => {
    if (nextKind === kind) return;
    const schema = form.schema || rt.activeSchema || "public";
    const prevDefault = `new_${kind}`;
    const looksDefault =
      !form.name ||
      form.name === prevDefault ||
      form.name.startsWith(`${prevDefault}_`);
    const name = looksDefault
      ? nextUniqueObjectDraftName(nextKind, takenNames(draftKey))
      : form.name;
    const tableName =
      nextKind === "trigger"
        ? form.tableName ||
          meta.tables?.find((table) => table.schema === schema)?.name ||
          ""
        : "";
    setCreateFields({
      kind: nextKind,
      form: { schema, name, tableName },
      sql: buildCreateDatabaseObjectTemplate({
        engine: rt.engine,
        kind: nextKind,
        schema,
        name,
        tableName,
      }),
    });
  };

  const unsupportedText =
    selectedObject?.capability.reason || kindCapability.reason;

  return (
    <div class="flex h-full min-h-0 w-full min-w-0 overflow-hidden border-t border-neutral-200 bg-neutral-100">
      <div class="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-white">
        <div class="border-b border-neutral-200 px-4 py-3">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="text-base font-semibold text-neutral-900">
                {isCreate
                  ? `New ${objectKindSingular(kind)}`
                  : selectedObject
                    ? selectedObject.name
                    : "Database Objects"}
              </div>
              <div class="mt-1 text-sm text-neutral-500">
                {isCreate
                  ? "Seed a DDL template, then save with Cmd/Ctrl+S to review and apply."
                  : selectedObject
                    ? `${selectedObject.schema}${selectedObject.tableName ? ` · ${selectedObject.tableName}` : ""}${selectedObject.signature ? `(${selectedObject.signature})` : ""}`
                    : "Open an object from the Objects sidebar or catalog to inspect or edit it."}
              </div>
            </div>
          </div>
        </div>

        {isCreate ? (
          <div class="border-b border-neutral-200 bg-neutral-50 px-4 py-3">
            <div class="flex min-w-0 flex-1 flex-wrap gap-3">
              <div class="min-w-0 flex-1 basis-40 space-y-1">
                <div class="text-sm font-medium text-neutral-500">Schema</div>
                <Select
                  value={form.schema}
                  disabled={savingCreate}
                  onChange={(e) =>
                    setCreateFields({
                      form: {
                        schema: (e.currentTarget as HTMLSelectElement).value,
                      },
                    })
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
                  value={form.name}
                  disabled={savingCreate}
                  className="w-full min-w-0 border border-neutral-200 bg-white py-1.25 text-sm"
                  onValueChange={(value) =>
                    setCreateFields({ form: { name: value } })
                  }
                />
              </div>
              <div class="min-w-0 flex-1 basis-40 space-y-1">
                <div class="text-sm font-medium text-neutral-500">
                  Object type
                </div>
                <Select
                  value={kind}
                  disabled={savingCreate}
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
                disabled={savingCreate}
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
        {draft?.missing ? (
          <div
            role="alert"
            class="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700"
          >
            This {objectKindSingular(kind)} no longer exists in the database.
            Your changes are kept but cannot be saved; discard them or copy the
            SQL.
          </div>
        ) : draft?.conflict ? (
          <div
            role="alert"
            class="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700"
          >
            This {objectKindSingular(kind)} changed in the database since you
            started editing. Saving replaces it with your version.
          </div>
        ) : null}
        {!isCreate && !selectedObject ? (
          <div class="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-sm text-neutral-500">
            Open a {objectKindSingular(kind)} from the Objects sidebar or
            catalog to inspect or edit it.
          </div>
        ) : null}
        {!isCreate &&
        selectedObject &&
        unsupportedText &&
        !kindCapability.canReadDefinition ? (
          <div class="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
            {unsupportedText}
          </div>
        ) : null}

        <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
          {savingCreate || !draft || (!isCreate && !draft.loaded) ? (
            <div
              class="flex h-full items-center justify-center gap-2 text-sm text-neutral-500"
              role="status"
            >
              <Spinner className="text-blue-600" />
              {savingCreate ? "Saving…" : "Loading…"}
            </div>
          ) : (
            <SqlEditorPane
              key={editorStorageId}
              win={{
                id: `${win.id}-editor`,
                type: "sql",
                title: win.title,
                content: sql,
              }}
              storageId={editorStorageId}
              controlledContent
              persistDraft={false}
              onCommitContent={(_, next) => {
                // Every change, unfiltered: comparing with this render's
                // `sql` would drop a change back to it before a re-render.
                // The store ignores text equal to its live SQL.
                useObjectDraftStore.getState().setSql(tabId, draftKey, next);
              }}
              onRunSql={undefined}
              onExplainSql={undefined}
              onCancelSql={undefined}
              isExecuting={!!draft.saving}
              schemas={meta.schemas ?? []}
              activeSchema={form.schema || rt.activeSchema}
              tables={meta.tables ?? []}
              columnsByTable={meta.columnsByTable}
              engine={rt.engine}
              toolbar={null}
            />
          )}
        </div>
      </div>
    </div>
  );
}
