import { useCallback, useMemo, useState } from "preact/hooks";
import { useScreenStore } from "src/stores/screen";
import { useProfileStore } from "src/stores/profile";
import {
  Unlock,
  Database,
  RefreshCw,
  Search,
  TabBottom,
  TabRight,
  TabLeft,
} from "src/components/icons";
import { cn } from "src/utils/cn";
import { pickHostDbUser } from "src/utils/connection";
import { Button } from "src/components/common/Button";
import { TabViewMode } from "src/types";
import { TagChips } from "src/components/common/TagChips";
import { normalizeEngineName } from "src/utils/convert";
import { DatabaseManagerDialog } from "./DatabaseManagerDialog";
import { canManageDatabases } from "src/hooks/useDatabases";
import { connectionCreate } from "src/lib/tauri";
import type { ConnectionCreateInput } from "src/lib/tauri";
import { v4 as uuid } from "uuid";

interface Props {
  activeSchema?: string;
  activeTable?: string;
  viewMode?: TabViewMode[];
  loadTableError?: string | null;
  onViewModeChange?: (mode: TabViewMode) => void;
  openSQLWindow?: () => void;
  onRefresh?: () => void;
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
    ? "bg-red-50 text-red-700"
    : isStaging
      ? "bg-amber-50 text-amber-700"
      : isDev
        ? "bg-emerald-50 text-emerald-700"
        : "bg-neutral-100 text-neutral-600";

  return (
    <span class={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold", cls)}>
      {t}
    </span>
  );
}

function MetaPill({
  text,
  tone = "neutral",
}: {
  text: string;
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
        "inline-flex h-5 items-center rounded-md border px-1.5 text-[10px] font-semibold",
        cls
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

  if (input.engine === "mysql") {
    if (!input.mysql) throw new Error("MYSQL_CONFIG_MISSING");
    return {
      ...input,
      mysql: {
        ...input.mysql,
        database,
      },
    };
  }

  throw new Error("ENGINE_NOT_SUPPORTED_FOR_OPEN_DATABASE");
}

export function MenuBar({
  activeSchema,
  activeTable,
  viewMode = ["left"],
  loadTableError,
  onViewModeChange,
  onRefresh,
  openSQLWindow,
}: Props) {
  const getProfileById = useProfileStore((s) => s.getProfileById);
  const { activeProfileScreen, profileTabs, addTab, setActiveProfileScreen } =
    useScreenStore();
  const activeTab = profileTabs.find((tab) => tab.id === activeProfileScreen);

  const [dbDialogOpen, setDbDialogOpen] = useState(false);

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
      version: "16.3", // TODO: fetch from connection
      database,
      user,
      schema: activeSchema || "public",
      table: activeTable || "",
      isSsh,
    };
  }, [profile, activeSchema, activeTable]);

  const connected = !!connectionInfo && !loadTableError;
  const runtimeConnectionId = activeTab?.runtimeConnectionId ?? "";

  const tags = useMemo(() => {
    const raw = (profile?.input?.tags ?? []).map(String);
    return classifyTags(raw);
  }, [profile]);

  const dbLabel = useMemo(() => {
    if (!connectionInfo) return { db: "", target: "" };
    const { database, schema, table } = connectionInfo;
    return {
      db: database,
      target: table ? `${schema}.${table}` : schema,
    };
  }, [connectionInfo]);

  const engineLabel = useMemo(() => {
    if (!connectionInfo) return "";

    const pretty = normalizeEngineName(connectionInfo.engine || "postgres", {
      upper: true,
    });

    return `${pretty} ${connectionInfo.version}`;
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
            <IconButton disabled title="Unlock">
              <Unlock className="size-4 text-neutral-600" />
            </IconButton>

            <IconButton
              title="Database"
              disabled={
                !runtimeConnectionId ||
                !canManageDatabases(connectionInfo?.engine)
              }
              onClick={() => setDbDialogOpen(true)}
            >
              <Database className="size-4 text-neutral-600" />
            </IconButton>

            <ToolbarDivider />

            <Button
              variant="ghost"
              className="h-7 rounded-md px-2 text-xs font-medium hover:bg-neutral-100 active:bg-neutral-200"
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
                <div class="min-w-0 flex-1 truncate">
                  <span class="text-xs font-semibold text-neutral-800">
                    {dbLabel.db}
                  </span>
                  <span class="mx-1 text-neutral-400">›</span>
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

          <IconButton title="Refresh" onClick={onRefresh}>
            <RefreshCw className="size-4.5 text-neutral-700" />
          </IconButton>

          <IconButton title="Search">
            <Search className="size-4 text-neutral-700" />
          </IconButton>

          <ToolbarDivider />

          <div class="flex h-7 items-center rounded-lg border border-neutral-200 bg-neutral-50 p-0.5">
            <SegButton
              title="Tab Left"
              onClick={() => onViewModeChange?.("left")}
            >
              <TabLeft
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
              <TabBottom
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
              <TabRight
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
    </>
  );
}
