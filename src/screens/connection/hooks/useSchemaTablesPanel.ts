import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { TableItem } from "src/types";
import { useLoadTables } from "src/hooks/useLoadTables";
import { useConnectionStore } from "src/stores/connection";

export function useSchemaTablesPanel(args: {
  activeProfileScreen: string;
  activeTabId?: string;
}) {
  const { activeProfileScreen, activeTabId } = args;

  const tabTables = useConnectionStore((s) => s.tables[activeProfileScreen]);
  const tabSchemas = useConnectionStore((s) => s.schemas[activeProfileScreen]);

  const { loadSchemaAndTables } = useLoadTables();

  const [tableSearchQuery, setTableSearchQuery] = useState("");
  const [activeSchema, setActiveSchema] = useState("public");
  const [expandedSections, setExpandedSections] = useState({
    functions: false,
    tables: true,
  });

  // auto load when tab/schema really changes
  useEffect(() => {
    if (!activeTabId) return;
    void loadSchemaAndTables(activeSchema);
  }, [activeTabId, activeSchema, loadSchemaAndTables]);

  const onSchemaChange = useCallback(
    async (schema: string) => {
      if (schema === activeSchema) return;
      setActiveSchema(schema);
      await loadSchemaAndTables(schema);
    },
    [activeSchema, loadSchemaAndTables]
  );

  // ✅ NEW: refresh without touching state
  const refreshSchemaAndTables = useCallback(async () => {
    if (!activeSchema) return;
    await loadSchemaAndTables(activeSchema);
  }, [activeSchema, loadSchemaAndTables]);

  const filteredTables = useMemo(() => {
    const list = tabTables?.data ?? [];
    const q = tableSearchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (t: TableItem) =>
        t.name.toLowerCase().includes(q) || t.schema.toLowerCase().includes(q)
    );
  }, [tabTables, tableSearchQuery]);

  const schemasForEditor = useMemo(() => tabSchemas?.data ?? [], [tabSchemas]);
  const tablesForEditor = useMemo(() => tabTables?.data ?? [], [tabTables]);

  const isConnecting = useMemo(() => {
    return (
      (tabTables?.busy && (tabTables?.data?.length ?? 0) === 0) ||
      (tabSchemas?.busy && (tabSchemas?.data?.length ?? 0) === 0)
    );
  }, [tabTables, tabSchemas]);

  return {
    tabTables,
    tabSchemas,

    activeSchema,
    onSchemaChange,
    refreshSchemaAndTables, // ✅ export

    tableSearchQuery,
    setTableSearchQuery,

    expandedSections,
    setExpandedSections,

    filteredTables,
    schemasForEditor,
    tablesForEditor,

    isConnecting,
  };
}
