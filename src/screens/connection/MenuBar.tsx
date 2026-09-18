import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { useScreenStore } from "src/stores/screen";
import { useProfileStore } from "src/stores/profile";
import { usePersistentStore } from "src/stores/persistentStore";
import {
  UnlockIcon,
  DatabaseIcon,
  RefreshCwIcon,
  SearchIcon,
  TabBottomIcon,
  TabRightIcon,
  TabLeftIcon,
  ChevronRightIcon,
  BackupIcon,
  RestoreIcon,
  LockIcon,
  SchemaIcon,
} from "src/components/icons";
import { cn } from "src/utils/cn";
import {
  formatConnectionDatabaseDisplay,
  inferDatabaseOverrideFromTabLabel,
  pickHostDbUser,
  usesTableOnlyBreadcrumb,
} from "src/utils/connection";
import { Button } from "src/components/common/Button";
import { TabViewMode } from "src/types";
import { TagChips } from "src/components/common/TagChips";
import { formatDatabaseVersion, normalizeEngineName } from "src/utils/convert";
import { DatabaseManagerDialog } from "src/components/modal/DatabaseManagerDialog";
import { canOpenDatabases } from "src/hooks/useDatabases";
import { formatTableBreadcrumbTarget } from "src/lib/engines";
import { connectionCreate } from "src/lib/tauri";
import type { ConnectionCreateInput } from "src/lib/tauri";
import { type QuerySafetyMode } from "@root/src/lib/queries/querySafety";
import { v4 as uuid } from "uuid";
import { useConnectionRuntimeCtx } from "./ConnectionRuntimeContext";
import { ErrorDialog } from "src/components/modal/ErrorDialog";
import { useDatabaseBackup } from "./hooks/useDatabaseBackup";
import { useConnectionHealthCheck } from "./hooks/useConnectionHealthCheck";
import { MetaPill } from "src/components/common/MetaPill";

interface Props {
  activeSchema?: string;
  activeTable?: string;
  connectionVersion?: string;
  schemas?: string[];
  viewMode?: TabViewMode[];
  loadTableError?: string | null;
  /** 0–99 while row chunks stream for the active table; omit or null when idle */
  tableRowsLoadPercent?: number | null;
  onSchemaChange?: (schema: string) => void;
  onViewModeChange?: (mode: TabViewMode) => void;
  openSQLWindow?: () => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  onSearchOpen?: () => void;
  onOpenSnippets?: () => void;
  onOpenAiAssistant?: () => void;
  onOpenDiagram?: () => void;
  onOpenDatabaseObjects?: () => void;
}

function ToolbarDivider() {
  return <div class="mx-1 h-5 w-px bg-neutral-200" />;
}

function IconButton(props: any) {
  const { className, ...rest } = props;
  return (
    <Button
      variant="ghost"
      className={cn(
        "h-7 w-7 rounded-md border-none p-0",
        "hover:bg-neutral-100 active:bg-neutral-200",
        "disabled:opacity-50",
        className
      )}
      {...rest}
    />
  );
}

function SegButton({
  title,
  onClick,
  children,
  className,
}: {
  title: string;
  onClick?: () => void;
  children: any;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      class={cn(
        "flex h-7 w-8 items-center justify-center rounded-md",
        "transition-colors",
        className
      )}
    >
      {children}
    </button>
  );
}

function EnvBadge({ text }: { text: string }) {
  if (!text) return null;

  const t = text.toUpperCase();
  const isProd = t.includes("PROD");
  const isStaging = t.includes("STAGING");
  const isDev = t.includes("DEV");

  const cls = isProd
    ? "bg-red-50 text-red-700 border-red-200"
    : isStaging
      ? "bg-sky-50 text-sky-700 border-sky-200"
      : isDev
        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
        : "bg-neutral-100 text-neutral-600 border-neutral-200";

  return (
    <span
      class={cn(
        "flex h-5 items-center rounded-md border px-1.5 text-xs font-semibold",
        cls
      )}
    >
      {t}
    </span>
  );
}

