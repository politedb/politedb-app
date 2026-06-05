import { useCallback, useMemo } from "preact/hooks";

import type {
  TableStructure as TableStructureType,
  TableConstraint as TableConstraintType,
} from "src/types";
import { DATA_KEYS } from "src/constant";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import { tableKey } from "src/hooks/useLoadTableData";

import { SqlWindowPane } from "./SqlWindowPane";
import { MainTableDataPane } from "./MainTableDataPane";
import { NewTableRoute } from "./NewTableRoute";
import { EmptyWindow, ConnectionFailedPlaceholder } from "./EmptyWindow";
import { useConnectionWindows } from "./hooks/useConnectionWindows";
import { useConnectionRuntimeCtx } from "./ConnectionRuntimeContext";
import { useConnectionActionsCtx } from "./ConnectionActionsContext";
import { useProfileStore } from "src/stores/profile";

const EMPTY_ARRAY: [] = [];

function getTableMeta(key: string) {
  if (!key) return null;
  return useConnectionStore.getState().tableDataMap[key] ?? null;
}

function getTableStructure(profileId: string, tableId: string) {
  if (!tableId) return EMPTY_ARRAY;
  return (
    useConnectionStore.getState().tableStructure[profileId]?.[tableId] ??
    EMPTY_ARRAY
  );
}

function getTableConstraints(profileId: string, tableId: string) {
  if (!tableId) return EMPTY_ARRAY;
  return (
    useConnectionStore.getState().tableConstraints[profileId]?.[tableId] ??
    EMPTY_ARRAY
  );
}

