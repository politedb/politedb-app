import { useMemo } from "preact/hooks";
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
  SaveIcon,
} from "src/components/icons";
import { cn } from "src/utils/cn";
import { pickHostDbUser } from "src/utils/connection";
import { Button } from "src/components/common/Button";
import { TabViewMode } from "src/types";

interface Props {
  activeSchema?: string;
  activeTable?: string;
  viewMode?: TabViewMode[];
  loadTableError?: string | null;
  canSaveChanges?: boolean;
  onViewModeChange?: (mode: TabViewMode) => void;
  openSQLWindow?: () => void;
  onRefresh?: () => void;
  handleSaveChanges?: () => void;
}

export function MenuBar({
  activeSchema,
  activeTable,
  viewMode = ["left"],
  loadTableError,
  canSaveChanges,
  onViewModeChange,
  onRefresh,
  openSQLWindow,
  handleSaveChanges,
}: Props) {
  const { activeProfileScreen, profileTabs } = useScreenStore();
  const activeTab = profileTabs.find((tab) => tab.id === activeProfileScreen);
  const { getProfileById } = useProfileStore();

  const profile = useMemo(() => {
    if (!activeTab?.profileId) return null;
    return getProfileById(activeTab.profileId);
  }, [activeTab, getProfileById]);

  const connectionInfo = useMemo(() => {
    if (!profile) return null;
    const { database, user } = pickHostDbUser(profile);
    return {
      engine: profile.engine,
      version: "16.3", // TODO: Get actual version from connection
      database,
      user,
      schema: activeSchema || "public",
      table: activeTable || "",
    };
  }, [profile, activeSchema, activeTable]);

  const connectionString = useMemo(() => {
    if (!connectionInfo) return "";
    const { engine, version, database, user, schema, table } = connectionInfo;
    const tags = profile?.input?.tags ?? [];
    const tagsString = tags.join(",").toUpperCase();

    if (!table) {
      return `${tagsString} | ${engine} ${version} : ${database} : ${user}`;
    }
    return `${tagsString} | ${engine} ${version} : ${database} : ${user} : ${schema}.${table}`;
  }, [connectionInfo, profile]);

  return (
    <div class="flex h-12 items-center gap-2 border-b border-neutral-200 bg-white px-2">
      {/* Left Icons */}
      <div class="mr-30 flex items-center gap-2">
        <Button
          variant="ghost"
          className="p-2 hover:bg-neutral-50"
          disabled
          title="Unlock"
        >
          <Unlock className="size-4 text-neutral-600" />
        </Button>
        <Button
          variant="ghost"
          className="p-2 hover:bg-neutral-50"
          disabled
          title="Database"
        >
          <Database className="size-4 text-neutral-600" />
        </Button>
        <Button
          variant="ghost"
          className="p-2 hover:bg-neutral-50"
          onClick={openSQLWindow}
        >
          <span class="text-xs font-medium text-neutral-600">SQL</span>
        </Button>
      </div>

      {/* Center Connection Info */}
      <div class="flex-1">
        <input
          type="text"
          value={connectionString}
          readOnly
          class={cn(
            "h-8 w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3",
            "text-xs font-semibold text-neutral-700 focus:outline-none",
            loadTableError && "border-red-300 bg-red-300/80"
          )}
          placeholder="No connection"
        />
      </div>

      {/* Right Icons */}
      <div class="flex items-center gap-2">
        {canSaveChanges && (
          <Button
            variant="ghost"
            className="p-2 hover:bg-neutral-50"
            title={"Save Changes"}
            onClick={handleSaveChanges}
          >
            <SaveIcon className="size-4.5 text-blue-600" />
          </Button>
        )}
        <Button
          variant="ghost"
          className="p-1.5 hover:bg-neutral-50"
          title="Refresh"
          onClick={onRefresh}
        >
          <RefreshCw className="size-5 text-neutral-600" />
        </Button>
        <Button
          variant="ghost"
          className="p-2 hover:bg-neutral-50"
          title="Search"
        >
          <Search className="size-4 text-neutral-600" />
        </Button>

        {/* View Mode Icons */}
        <div class="ml-1 flex items-center gap-0.5">
          <Button
            variant="ghost"
            className={cn("p-2 transition-colors hover:bg-neutral-50")}
            title="Tab Left"
            onClick={() => onViewModeChange?.("left")}
          >
            <TabLeft
              className={cn(
                "size-4 transition-colors",
                viewMode.includes("left") ? "text-blue-600" : "text-neutral-600"
              )}
            />
          </Button>
          <Button
            variant="ghost"
            className={cn("p-2 transition-colors hover:bg-neutral-50")}
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
          </Button>
          <Button
            variant="ghost"
            className={cn("p-2 transition-colors hover:bg-neutral-50")}
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
          </Button>
        </div>
      </div>
    </div>
  );
}
