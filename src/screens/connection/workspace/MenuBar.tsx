import {
  OPEN_SAFETY_MODE_PICKER_EVENT,
  QUERY_SAFETY_MODES,
} from "src/lib/queries/querySafetyModes";
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
  DbInspectorIcon,
  DiagramIcon,
} from "src/components/icons";
import { cn } from "src/utils/cn";
import {
  formatConnectionDatabaseDisplay,
  pickHostDbUser,
  usesTableOnlyBreadcrumb,
} from "src/lib/connection/connection";
import { Button } from "src/components/common/Button";
import { TabViewMode } from "src/types";
import { TagChips } from "src/components/common/TagChips";
import { formatDatabaseVersion, normalizeEngineName } from "src/utils/convert";
import { DatabaseManagerDialog } from "src/components/modal/DatabaseManagerDialog";
import { canOpenDatabases } from "src/hooks/useDatabases";
import { formatTableBreadcrumbTarget } from "src/lib/engines";
import { connectTabOnce, tabLabelFor } from "src/lib/runtimeConnection";
import {
  resolveTabTarget,
  supportsDatabaseOverride,
} from "src/lib/tabs/tabTarget";
import { useRuntimeTargetsStore } from "src/stores/runtimeTargets";
import { type QuerySafetyMode } from "@root/src/lib/queries/querySafety";
import { v4 as uuid } from "uuid";
import { useConnectionRuntimeCtx } from "./ConnectionRuntimeContext";
import {
  canBackupDatabase,
  useDatabaseBackup,
} from "../hooks/useDatabaseBackup";
import { useProGate } from "src/hooks/useProGate";
import { useConnectionHealthCheck } from "../hooks/useConnectionHealthCheck";
import { MetaPill } from "src/components/common/MetaPill";
import { resolveMenuBarConnectionChrome } from "./menuBarConnectionChrome";

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
  onOpenHealthInspector?: () => void;
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

