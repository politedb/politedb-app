import { useMemo } from "preact/hooks";
import { useScreenStore } from "../../stores/screen";
import { useProfileStore } from "../../stores/profile";
import {
  Unlock,
  Database,
  RefreshCw,
  Search,
  MoreVertical,
  TabBottom,
  TabRight,
  TabLeft,
} from "../../components/icons";
import { cn } from "../../utils/cn";
import { pickHostDbUser } from "../../utils/connection";
import { Button } from "../../components/common/Button";
import { TabViewMode } from "../../types";

interface Props {
  activeSchema?: string;
  activeTable?: string;
  viewMode?: TabViewMode[];
  onViewModeChange?: (mode: TabViewMode) => void;
}

export function MenuBar({
  activeSchema,
  activeTable,
  viewMode = ["left"],
  onViewModeChange,
}: Props) {
  const { activeScreen, tabs } = useScreenStore();
  const activeTab = tabs.find((tab) => tab.id === activeScreen);
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
    if (!table) {
      return `LOCAL | ${engine} ${version} : ${database} : ${user}`;
    }
    return `LOCAL | ${engine} ${version} : ${database} : ${user} : ${schema}.${table}`;
  }, [connectionInfo]);

  return (
    <div class="flex h-12 items-center gap-2 border-b border-neutral-200 bg-white px-2">
      {/* Left Icons */}
      <div class="mr-30 flex items-center gap-2">
        <Button
          variant="ghost"
          class="p-2 hover:bg-neutral-100"
          disabled
          title="Unlock"
        >
          <Unlock className="size-4 text-neutral-600" />
        </Button>
        <Button
          variant="ghost"
          class="p-2 hover:bg-neutral-100"
          disabled
          title="Database"
        >
          <Database className="size-4 text-neutral-600" />
        </Button>
        <Button variant="ghost" class="p-2 hover:bg-neutral-100" disabled>
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
            "h-8 w-full rounded-md border border-neutral-200 bg-neutral-50 px-3",
            "text-xs font-semibold text-neutral-700 focus:outline-none"
          )}
          placeholder="No connection"
        />
      </div>

      {/* Right Icons */}
      <div class="flex items-center gap-2">
        <Button
          variant="ghost"
          class="p-2 hover:bg-neutral-100"
          title="Refresh"
        >
          <RefreshCw className="size-4 text-neutral-600" />
        </Button>
        <Button variant="ghost" class="p-2 hover:bg-neutral-100" title="Search">
          <Search className="size-4 text-neutral-600" />
        </Button>
        <Button
          variant="ghost"
          class="p-2 hover:bg-neutral-100"
          title="More Options"
        >
          <MoreVertical className="size-4 text-neutral-600" />
        </Button>
        {/* View Mode Icons */}
        <div class="ml-1 flex items-center gap-0.5">
          <Button
            variant="ghost"
            class={cn(
              "p-2 transition-colors",
              viewMode.includes("left")
                ? "bg-blue-50 text-blue-600 hover:bg-blue-100"
                : "hover:bg-neutral-100"
            )}
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
            class={cn(
              "p-2 transition-colors",
              viewMode.includes("bottom")
                ? "bg-blue-50 text-blue-600 hover:bg-blue-100"
                : "hover:bg-neutral-100"
            )}
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
            class={cn(
              "p-2 transition-colors",
              viewMode.includes("right")
                ? "bg-blue-50 text-blue-600 hover:bg-blue-100"
                : "hover:bg-neutral-100"
            )}
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
