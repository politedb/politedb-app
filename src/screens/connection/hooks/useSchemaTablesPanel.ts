import { useCallback, useMemo, useState } from "preact/hooks";
import type { DatabaseEngine, TableItem } from "src/types";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";

export function useSchemaTablesPanel(args: {
  metadata: MetadataApi;

  // stable cache key (NOT runtime connectionId)
  metaKey: string;
  engine?: DatabaseEngine;

  // runtime connection id used for executing metadata queries (can change)
  connectionId?: string | null;

  // optional initial schema for UI filter
  defaultSchema?: string;
}) {
  const {
    metadata,
    metaKey,
    engine,
    connectionId,
    defaultSchema = "public",
  } = args;

  // Lazy: first get() triggers load() if connectionId is available
  const meta = metadata.get({
    metaKey,
    engine,
    connectionId: connectionId ?? undefined,
    lazy: true,
  });

  const [tableSearchQuery, setTableSearchQuery] = useState("");
  const [activeSchema, setActiveSchema] = useState(defaultSchema);
  const [expandedSections, setExpandedSections] = useState({
    functions: false,
    tables: true,
  });

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
    });
  }, [metadata, metaKey, engine, connectionId]);

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

  // For editor autocomplete: use full metadata (not filtered)
  const schemasForEditor = useMemo(() => meta.schemas ?? [], [meta.schemas]);
  const tablesForEditor = useMemo(() => meta.tables ?? [], [meta.tables]);
  const columnsByTable = useMemo(
    () => meta.columnsByTable ?? {},
    [meta.columnsByTable]
  );

  // Connecting/loading state
  const isConnecting = useMemo(() => {
    return meta.loading && (meta.tables?.length ?? 0) === 0;
  }, [meta.loading, meta.tables]);

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

    schemasForEditor,
    tablesForEditor,
    columnsByTable,

    isConnecting,
  };
}