function MetaPillSkeleton({ className }: { className?: string }) {
  return (
    <div
      class={cn(
        "flex h-5 w-12 rounded-md border border-neutral-200 bg-neutral-100 p-0.75",
        className
      )}
      role="status"
      aria-label="Checking latency"
    >
      <span
        class={cn(
          "h-full w-full animate-pulse rounded-sm bg-neutral-200",
          className
        )}
      />
    </div>
  );
}

function classifyTags(tags: string[]) {
  const list = (tags ?? []).map((s) => s.trim()).filter(Boolean);
  const envKeywords = [
    "prod",
    "production",
    "staging",
    "stage",
    "dev",
    "local",
  ];

  const env = list.find((x) =>
    envKeywords.some((k) => x.toLowerCase().includes(k))
  );

  return {
    env: env ?? "",
    rest: list.filter((x) => x !== env),
  };
}

function withDatabaseInput(
  input: ConnectionCreateInput,
  database: string
): ConnectionCreateInput {
  if (input.engine === "postgres") {
    if (!input.postgres) throw new Error("POSTGRES_CONFIG_MISSING");
    return {
      ...input,
      postgres: {
        ...input.postgres,
        database,
      },
    };
  }

  if (input.engine === "mysql" || input.engine === "mariadb") {
    if (!input.mysql) throw new Error("MYSQL_CONFIG_MISSING");
    return {
      ...input,
      mysql: {
        ...input.mysql,
        database,
      },
    };
  }

  if (input.engine === "sqlserver") {
    if (!input.sqlserver) throw new Error("SQLSERVER_CONFIG_MISSING");
    return {
      ...input,
      sqlserver: {
        ...input.sqlserver,
        database,
      },
    };
  }

  if (input.engine === "mongo") {
    if (!input.mongo) throw new Error("MONGO_CONFIG_MISSING");
    return {
      ...input,
      mongo: {
        ...input.mongo,
        database,
      },
    };
  }

  if (input.engine === "sqlite") {
    if (!input.sqlite) throw new Error("SQLITE_CONFIG_MISSING");
    return {
      ...input,
      sqlite: {
        ...input.sqlite,
        path: database,
      },
    };
  }

  if (input.engine === "oracle") {
    if (!input.oracle) throw new Error("ORACLE_CONFIG_MISSING");
    return {
      ...input,
      oracle: {
        ...input.oracle,
        database,
      },
    };
  }

  if (input.engine === "clickhouse") {
    if (!input.clickhouse) throw new Error("CLICKHOUSE_CONFIG_MISSING");
    return {
      ...input,
      clickhouse: {
        ...input.clickhouse,
        database,
      },
    };
  }

  if (input.engine === "cassandra") {
    if (!input.cassandra) throw new Error("CASSANDRA_CONFIG_MISSING");
    return {
      ...input,
      cassandra: {
        ...input.cassandra,
        keyspace: database,
      },
    };
  }

  throw new Error("ENGINE_NOT_SUPPORTED_FOR_OPEN_DATABASE");
}

