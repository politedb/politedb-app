import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { DatabaseEngine, TableItem } from "src/types";
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
    views: false,
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

  const isMongo = engine === "mongo";

  const filterSidebarTables = useCallback(
    (list: TableItem[], kind: "table" | "view") => {
      const q = tableSearchQuery.trim().toLowerCase();
      const byKind = list.filter((t) =>
        kind === "view" ? t.kind === "view" : t.kind !== "view"
      );
      const bySchema = activeSchema
        ? byKind.filter((t) => t.schema === activeSchema)
        : byKind;
      if (!q) return bySchema;
      return bySchema.filter(
        (t) =>
          t.name.toLowerCase().includes(q) || t.schema.toLowerCase().includes(q)
      );
    },
    [activeSchema, tableSearchQuery]
  );

  // Filter tables for sidebar (exclude views — those go under Table Views)
  const filteredTables = useMemo(
    () => filterSidebarTables(meta.tables ?? [], "table"),
    [filterSidebarTables, meta.tables]
  );

  const filteredViews = useMemo(() => {
    // Mongo/Redis-style engines don't surface SQL views here.
    if (isMongo) return [];
    return filterSidebarTables(meta.tables ?? [], "view");
  }, [isMongo, filterSidebarTables, meta.tables]);

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
    filteredViews,

    schemasForEditor,
    tablesForEditor,
    columnsByTable,

    isConnecting,
  };
}