function MetaPillSkeleton({ className }: { className?: string }) {
  return (
    <div
      class={cn(
        "flex h-5 w-12 rounded-md border border-neutral-200 bg-neutral-100",
        "p-0.75",
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
  onOpenHealthInspector,
}: Props) {
  const rt = useConnectionRuntimeCtx();
  const { connected, isConnectionError } = resolveMenuBarConnectionChrome({
    hasRuntimeConnection: !!rt.runtimeConnectionId,
    loadError: loadTableError,
  });
  const health = useConnectionHealthCheck({
    runtimeConnectionId: rt.runtimeConnectionId,
    engine: rt.engine,
    // Only seed health from connection-level errors, not table/query failures.
    loadError: isConnectionError ? loadTableError : null,
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
    onBackupDatabase,
    onRestoreDatabase,
  } = useDatabaseBackup();
  const { requirePro } = useProGate();

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

  // What the tab's connection was opened on, as the backend recorded it (D1).
  const runtimeDisplay = useRuntimeTargetsStore((s) =>
    activeTab?.runtimeConnectionId
      ? (s.targets[activeTab.runtimeConnectionId]?.display ?? "")
      : ""
  );

  const connectionInfo = useMemo(() => {
    if (!profile) return null;
    const { database, user } = pickHostDbUser(profile);
    // What the connection was actually opened on (D1), else what the tab
    // was opened on (R2) before it connects.
    const resolved = resolveTabTarget(activeTab, profile);
    const activeDatabase =
      runtimeDisplay ||
      resolved.intended?.override ||
      (resolved.state === "ok" ? database : "");

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
    activeTab,
    runtimeDisplay,
    databaseVersion,
    activeSchema,
    activeTable,
  ]);

  const runtimeConnectionId = rt.runtimeConnectionId ?? "";
  const connectionBlocked = !rt.runtimeConnectionId;
  const canOpenSql =
    connectionInfo?.engine !== "mongo" &&
    connectionInfo?.engine !== "cassandra" &&
    connectionInfo?.engine !== "redis";

  useEffect(() => {
    if (connectionBlocked) setSafeModeOpen(false);
  }, [connectionBlocked]);

  // The picker is a menu (so app shortcuts wait while it is open): it opens
  // on the current mode, arrows move, Escape closes back to its button.
  const safeModeMenuRef = useRef<HTMLDivElement | null>(null);
  const focusSafeModeTrigger = () =>
    safeModeRef.current
      ?.querySelector<HTMLElement>("[data-safety-mode-trigger]")
      ?.focus();
  useEffect(() => {
    if (!safeModeOpen) return;
    const menu = safeModeMenuRef.current;
    (
      menu?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      menu?.querySelector<HTMLElement>('[role="menuitemradio"]')
    )?.focus();
  }, [safeModeOpen]);
  const onSafeModeMenuKeyDown = (e: KeyboardEvent) => {
    const items = Array.from(
      safeModeMenuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitemradio"]'
      ) ?? []
    );
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (index + 1) % items.length;
    else if (e.key === "ArrowUp")
      next = (index - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      setSafeModeOpen(false);
      if (e.key === "Escape") focusSafeModeTrigger();
      return;
    } else return;
    e.preventDefault();
    items[next]?.focus();
  };

  // The status bar's mode badge opens this picker.
  useEffect(() => {
    const open = () => {
      if (!connectionBlocked) setSafeModeOpen(true);
    };
    window.addEventListener(OPEN_SAFETY_MODE_PICKER_EVENT, open);
    return () =>
      window.removeEventListener(OPEN_SAFETY_MODE_PICKER_EVENT, open);
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

  const onOpenDatabase = useCallback(
    async (nextDb: string) => {
      if (!activeTab?.profileId || !profile) {
        throw new Error("PROFILE_NOT_FOUND");
      }

      if (!nextDb || nextDb === connectionInfo?.database) return;
      if (!supportsDatabaseOverride(profile.engine)) {
        throw new Error("ENGINE_NOT_SUPPORTED_FOR_OPEN_DATABASE");
      }

      // The tab records what it is opened on (R12); its connection is opened
      // by the backend from the saved profile on that database, and the tab
      // owns it (R3).
      const target = { kind: "override" as const, database: nextDb };
      const nextTabId = `tab-${uuid()}`;
      const nextTab = {
        id: nextTabId,
        label: tabLabelFor(profile.label, target),
        engine: profile.engine,
        profileId: profile.id,
        target,
        databaseOverride: nextDb,
        profileTags: profile.input?.tags ?? [],
      };
      addTab(nextTab);
      setActiveProfileScreen(nextTabId);
      await connectTabOnce(nextTabId);
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
              "flex items-center gap-1 rounded-lg border border-neutral-200",
              "bg-white px-1 py-0.5 shadow-[0_1px_0_rgba(0,0,0,0.02)]"
            )}
          >
            <div class="relative" ref={safeModeRef}>
              <IconButton
                className="size-6"
                title="Safety mode"
                aria-haspopup="menu"
                aria-expanded={safeModeOpen}
                data-safety-mode-trigger
                disabled={connectionBlocked}
                onClick={(e: any) => {
                  e.stopPropagation();
                  setSafeModeOpen((prev) => !prev);
                }}
              >
                {querySafetyMode === "default" ? (
                  <UnlockIcon className={cn("size-4.5", "text-neutral-600")} />
                ) : (
                  <LockIcon
                    className={cn(
                      "size-4.5",
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
                <div
                  role="menu"
                  aria-label="Safety mode"
                  ref={safeModeMenuRef}
                  onKeyDown={onSafeModeMenuKeyDown}
                  class="absolute top-8 -left-1 z-40 w-md rounded-lg border border-neutral-200 bg-white p-1 shadow-lg"
                >
                  {QUERY_SAFETY_MODES.map((mode) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={querySafetyMode === mode.value}
                      tabIndex={-1}
                      class={cn(
                        "flex w-full items-center gap-2 rounded-md",
                        "px-2 py-1.5 text-left hover:bg-neutral-100",
                        "outline-none focus-visible:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-blue-500",
                        querySafetyMode === mode.value && "bg-neutral-100"
                      )}
                      onClick={() => {
                        void setQuerySafetyMode(mode.value);
                        focusSafeModeTrigger();
                      }}
                    >
                      <div
                        class={cn("size-1 rounded-full p-1", mode.dotClass)}
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
              <DatabaseIcon className="size-4.5 text-neutral-600" />
            </IconButton>

            <ToolbarDivider />

            <Button
              variant="ghost"
              className="h-6 rounded-md border-none px-2 text-sm font-medium hover:bg-neutral-100 active:bg-neutral-200"
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
                "relative flex h-7.75 w-full items-center gap-2 overflow-hidden pr-2 pl-8",
                "rounded-lg border bg-white shadow-[0_1px_0_rgba(0,0,0,0.02)]",
                isConnectionError
                  ? "border-rose-200 bg-rose-50"
                  : "border-neutral-200 hover:border-neutral-300"
              )}
            >
              {(tags.env || tags.rest.length > 0) && (
                <div class="flex min-w-0 items-center gap-1">
                  <TagChips
                    tags={[...(tags.env ? [tags.env] : []), ...tags.rest]}
                    max={2}
                    size="sm"
                    className="gap-1 uppercase"
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
                        : isConnectionError
                          ? "bg-red-500"
                          : "bg-neutral-300"
                    )}
                  />
                  <span
                    class={cn(
                      "relative inline-flex size-2 rounded-full",
                      connected
                        ? "bg-emerald-500"
                        : isConnectionError
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
            title={
              !canBackupDatabase(rt.engine)
                ? "Backup is available for PostgreSQL, MySQL and MariaDB"
                : dbBackupRunning
                  ? "Backing up..."
                  : "Backup database"
            }
            onClick={() => void onBackupDatabase(connectionInfo?.database)}
            disabled={
              !rt.runtimeConnectionId ||
              !canBackupDatabase(rt.engine) ||
              dbBackupRunning ||
              dbRestoreRunning
            }
          >
            <BackupIcon className="size-4.5 text-neutral-700" />
          </IconButton>

          <IconButton
            title={dbRestoreRunning ? "Restoring..." : "Restore database"}
            onClick={() =>
              void onRestoreDatabase(onRefresh, connectionInfo?.database)
            }
            disabled={
              !!activeTab?.isLocked ||
              !rt.runtimeConnectionId ||
              dbBackupRunning ||
              dbRestoreRunning
            }
          >
            <RestoreIcon className="size-4.5 text-neutral-700" />
          </IconButton>

          <ToolbarDivider />

          <IconButton
            title={isRefreshing ? "Refreshing..." : "Refresh"}
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            <RefreshCwIcon
              className={cn(
                "size-5.5 text-neutral-700",
                isRefreshing && "animate-spin"
              )}
            />
          </IconButton>

          <IconButton title="Search" onClick={onSearchOpen}>
            <SearchIcon className="size-4.5 text-neutral-700" />
          </IconButton>

          <ToolbarDivider />

          <IconButton
            title="Database Health Inspector (Pro)"
            onClick={() => {
              if (requirePro("health-inspector")) onOpenHealthInspector?.();
            }}
            disabled={!rt.runtimeConnectionId || rt.engine !== "postgres"}
          >
            <DbInspectorIcon className="size-4.5 text-neutral-700" />
          </IconButton>

          <IconButton
            title="Generate Diagram"
            onClick={onOpenDiagram}
            disabled={!rt.runtimeConnectionId || rt.engine === "redis"}
          >
            <DiagramIcon className="size-4.5 text-neutral-700" />
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
        tabId={activeTab?.id}
        profileId={activeTab?.profileId}
        onOpenDatabase={onOpenDatabase}
        onClose={() => setDbDialogOpen(false)}
      />
    </>
  );
}