export function MenuBar({
  activeSchema,
  activeTable,
  connectionVersion: databaseVersion = "",
  viewMode = ["left"],
  loadTableError,
  tableRowsLoadPercent = null,
  onViewModeChange,
  onRefresh,
  isRefreshing = false,
  openSQLWindow,
  onSearchOpen,
  onOpenDiagram,
}: Props) {
  const rt = useConnectionRuntimeCtx();
  const health = useConnectionHealthCheck({
    runtimeConnectionId: rt.runtimeConnectionId,
    engine: rt.engine,
    loadError: loadTableError,
  });

  const [dbDialogOpen, setDbDialogOpen] = useState(false);
  const [safeModeOpen, setSafeModeOpen] = useState(false);
  const [progressVisible, setProgressVisible] = useState(false);
  const [progressValue, setProgressValue] = useState(20);
  const safeModeRef = useRef<HTMLDivElement | null>(null);
  const savePersistentNow = usePersistentStore((s) => s.saveNow);

  const getProfileById = useProfileStore((s) => s.getProfileById);

  const {
    activeProfileScreen,
    profileTabs,
    addTab,
    updateTab,
    setActiveProfileScreen,
  } = useScreenStore();

  const {
    dbBackupRunning,
    dbRestoreRunning,
    opError,
    setOpError,
    onBackupDatabase,
    onRestoreDatabase,
  } = useDatabaseBackup();

  const activeTab = useMemo(() => {
    return profileTabs.find((tab) => tab.id === activeProfileScreen);
  }, [profileTabs, activeProfileScreen]);
  const querySafetyMode =
    activeTab?.querySafetyMode ?? (activeTab?.isLocked ? "lock" : "default");

  useEffect(() => {
    if (!safeModeOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (safeModeRef.current && !safeModeRef.current.contains(target)) {
        setSafeModeOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [safeModeOpen]);

  useEffect(() => {
    if (typeof tableRowsLoadPercent === "number") {
      setProgressVisible(true);
      setProgressValue(
        Math.max(30, Math.min(99, Math.round(tableRowsLoadPercent)))
      );
      return;
    }
    if (!progressVisible) return;
    setProgressValue(100);
    const timer = window.setTimeout(() => {
      setProgressVisible(false);
      setProgressValue(0);
    }, 320);
    return () => window.clearTimeout(timer);
  }, [tableRowsLoadPercent, progressVisible]);

  const setQuerySafetyMode = useCallback(
    async (mode: QuerySafetyMode) => {
      if (!activeTab) return;
      updateTab(activeTab.id, {
        querySafetyMode: mode,
        isLocked: mode === "lock",
      });
      await savePersistentNow();
      setSafeModeOpen(false);
    },
    [activeTab, updateTab, savePersistentNow]
  );

  const profile = useMemo(() => {
    if (!activeTab?.profileId) return null;
    return getProfileById(activeTab.profileId);
  }, [activeTab, getProfileById]);

  const connectionInfo = useMemo(() => {
    if (!profile) return null;
    const { database, user } = pickHostDbUser(profile);
    const activeDatabase =
      activeTab?.databaseOverride ||
      inferDatabaseOverrideFromTabLabel(profile.label, activeTab?.label) ||
      database;

    const isSsh = Boolean(profile?.input?.ssh?.enabled);

    return {
      engine: profile.engine,
      version: databaseVersion,
      database: activeDatabase,
      user,
      schema: activeSchema || activeDatabase || "",
      table: activeTable || "",
      isSsh,
    };
  }, [
    profile,
    activeTab?.databaseOverride,
    activeTab?.label,
    databaseVersion,
    activeSchema,
    activeTable,
  ]);

  const connected = !!connectionInfo && !loadTableError;
  const runtimeConnectionId = rt.runtimeConnectionId ?? "";
  const connectionBlocked = !rt.runtimeConnectionId;
  const canOpenSql =
    connectionInfo?.engine !== "mongo" &&
    connectionInfo?.engine !== "cassandra" &&
    connectionInfo?.engine !== "redis";

  useEffect(() => {
    if (connectionBlocked) setSafeModeOpen(false);
  }, [connectionBlocked]);

  const tags = useMemo(() => {
    const raw = (profile?.input?.tags ?? []).map(String);
    return classifyTags(raw);
  }, [profile]);

  const dbLabel = useMemo(() => {
    if (!connectionInfo) return { db: "", dbTitle: "", target: "" };
    const { database, schema, table, engine } = connectionInfo;

    const usesDbOnlyBreadcrumb =
      engine === "clickhouse" ||
      engine === "cassandra" ||
      engine === "mongo" ||
      engine === "redis";
    const tableOnlyBreadcrumb = usesTableOnlyBreadcrumb(engine);

    const displayDb =
      database ||
      (usesDbOnlyBreadcrumb && schema && schema !== "default" ? schema : "");

    return {
      db: tableOnlyBreadcrumb
        ? ""
        : formatConnectionDatabaseDisplay(displayDb, engine),
      dbTitle: tableOnlyBreadcrumb ? "" : displayDb,
      target: table
        ? formatTableBreadcrumbTarget(engine, schema, table)
        : tableOnlyBreadcrumb
          ? schema || "main"
          : usesDbOnlyBreadcrumb || !schema || schema === displayDb
            ? ""
            : schema,
    };
  }, [connectionInfo]);

  const engineLabel = useMemo(() => {
    if (!connectionInfo) return "";

    const pretty = normalizeEngineName(connectionInfo.engine || "postgres", {
      upper: true,
    });
    const version = formatDatabaseVersion(
      connectionInfo.engine,
      connectionInfo.version
    );

    if (connectionInfo.engine === "google_sheets") {
      return version || "Google Sheets";
    }

    return [pretty, version].filter(Boolean).join(" ");
  }, [connectionInfo]);

  const queryModes = [
    {
      label: "Default mode",
      description: "Warn before sending queries",
      value: "default",
      color: "gray",
    },
    {
      label: "Lock mode",
      description: "Block all editing queries",
      value: "lock",
      color: "red",
    },
    {
      label: "Safe mode",
      description: "Require Touch ID before sending queries",
      value: "safe",
      color: "green",
    },
    {
      label: "Production mode",
      description: "Touch ID for reads, block writes",
      value: "production",
      color: "amber",
    },
  ];

  const queryModeDotClass: Record<string, string> = {
    gray: "bg-gray-500",
    red: "bg-red-500",
    green: "bg-green-500",
    amber: "bg-amber-500",
  };

  const onOpenDatabase = useCallback(
    async (nextDb: string) => {
      if (!activeTab?.profileId || !profile) {
        throw new Error("PROFILE_NOT_FOUND");
      }

      if (!nextDb || nextDb === connectionInfo?.database) return;

      const nextInput = withDatabaseInput(profile.input, nextDb);
      const conn = await connectionCreate(nextInput);

      const nextTabId = `tab-${uuid()}`;
      const nextTab = {
        id: nextTabId,
        label: `${profile.label} · ${nextDb}`,
        engine: profile.engine,
        runtimeConnectionId: conn.id,
        profileId: profile.id,
        databaseOverride: nextDb,
        profileTags: profile.input?.tags ?? [],
      };
      addTab(nextTab);
      setActiveProfileScreen(nextTabId);
      void import("src/stores/connectionLog").then(
        ({ recordConnectionSessionOpened }) =>
          recordConnectionSessionOpened(nextTab)
      );
    },
    [
      activeTab,
      profile,
      connectionInfo?.database,
      addTab,
      setActiveProfileScreen,
    ]
  );

  return (
    <>
      <div class="group flex h-10 items-center gap-2 border-b border-neutral-200 bg-neutral-50/80 px-2 select-none">
        <div class="flex items-center">
          <div
            class={cn(
              "flex items-center gap-1 rounded-lg border border-neutral-200 bg-white px-1 py-0.5 shadow-[0_1px_0_rgba(0,0,0,0.02)]"
            )}
          >
            <div class="relative" ref={safeModeRef}>
              <IconButton
                className="size-6"
                title="Safety mode"
                disabled={connectionBlocked}
                onClick={(e: any) => {
                  e.stopPropagation();
                  setSafeModeOpen((prev) => !prev);
                }}
              >
                {querySafetyMode === "default" ? (
                  <UnlockIcon className={cn("size-4", "text-neutral-600")} />
                ) : (
                  <LockIcon
                    className={cn(
                      "size-4",
                      querySafetyMode === "safe"
                        ? "text-green-600"
                        : querySafetyMode === "production"
                          ? "text-amber-600"
                          : "text-red-600"
                    )}
                  />
                )}
              </IconButton>

              {safeModeOpen ? (
                <div class="absolute top-8 -left-1 z-40 w-md rounded-lg border border-neutral-200 bg-white p-1 shadow-lg">
                  {queryModes.map((mode) => (
                    <button
                      type="button"
                      class={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-neutral-100",
                        querySafetyMode === mode.value && "bg-neutral-100"
                      )}
                      onClick={() =>
                        void setQuerySafetyMode(mode.value as QuerySafetyMode)
                      }
                    >
                      <div
                        class={cn(
                          "size-1 rounded-full p-1",
                          queryModeDotClass[mode.color] ?? "bg-gray-500"
                        )}
                      />
                      <div class="flex items-center gap-2 text-sm">
                        <span class="font-semibold text-neutral-800">
                          {mode.label}
                        </span>
                        <span>-</span>
                        <span class="text-neutral-500">{mode.description}</span>
                      </div>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <IconButton
              className="size-6"
              title="Database"
              disabled={
                connectionBlocked ||
                activeTab?.isLocked ||
                !runtimeConnectionId ||
                !canOpenDatabases(connectionInfo?.engine)
              }
              onClick={() => setDbDialogOpen(true)}
            >
              <DatabaseIcon className="size-4 text-neutral-600" />
            </IconButton>

            <ToolbarDivider />

            <Button
              variant="ghost"
              className="h-6 rounded-md border-none px-2 text-xs font-medium hover:bg-neutral-100 active:bg-neutral-200"
              disabled={!canOpenSql || connectionBlocked}
              onClick={openSQLWindow}
            >
              SQL
            </Button>
          </div>
        </div>

        <div class="flex min-w-0 flex-1 items-center justify-center">
          <div class="relative w-full max-w-220 min-w-0">
            <div
              class={cn(
                "relative flex h-7.75 w-full items-center gap-2 overflow-hidden rounded-lg border bg-white pr-2 pl-8",
                loadTableError
                  ? "border-red-300"
                  : "border-neutral-200 hover:border-neutral-300",
                "shadow-[0_1px_0_rgba(0,0,0,0.02)]"
              )}
            >
              {(tags.env || tags.rest.length > 0) && (
                <div class="flex min-w-0 items-center gap-1">
                  {tags.env ? <EnvBadge text={tags.env} /> : null}

                  <TagChips
                    tags={tags.rest}
                    max={2}
                    size="sm"
                    className="gap-1"
                  />

                  <div class="mx-1 h-4 w-px bg-neutral-200" />
                </div>
              )}

              {connectionInfo ? (
                <div class="flex min-w-0 flex-1 items-center gap-1 truncate">
                  {dbLabel.db ? (
                    <span
                      class="text-sm font-semibold text-neutral-800"
                      title={dbLabel.dbTitle || dbLabel.db}
                    >
                      {dbLabel.db}
                    </span>
                  ) : null}
                  {dbLabel.target ? (
                    <>
                      {dbLabel.db ? (
                        <ChevronRightIcon className="size-2.5" />
                      ) : null}
                      <span
                        class={cn(
                          "text-sm font-medium text-neutral-600",
                          !dbLabel.db && "font-semibold text-neutral-800"
                        )}
                      >
                        {dbLabel.target}
                      </span>
                    </>
                  ) : null}
                </div>
              ) : (
                <div class="text-xs text-neutral-500">No connection</div>
              )}

              {connectionInfo && (
                <div class="flex items-center gap-1">
                  <div class="mx-1 h-4 w-px bg-neutral-200" />
                  {health.checking ? (
                    <MetaPillSkeleton />
                  ) : (
                    <MetaPill
                      text={`${health.latencyMs ?? 0} ms`}
                      title="Connection latency"
                      tone={
                        health.latencyMs !== null && health.latencyMs > 1500
                          ? "amber"
                          : health.status === "down"
                            ? "neutral"
                            : "green"
                      }
                    />
                  )}
                  <MetaPill text={engineLabel} />
                  {connectionInfo.isSsh ? (
                    <MetaPill text="SSH" tone="blue" />
                  ) : null}
                </div>
              )}

              {progressVisible ? (
                <div
                  class="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-0.75 bg-neutral-100"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progressValue}
                  aria-label="Loading table rows"
                >
                  <div
                    class="h-full rounded-sm bg-blue-500 transition-[width] duration-200 ease-out"
                    style={{ width: `${progressValue}%` }}
                  />
                </div>
              ) : null}
            </div>

            <div class="absolute top-0 left-2 z-10 flex h-7.75 items-center">
              <IconButton
                className="size-4 active:bg-transparent"
                title="Recheck connection latency"
                onClick={() => void health.runCheck()}
                disabled={health.checking || !rt.runtimeConnectionId}
              >
                <span class="relative flex size-2">
                  <span
                    class={cn(
                      "absolute inline-flex h-full w-full rounded-full opacity-75 group-hover:animate-ping",
                      connected
                        ? "bg-emerald-500"
                        : loadTableError
                          ? "bg-red-500"
                          : "bg-neutral-300"
                    )}
                  />
                  <span
                    class={cn(
                      "relative inline-flex size-2 rounded-full",
                      connected
                        ? "bg-emerald-500"
                        : loadTableError
                          ? "bg-red-500"
                          : "bg-neutral-300"
                    )}
                  />
                </span>
              </IconButton>
            </div>
          </div>
        </div>

        <div class="flex items-center gap-1">
          <div class="mx-1 h-5 w-px bg-neutral-200" />

          <IconButton
            title={dbBackupRunning ? "Backing up..." : "Backup database"}
            onClick={() => void onBackupDatabase(connectionInfo?.database)}
            disabled={
              !rt.runtimeConnectionId || dbBackupRunning || dbRestoreRunning
            }
          >
            <BackupIcon className="size-4 text-neutral-700" />
          </IconButton>

          <IconButton
            title={dbRestoreRunning ? "Restoring..." : "Restore database"}
            onClick={() => void onRestoreDatabase(onRefresh)}
            disabled={
              !!activeTab?.isLocked ||
              !rt.runtimeConnectionId ||
              dbBackupRunning ||
              dbRestoreRunning
            }
          >
            <RestoreIcon className="size-4 text-neutral-700" />
          </IconButton>

          <ToolbarDivider />

          <IconButton
            title={isRefreshing ? "Refreshing..." : "Refresh"}
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            <span
              class={cn(
                "inline-flex items-center justify-center",
                isRefreshing && "animate-spin"
              )}
            >
              <RefreshCwIcon className="size-4.5 text-neutral-700" />
            </span>
          </IconButton>

          <IconButton title="Search" onClick={onSearchOpen}>
            <SearchIcon className="size-4 text-neutral-700" />
          </IconButton>

          <ToolbarDivider />

          <IconButton
            title="Generate Diagram"
            onClick={onOpenDiagram}
            disabled={!rt.runtimeConnectionId || rt.engine === "redis"}
          >
            <SchemaIcon className="size-4 text-neutral-700" />
          </IconButton>

          <div class="flex h-7 items-center rounded-lg border border-neutral-200 bg-neutral-50 p-0.5">
            <SegButton
              title="Tab Left"
              onClick={() => onViewModeChange?.("left")}
            >
              <TabLeftIcon
                className={cn(
                  "size-4 transition-colors",
                  viewMode.includes("left")
                    ? "text-blue-600"
                    : "text-neutral-600"
                )}
              />
            </SegButton>

            <div class="mx-0.5 h-5 w-px bg-neutral-200" />

            <SegButton
              title="Tab Bottom"
              onClick={() => onViewModeChange?.("bottom")}
            >
              <TabBottomIcon
                className={cn(
                  "size-4 transition-colors",
                  viewMode.includes("bottom")
                    ? "text-blue-600"
                    : "text-neutral-600"
                )}
              />
            </SegButton>

            <div class="mx-0.5 h-5 w-px bg-neutral-200" />

            <SegButton
              title="Tab Right"
              onClick={() => onViewModeChange?.("right")}
            >
              <TabRightIcon
                className={cn(
                  "size-4 transition-colors",
                  viewMode.includes("right")
                    ? "text-blue-600"
                    : "text-neutral-600"
                )}
              />
            </SegButton>
          </div>
        </div>
      </div>

      <DatabaseManagerDialog
        open={dbDialogOpen}
        engine={connectionInfo?.engine}
        runtimeConnectionId={runtimeConnectionId}
        onOpenDatabase={onOpenDatabase}
        onClose={() => setDbDialogOpen(false)}
      />

      {opError && (
        <ErrorDialog
          open={true}
          error={opError}
          onClose={() => setOpError(null)}
          size="md"
          showRevertNote={false}
        />
      )}
    </>
  );
}
