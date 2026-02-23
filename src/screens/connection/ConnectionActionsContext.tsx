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

  /** Open table tab then trigger export data (used from table context menu) */
  exportTableData(table: TableItem): void;
  /** Open table tab then trigger import data (used from table context menu) */
  importTableData(table: TableItem): void;
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