export function ActiveWindowContent() {
  const actions = useConnectionActionsCtx();
  const rt = useConnectionRuntimeCtx();

  const { profileId, isProfileLocked } = rt;
  const {
    hasAnyWindow,
    activeId,
    activeTab,
    activeSqlWindow,
    activeTableWindow,
  } = useConnectionWindows(profileId);

  const openEditConnection = useCallback(() => {
    const profileId = activeTab?.profileId;
    if (!profileId) return;
    useProfileStore.getState().openEdit(profileId);
  }, [activeTab?.profileId]);

  const activeKey = useMemo(() => {
    if (!activeTableWindow) return "";
    return tableKey(
      profileId,
      activeTableWindow.table.schema,
      activeTableWindow.table.name
    );
  }, [
    profileId,
    activeTableWindow?.table?.schema,
    activeTableWindow?.table?.name,
  ]);

  // -------------------------------------------------------------------------
  // Orchestration: patch writes
  // -------------------------------------------------------------------------

  const onDataChange = useCallback(
    (
      action: DataAction,
      dataKey: DataKey,
      rowIndex: number,
      data: Record<string, any>
    ) => {
      if (isProfileLocked) return;
      if (!profileId || !activeTableWindow || !activeKey) return;

      const currentMeta = getTableMeta(activeKey);
      if (!currentMeta) return;

      let rowKey: string;
      let patchData = data;

      if (rowIndex === -1 && data.__rowKey) {
        rowKey = String(data.__rowKey);
        const { __rowKey, ...rest } = data;
        patchData = rest;
      } else {
        rowKey = String(rowIndex);
      }

      useConnectionStore.getState().setDataPatchMap(profileId, {
        dataKey,
        action,
        tableData: currentMeta,
        tableWindow: activeTableWindow,
        rowKey,
        data: patchData,
      });
    },
    [isProfileLocked, profileId, activeTableWindow, activeKey]
  );

  const handleAddColumn = useCallback(() => {
    if (isProfileLocked) return;
    if (!activeTableWindow || !activeId) return;

    const currentStructure = getTableStructure(profileId, activeId);

    const newRecord: TableStructureType = {
      column_name: "",
      data_type: "",
      is_nullable: "",
      check: "",
      column_default: "",
      foreign_key: "",
      comment: "",
      isNew: true,
    };

    useConnectionStore
      .getState()
      .setTableStructure(profileId, activeId, [...currentStructure, newRecord]);

    onDataChange(
      "create",
      DATA_KEYS.structure,
      currentStructure.length,
      newRecord
    );
  }, [isProfileLocked, profileId, activeId, activeTableWindow, onDataChange]);

  const handleDeleteColumn = useCallback(
    (rowIndex: number) => {
      if (isProfileLocked) return;
      if (!activeTableWindow) return;
      onDataChange("delete", DATA_KEYS.structure, rowIndex, {});
    },
    [isProfileLocked, activeTableWindow, onDataChange]
  );

  const handleAddIndex = useCallback(() => {
    if (isProfileLocked) return;
    if (!activeTableWindow || !activeId) return;

    const currentConstraints = getTableConstraints(profileId, activeId);

    const newRecord: TableConstraintType = {
      index_name: "",
      index_algorithm: "",
      is_unique: "",
      column_name: "",
      condition: "",
      include: "",
      comment: "",
      isNew: true,
    };

    useConnectionStore
      .getState()
      .setTableConstraints(profileId, activeId, [
        ...currentConstraints,
        newRecord,
      ]);

    onDataChange(
      "create",
      DATA_KEYS.constraints,
      currentConstraints.length,
      newRecord
    );
  }, [isProfileLocked, profileId, activeId, activeTableWindow, onDataChange]);

  const handleDeleteIndex = useCallback(
    (rowIndex: number) => {
      if (isProfileLocked) return;
      if (!activeTableWindow) return;
      onDataChange("delete", DATA_KEYS.constraints, rowIndex, {});
    },
    [isProfileLocked, activeTableWindow, onDataChange]
  );

  const showConnectionFailureMain =
    !rt.runtimeConnectionId && Boolean(rt.loadError?.trim());

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  if (!hasAnyWindow) {
    if (showConnectionFailureMain) {
      return (
        <ConnectionFailedPlaceholder
          message={rt.loadError!}
          onEditConnection={
            activeTab?.profileId ? openEditConnection : undefined
          }
        />
      );
    }
    return (
      <EmptyWindow
        onNewSql={actions.openSql}
        canOpenSql={rt.engine !== "mongo" && rt.engine !== "cassandra"}
      />
    );
  }

  if (activeSqlWindow) {
    return (
      <SqlWindowPane
        win={activeSqlWindow}
        engine={rt.engine}
        runtimeConnectionId={rt.runtimeConnectionId}
        isProfileLocked={isProfileLocked}
        sqlSafetyMode={rt.sqlSafetyMode}
        sqlScopeKey={rt.sqlScopeKey}
        metaKey={rt.metaKey}
        metadata={rt.metadata}
        onRunSql={rt.runSqlWithHistory}
      />
    );
  }

  if (activeTableWindow?.table?.new) {
    return (
      <NewTableRoute
        activeTableWindow={activeTableWindow}
        engine={rt.engine}
        activeSchema={rt.activeSchema}
        profileId={profileId}
        onCreated={async (tableName) => {
          await actions.closeWindow(
            activeTableWindow.id,
            new MouseEvent("click")
          );

          await rt.refreshSchemaAndTables();

          const t = { schema: rt.activeSchema, name: tableName };
          await actions.selectTable(t);
        }}
        saveRef={rt.newTableSaveRef}
        isProfileLocked={isProfileLocked}
      />
    );
  }

  if (activeTableWindow) {
    return (
      <MainTableDataPane
        key={activeTableWindow.id}
        activeTableWindow={activeTableWindow}
        pageChange={actions.pageChange}
        onAddColumn={handleAddColumn}
        onDeleteColumn={handleDeleteColumn}
        onAddIndex={handleAddIndex}
        onDeleteIndex={handleDeleteIndex}
        isProfileLocked={isProfileLocked}
      />
    );
  }

  if (showConnectionFailureMain) {
    return (
      <ConnectionFailedPlaceholder
        message={rt.loadError!}
        onEditConnection={activeTab?.profileId ? openEditConnection : undefined}
      />
    );
  }

  return (
    <EmptyWindow
      onNewSql={actions.openSql}
      canOpenSql={rt.engine !== "mongo"}
    />
  );
}
