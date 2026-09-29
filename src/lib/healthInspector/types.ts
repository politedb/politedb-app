export type HealthSectionStatus =
  | "loading"
  | "ready"
  | "empty"
  | "unavailable"
  | "error";

export type HealthSectionMeta = {
  status: HealthSectionStatus;
  collectedAt: number | null;
  error: string | null;
  truncated: boolean;
  /** Human-readable reason when unavailable (missing extension, privileges, etc.). */
  unavailableReason: string | null;
};

export type HealthOverview = {
  databaseName: string | null;
  sessionCount: number | null;
  activeSessionCount: number | null;
  idleSessionCount: number | null;
  blockedSessionCount: number | null;
  longestXactAgeSeconds: number | null;
  hiddenQueryCount: number | null;
  /** Sessions whose state/timing are hidden with the privilege-redacted query marker. */
  restrictedActivityCount: number | null;
  databaseBytes: number | null;
  statsReset: string | null;
  /**
   * True when some session activity is privilege-restricted
   * (null query or PostgreSQL's `<insufficient privilege>` marker).
   */
  restrictedVisibility: boolean;
};

export type HealthSessionRow = {
  pid: number | null;
  usename: string | null;
  applicationName: string | null;
  clientAddr: string | null;
  state: string | null;
  waitEventType: string | null;
  waitEvent: string | null;
  backendType: string | null;
  xactAgeSeconds: number | null;
  queryAgeSeconds: number | null;
  stateAgeSeconds: number | null;
  isExecuting: boolean;
  queryText: string | null;
  queryHidden: boolean;
  isBlocked: boolean;
  blockerPids: number[];
};

export type HealthStatementRow = {
  queryId: string | null;
  queryText: string | null;
  queryHidden: boolean;
  calls: number | null;
  totalTimeMs: number | null;
  meanTimeMs: number | null;
  rows: number | null;
};

export type HealthStatementsInfo = {
  dealloc: number | null;
  statsReset: string | null;
};

export type HealthTableRow = {
  schema: string | null;
  tableName: string | null;
  liveTuples: number | null;
  deadTuples: number | null;
  lastVacuum: string | null;
  lastAutovacuum: string | null;
  lastAnalyze: string | null;
  lastAutoAnalyze: string | null;
  tableBytes: number | null;
  indexesBytes: number | null;
  totalBytes: number | null;
  isPartitionedParent: boolean;
  isPartitionChild: boolean;
};

export type HealthIndexRow = {
  schema: string | null;
  tableName: string | null;
  indexName: string | null;
  idxScan: number | null;
  idxTupRead: number | null;
  idxTupFetch: number | null;
  indexBytes: number | null;
};

export type HealthSection<T> = HealthSectionMeta & {
  data: T;
};

export type HealthInspectorSnapshot = {
  runtimeConnectionId: string;
  profileId: string;
  engine: string;
  startedAt: number;
  finishedAt: number | null;
  overallError: string | null;
  cancelled: boolean;
  overview: HealthSection<HealthOverview | null>;
  sessions: HealthSection<HealthSessionRow[]>;
  statements: HealthSection<HealthStatementRow[]> & {
    info: HealthStatementsInfo | null;
  };
  tables: HealthSection<HealthTableRow[]>;
  indexes: HealthSection<HealthIndexRow[]>;
};

export type HealthInspectorCapabilities = {
  statementsAvailable: boolean;
  statementsSchema: string | null;
  totalTimeColumn: "total_exec_time" | "total_time" | null;
  meanTimeColumn: "mean_exec_time" | "mean_time" | null;
  hasInfoView: boolean;
  unavailableReason: string | null;
};
