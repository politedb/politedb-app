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

/** Top blocker ranked from the full current-database activity set (not the UI row cap). */
export type HealthBlockerSummary = {
  pid: number;
  /** Distinct sessions in this database blocked by this PID. */
  blockedSessionCount: number;
  /** Whether the blocker itself appears in current-database activity. */
  inCurrentDatabase: boolean;
  /**
   * PostgreSQL represents a prepared-transaction blocker as PID 0 —
   * not a live session.
   */
  isPreparedTransaction: boolean;
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

  /** Idle-in-transaction (+ aborted), excluding the Inspector's own backend. */
  idleInTransactionCount: number | null;
  /** Oldest open transaction age among idle-in-transaction sessions (xact_start). */
  idleInTransactionOldestXactAgeSeconds: number | null;
  /** Longest time spent in the idle-in-transaction state (state_change). */
  idleInTransactionLongestIdleSeconds: number | null;

  /** Up to five blocker PIDs ranked by distinct blocked sessions (deterministic ties). */
  topBlockers: HealthBlockerSummary[];
  /**
   * True when at least one top blocker is outside this database, privilege-hidden,
   * or is the prepared-transaction sentinel PID 0.
   */
  hasUnresolvedBlockers: boolean;
  /** Exact lock-wait duration has no verified supported source in this snapshot. */
  lockWaitDurationAvailable: false;

  /** Cumulative temp file count for the current database since stats reset. */
  tempFiles: number | null;
  /** Cumulative temp file bytes for the current database since stats reset. */
  tempBytes: number | null;
  /** Cumulative deadlock count for the current database since stats reset. */
  deadlocks: number | null;
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
  tables: HealthSection<HealthTableRow[]> & SizeRankedSection;
  indexes: HealthSection<HealthIndexRow[]> & SizeRankedSection;
};

export type SizeRankedSection = {
  /**
   * True when the database has more relations than were sized, so the size
   * order comes from catalog estimates and may miss a recently grown one.
   */
  sizeRankingEstimated: boolean;
};

export type HealthInspectorCapabilities = {
  statementsAvailable: boolean;
  statementsSchema: string | null;
  totalTimeColumn: "total_exec_time" | "total_time" | null;
  meanTimeColumn: "mean_exec_time" | "mean_time" | null;
  hasInfoView: boolean;
  unavailableReason: string | null;
};

export type HealthAttentionKind =
  | "blocked"
  | "idle_in_transaction"
  | "long_transaction"
  | "deadlocks_history"
  | "incomplete";

export type HealthAttentionItem = {
  kind: HealthAttentionKind;
  /** Actionable current conditions vs informational history vs incomplete data. */
  tone: "actionable" | "informational" | "incomplete";
  title: string;
  evidence: string;
  /** Offer a Sessions tab switch without re-querying. */
  openSessions: boolean;
};
