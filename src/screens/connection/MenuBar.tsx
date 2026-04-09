import { useCallback, useMemo, useState } from "preact/hooks";
import { useScreenStore } from "src/stores/screen";
import { useProfileStore } from "src/stores/profile";
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
  ChatIcon,
  SchemaIcon,
} from "src/components/icons";
import { cn } from "src/utils/cn";
import { pickHostDbUser } from "src/utils/connection";
import { Button } from "src/components/common/Button";
import { TabViewMode } from "src/types";
import { TagChips } from "src/components/common/TagChips";
import { formatDatabaseVersion, normalizeEngineName } from "src/utils/convert";
import { DatabaseManagerDialog } from "./DatabaseManagerDialog";
import { canManageDatabases } from "src/hooks/useDatabases";
import { connectionCreate } from "src/lib/tauri";
import type { ConnectionCreateInput } from "src/lib/tauri";
import { v4 as uuid } from "uuid";
import { useConnectionRuntimeCtx } from "./ConnectionRuntimeContext";
import { ErrorDialog } from "src/components/modal/ErrorDialog";
import { useDatabaseBackup } from "./hooks/useDatabaseBackup";

interface Props {
  activeSchema?: string;
  activeTable?: string;
  activeRightPanelTab?: "ai" | "table-size";
  isRightPanelOpen?: boolean;
  connectionVersion?: string;
  schemas?: string[];
  viewMode?: TabViewMode[];
  loadTableError?: string | null;
  onSchemaChange?: (schema: string) => void;
  onViewModeChange?: (mode: TabViewMode) => void;
  openSQLWindow?: () => void;
  onRefresh?: () => void;
  onSearchOpen?: () => void;
  onOpenAiAssistant?: () => void;
  onOpenDiagram?: () => void;
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
        "h-7 w-7 rounded-md p-0",
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
  const isDev = t.includes("DEV") || t.includes("LOCAL");

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

function MetaPill({
  text,
  className,
  tone = "neutral",
}: {
  text: string;
  className?: string;
  tone?: "neutral" | "blue";
}) {
  if (!text) return null;

  const cls =
    tone === "blue"
      ? "bg-blue-50 text-blue-700 border-blue-200/70"
      : "bg-neutral-50 text-neutral-600 border-neutral-200";

  return (
    <span
      class={cn(
        "inline-flex h-5 items-center rounded-md border px-1.5 text-xs font-semibold",
        cls,
        className
      )}
    >
      {text}
    </span>
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

  throw new Error("ENGINE_NOT_SUPPORTED_FOR_OPEN_DATABASE");
}

export function MenuBar({
  activeSchema,
  activeTable,
  activeRightPanelTab,
  isRightPanelOpen = false,
  connectionVersion: databaseVersion = "",
  viewMode = ["left"],
  loadTableError,
  onViewModeChange,
  onRefresh,
  openSQLWindow,
  onSearchOpen,
  onOpenAiAssistant,
  onOpenDiagram,
}: Props) {
  const rt = useConnectionRuntimeCtx();

  const [dbDialogOpen, setDbDialogOpen] = useState(false);

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

  const profile = useMemo(() => {
    if (!activeTab?.profileId) return null;
    return getProfileById(activeTab.profileId);
  }, [activeTab, getProfileById]);

  const connectionInfo = useMemo(() => {
    if (!profile) return null;
    const { database, user } = pickHostDbUser(profile);

    const isSsh = Boolean(profile?.input?.ssh?.enabled);

    return {
      engine: profile.engine,
      version: databaseVersion,
      database,
      user,
      schema: activeSchema || database || "",
      table: activeTable || "",
      isSsh,
    };
  }, [profile, activeSchema, activeTable, databaseVersion]);

  const connected = !!connectionInfo && !loadTableError;
  const runtimeConnectionId = activeTab?.runtimeConnectionId ?? "";
  const canOpenSql =
    connectionInfo?.engine !== "mongo" && connectionInfo?.engine !== "redis";

  const tags = useMemo(() => {
    const raw = (profile?.input?.tags ?? []).map(String);
    return classifyTags(raw);
  }, [profile]);

  const dbLabel = useMemo(() => {
    if (!connectionInfo) return { db: "", target: "" };
    const { database, schema, table, engine } = connectionInfo;

    return {
      db: database,
      target: table
        ? engine === "postgres"
          ? `${schema}.${table}`
          : table
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

    return [pretty, version].filter(Boolean).join(" ");
  }, [connectionInfo]);

  const onOpenDatabase = useCallback(
    async (nextDb: string) => {
      if (!activeTab?.profileId || !profile) {
        throw new Error("PROFILE_NOT_FOUND");
      }

      if (!nextDb || nextDb === connectionInfo?.database) return;

      const nextInput = withDatabaseInput(profile.input, nextDb);
      const conn = await connectionCreate(nextInput);

      const nextTabId = `tab-${uuid()}`;
      addTab({
        id: nextTabId,
        label: `${profile.label} · ${nextDb}`,
        engine: profile.engine,
        runtimeConnectionId: conn.id,
        profileId: profile.id,
      });
      setActiveProfileScreen(nextTabId);
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
      <div class="flex h-10 items-center gap-2 border-b border-neutral-200 bg-neutral-50/80 px-2 select-none">
        <div class="flex items-center">
          <div class="flex items-center gap-1 rounded-lg border border-neutral-200 bg-white px-1 py-0.5 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
            <IconButton
              className="size-6"
              title={activeTab?.isLocked ? "Unlock" : "Lock"}
              onClick={(e: any) => {
                e.stopPropagation();
                if (!activeTab) return;
                updateTab(activeTab.id, { isLocked: !activeTab.isLocked });
              }}
            >
              {activeTab?.isLocked ? (
                <LockIcon className="size-4 text-neutral-600" />
              ) : (
                <UnlockIcon className="size-4 text-neutral-600" />
              )}
            </IconButton>

            <IconButton
              className="size-6"
              title="Database"
              disabled={
                activeTab?.isLocked ||
                !runtimeConnectionId ||
                !canManageDatabases(connectionInfo?.engine)
              }
              onClick={() => setDbDialogOpen(true)}
            >
              <DatabaseIcon className="size-4 text-neutral-600" />
            </IconButton>

            <ToolbarDivider />

            <Button
              variant="ghost"
              className="h-6 rounded-md px-2 text-xs font-medium hover:bg-neutral-100 active:bg-neutral-200"
              disabled={!canOpenSql}
              onClick={openSQLWindow}
            >
              SQL
            </Button>
          </div>
        </div>

        <div class="flex min-w-0 flex-1 items-center justify-center">
          <div class="w-full max-w-220 min-w-0">
            <div
              class={cn(
                "flex h-7 w-full items-center gap-2 rounded-lg border bg-white px-2",
                loadTableError
                  ? "border-red-300"
                  : "border-neutral-200 hover:border-neutral-300",
                "shadow-[0_1px_0_rgba(0,0,0,0.02)]"
              )}
            >
              <div
                class={cn(
                  "h-2 w-2 rounded-full",
                  connected
                    ? "bg-emerald-500"
                    : loadTableError
                      ? "bg-red-500"
                      : "bg-neutral-300"
                )}
              />

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
                  <span class="text-xs font-semibold text-neutral-800">
                    {dbLabel.db}
                  </span>
                  <ChevronRightIcon className="size-2" />
                  <span class="text-xs font-medium text-neutral-600">
                    {dbLabel.target}
                  </span>
                </div>
              ) : (
                <div class="text-xs text-neutral-500">No connection</div>
              )}

              {connectionInfo && (
                <div class="flex items-center gap-1">
                  <div class="mx-1 h-4 w-px bg-neutral-200" />
                  <MetaPill text={engineLabel} />
                  {connectionInfo.isSsh ? (
                    <MetaPill text="SSH" tone="blue" />
                  ) : null}
                </div>
              )}
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

          <IconButton title="Refresh" onClick={onRefresh}>
            <RefreshCwIcon className="size-4.5 text-neutral-700" />
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

          <IconButton title="AI Assistant" onClick={onOpenAiAssistant}>
            <ChatIcon
              className={cn(
                "size-4 transition-colors",
                isRightPanelOpen && activeRightPanelTab === "ai"
                  ? "text-blue-600"
                  : "text-neutral-700"
              )}
            />
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
        />
      )}
    </>
  );
}
