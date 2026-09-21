import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { TableItem } from "src/types";
import type { PatchMap } from "src/utils/generateSql";

export type ConnectionActions = {
  openSql(): void;
  refresh(): Promise<void>;
  saveChanges(): Promise<void> | void;
  discardChanges(): Promise<void>;
  getPatchMap(): PatchMap | null;

  closeWindow(windowId: string, e: MouseEvent): Promise<void>;
  closeTab(tabId: string, skipCheck?: boolean): Promise<void>;

  pageChange(limit: number, offset: number): Promise<void>;
  selectTable(table: TableItem): Promise<void>;

  /** Open table tab then switch to Structure view (used from table context menu) */
  openTableStructure(table: TableItem): void;
  /** Open table tab then trigger export data (used from table context menu) */
  exportTableData(table: TableItem): void;
  /** Open table tab then trigger CSV import (used from table context menu) */
  importTableData(table: TableItem): void;
  /** Open table tab then trigger SQL dump import (used from table context menu) */
  importTableSqlDump(table: TableItem): void;
  /** Open table tab then trigger clone table (used from table context menu) */
  cloneTable(table: TableItem): void;
  /** Open table tab then trigger truncate table (used from table context menu) */
  truncateTable(table: TableItem): void;
  /** Open table tab then trigger delete table (used from table context menu) */
  dropTable(table: TableItem): void;
  renameRedisKey(table: TableItem, nextName: string): Promise<void>;
  deleteRedisKey(table: TableItem): Promise<void>;
};

const Ctx = createContext<ConnectionActions | null>(null);

export function ConnectionActionsProvider(props: {
  value: ConnectionActions;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={props.value}>{props.children}</Ctx.Provider>;
}

export function useConnectionActionsCtx(): ConnectionActions {
  const v = useContext(Ctx);
  if (!v) throw new Error("ConnectionActionsContext missing");
  return v;
}
