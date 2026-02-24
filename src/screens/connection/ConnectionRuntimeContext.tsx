import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { DatabaseEngine } from "src/types";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";
import { RunSqlReturn } from "./hooks/useSqlHistoryRunner";

export type SqlRunFn = (args: {
  windowId: string;
  connectionId: string;
  sql: string;
}) => Promise<RunSqlReturn>;

export type ConnectionRuntime = {
  profileId: string;
  engine: DatabaseEngine;
  metaKey: string;
  metadata: MetadataApi;

  activeSchema: string;
  runtimeConnectionId?: string;

  // pagination currently kept in screen
  limit: number;
  offset: number;

  loadError: string | null;

  // services
  runSqlWithHistory: SqlRunFn;
  refreshSchemaAndTables: () => Promise<void>;

  // new table
  newTableSaveRef: { current: (() => Promise<void>) | null };

  /** When set by context menu, MainTableDataPane runs export/import/clone then clears */
  pendingTableAction: "export" | "import" | "clone" | null;
  setPendingTableAction: (action: "export" | "import" | "clone" | null) => void;
};

const Ctx = createContext<ConnectionRuntime | null>(null);

export function ConnectionRuntimeProvider(props: {
  value: ConnectionRuntime;
  children: any;
}) {
  return <Ctx.Provider value={props.value}>{props.children}</Ctx.Provider>;
}

export function useConnectionRuntimeCtx(): ConnectionRuntime {
  const v = useContext(Ctx);
  if (!v) throw new Error("ConnectionRuntimeContext missing");
  return v;
}
