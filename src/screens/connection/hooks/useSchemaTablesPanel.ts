import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { DatabaseEngine, DatabaseObjectItem, TableItem } from "src/types";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";
import { preferredSchemaFromList } from "src/lib/engines";

export function useSchemaTablesPanel(args: {
  metadata: MetadataApi;

  // stable cache key (NOT runtime connectionId)
  metaKey: string;
  engine?: DatabaseEngine;

  // runtime connection id used for executing metadata queries (can change)
  connectionId?: string | null;

  // optional initial schema for UI filter
  defaultSchema?: string;
  /** Active database/keyspace when the engine has no schema catalog. */
  currentDatabase?: string;
}) {
  const {
    metadata,
    metaKey,
    engine,
    connectionId,
    defaultSchema = "public",
    currentDatabase = "",
  } = args;

  // Lazy: first get() triggers load() if connectionId is available
  const meta = metadata.get({
    metaKey,
    engine,
    connectionId: connectionId ?? undefined,
    currentDatabase,
    lazy: true,
  });

  const [tableSearchQuery, setTableSearchQuery] = useState("");
  const [activeSchema, setActiveSchema] = useState(defaultSchema);
  const [expandedSections, setExpandedSections] = useState({
    functions: false,
    tables: true,
  });

  // Important: each tab/metaKey should start from its own default schema/db.
  // This prevents Mongo tabs from inheriting the previous tab's database.
  useEffect(() => {
    setActiveSchema(defaultSchema);
  }, [metaKey, defaultSchema]);

  // Keep active schema valid across engines:
  // - Postgres prefers "public" when available
  // - Others fall back to first available schema
  useEffect(() => {
    const schemas = meta.schemas ?? [];
    if (schemas.length === 0) return;
    if (activeSchema && schemas.includes(activeSchema)) return;

    const fallback =
      preferredSchemaFromList(engine, schemas, defaultSchema) ?? schemas[0]!;

    if (fallback !== activeSchema) setActiveSchema(fallback);
  }, [meta.schemas, activeSchema, engine, defaultSchema]);

  // Only change UI filter (metadata is global)
  const onSchemaChange = useCallback(
    (schema: string) => {
      if (!schema || schema === activeSchema) return;
      setActiveSchema(schema);
    },
    [activeSchema]
  );

  // Refresh metadata without touching activeSchema state
  const refreshSchemaAndTables = useCallback(async () => {
    if (!connectionId || !metaKey) return;
    await metadata.refresh({
      metaKey,
      engine,
      connectionId,
      currentDatabase,
    });
  }, [metadata, metaKey, engine, connectionId, currentDatabase]);

  // Filter tables for sidebar
  const filteredTables = useMemo(() => {
    const list = meta.tables ?? [];
    const q = tableSearchQuery.trim().toLowerCase();

    const bySchema = activeSchema
      ? list.filter((t: TableItem) => t.schema === activeSchema)
      : list;

    if (!q) return bySchema;

    return bySchema.filter(
      (t: TableItem) =>
        t.name.toLowerCase().includes(q) || t.schema.toLowerCase().includes(q)
    );
  }, [meta.tables, activeSchema, tableSearchQuery]);

  const isMongo = engine === "mongo";

  const filteredFunctions = useMemo(() => {
    // MongoDB has no SQL-style functions; keep empty for Mongo.
    if (isMongo) return [];

    const list = (meta.objects ?? []).filter(
      (item): item is DatabaseObjectItem => item.kind === "function"
    );
    const q = tableSearchQuery.trim().toLowerCase();

    const bySchema = activeSchema
      ? list.filter((f) => f.schema === activeSchema)
      : list;

    if (!q) return bySchema;

    return bySchema.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        (f.signature ?? "").toLowerCase().includes(q) ||
        f.schema.toLowerCase().includes(q)
    );
  }, [meta.objects, activeSchema, tableSearchQuery, isMongo]);

  // For editor autocomplete: use full metadata (not filtered).
  // For Mongo, schemas = databases (used for Database dropdown).
  const schemasForEditor = useMemo(() => meta.schemas ?? [], [meta.schemas]);
  const tablesForEditor = useMemo(() => meta.tables ?? [], [meta.tables]);
  const columnsByTable = useMemo(
    () => meta.columnsByTable ?? {},
    [meta.columnsByTable]
  );

  // Initial metadata hydration only — not column autocomplete enrichment.
  const isConnecting = useMemo(() => {
    if (!connectionId) return false;
    if (meta.error && !meta.loading) return false;
    if (meta.loaded) return false;
    // Background schema refresh keeps prior table list visible — don't block the data pane.
    if (meta.loading && (meta.tables?.length ?? 0) > 0) return false;
    return meta.loading;
  }, [connectionId, meta.loading, meta.loaded, meta.error, meta.tables]);

  return {
    meta,

    activeSchema,
    onSchemaChange,
    refreshSchemaAndTables,

    tableSearchQuery,
    setTableSearchQuery,

    expandedSections,
    setExpandedSections,

    filteredTables,
    filteredFunctions,

    schemasForEditor,
    tablesForEditor,
    columnsByTable,

    isConnecting,
  };
}
