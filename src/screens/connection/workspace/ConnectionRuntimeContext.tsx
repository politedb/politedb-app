import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { QuerySafetyMode } from "@root/src/lib/queries/querySafety";
import type { DatabaseEngine } from "src/types";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";
import type {
  RunSqlReturn,
  SqlHistoryTarget,
} from "../hooks/useSqlHistoryRunner";

export type SqlRunFn = (args: {
  windowId: string;
  connectionId: string;
  sql: string;
}) => Promise<RunSqlReturn>;

export type ConnectionRuntime = {
  profileId: string;
  engine: DatabaseEngine;
  sqlScopeKey: string;
  metaKey: string;
  metadata: MetadataApi;

  activeSchema: string;
  runtimeConnectionId?: string;
  isProfileLocked: boolean;
  sqlSafetyMode: QuerySafetyMode;

  // pagination currently kept in screen
  limit: number;
  offset: number;

  loadError: string | null;

  // services
  runSqlWithHistory: SqlRunFn;
  captureHistoryTarget: () => SqlHistoryTarget | null;
  refreshSchemaAndTables: () => Promise<void>;

  // new table
  newTableSaveRef: { current: (() => Promise<void>) | null };

  /** When set by context menu, MainTableDataPane runs import/clone/structure then clears */
  pendingTableAction: PendingTableAction | null;
  setPendingTableAction: (action: PendingTableAction | null) => void;

  /** Table whose rows changed outside its view (e.g. truncated from the object tree). */
  staleTableKey: string | null;
  setStaleTableKey: (key: string | null) => void;
};

/** Actions the table view runs after the object tree opened it. */
export type PendingTableAction =
  | "import"
  | "importSqlDump"
  | "clone"
  | "structure";

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
