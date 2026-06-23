import { SplitPane } from "src/components/SplitPane";
import { NavigationTabs } from "./NavigationTabs";
import { LeftNav } from "./LeftNav";
import { RightNav } from "./RightNav";
import { QueryHistory } from "./QueryHistory";
import { ActiveWindowContent } from "./ActiveWindowContent";
import type { Dispatch, StateUpdater } from "preact/hooks";
import type {
  DatabaseEngine,
  DatabaseObjectItem,
  OpenWindow,
  TableItem,
  TableSizeInfo,
} from "src/types";
import type { SelectedRowDetail } from "src/stores/connection";

type ViewMode = Array<"left" | "right" | "bottom">;

export function ConnectionWorkspaceLayout(props: {
  viewMode: ViewMode;
  activeWindows: OpenWindow[];
  activeWindowId: string | null;
  selectWindow: (id: string) => void;
  activeProfileScreen: string;
  engine: DatabaseEngine | undefined;
  schemasForEditor: string[];
  activeSchema: string;
  onSchemaChange: (schema: string) => void;
  tableSearchQuery: string;
  setTableSearchQuery: Dispatch<StateUpdater<string>>;
  expandedSections: { functions: boolean; tables: boolean };
  setExpandedSections: Dispatch<
    StateUpdater<{ functions: boolean; tables: boolean }>
  >;
  sidebarTables: TableItem[];
  filteredFunctions: DatabaseObjectItem[];
  rightNavTab: "ai" | "table-size" | "analytics";
  setRightNavTab: (tab: "ai" | "table-size" | "analytics") => void;
  activeTableDataSizeInfo: TableSizeInfo | null;
  selectedRowDetail: SelectedRowDetail | null;
  activeTableLoadKey: string | null;
  isProfileLocked: boolean;
  runtimeConnectionId: string | undefined;
  tables: TableItem[];
  columnsByTable: Record<string, string[]>;
  activeSqlContent: string | undefined;
  onInsertSqlIntoActiveEditor: (sql: string) => void | Promise<void>;
}) {
  const {
    viewMode,
    activeWindows,
    activeWindowId,
    selectWindow,
    activeProfileScreen,
    engine,
    schemasForEditor,
    activeSchema,
    onSchemaChange,
    tableSearchQuery,
    setTableSearchQuery,
    expandedSections,
    setExpandedSections,
    sidebarTables,
    filteredFunctions,
    rightNavTab,
    setRightNavTab,
    activeTableDataSizeInfo,
    selectedRowDetail,
    activeTableLoadKey,
    isProfileLocked,
    runtimeConnectionId,
    tables,
    columnsByTable,
    activeSqlContent,
    onInsertSqlIntoActiveEditor,
  } = props;

  const schemaLabel =
    engine === "mongo" || engine === "redis" ? "Database" : "Schema";
  const tablesSectionTitle =
    engine === "mongo"
      ? "Collections"
      : engine === "cassandra"
        ? "Tables"
        : engine === "redis"
          ? "Keys"
          : "Tables";

  const contentArea = (
    <div class="transition-smooth flex flex-1 flex-col overflow-hidden">
      {activeWindows.length > 0 && (
        <NavigationTabs
          openWindows={activeWindows}
          setActiveWindowId={(id) => selectWindow(id)}
          activeWindowId={activeWindowId}
        />
      )}

      <div class="flex-1 overflow-auto">
        <ActiveWindowContent />
      </div>
    </div>
  );

  const rightPane = (
    <div class="h-full overflow-hidden border-l border-neutral-200">
      <RightNav
        chatSessionKey={activeProfileScreen}
        activeTab={rightNavTab}
        onTabChange={setRightNavTab}
        sizeInfo={activeTableDataSizeInfo}
        selectedRowDetail={selectedRowDetail}
        tableLoadKey={activeTableLoadKey}
        dataReadOnly={isProfileLocked}
        engine={engine || "postgres"}
        runtimeConnectionId={runtimeConnectionId}
        activeSchema={activeSchema}
        tables={tables}
        columnsByTable={columnsByTable}
        currentSql={activeSqlContent}
        onInsertSql={onInsertSqlIntoActiveEditor}
      />
    </div>
  );

  const mainContent = viewMode.includes("bottom") ? (
    <SplitPane
      direction="vertical"
      initialRatio={0.7}
      minFirstPx={200}
      minSecondPx={150}
      splitterPx={2}
      fixedPaneOnResize="second"
      first={contentArea}
      second={
        <div class="h-full overflow-hidden border-t border-neutral-200">
          <QueryHistory activeProfileId={activeProfileScreen} />
        </div>
      }
    />
  ) : (
    contentArea
  );

  if (viewMode.includes("left")) {
    return (
      <div class="flex h-full flex-1 overflow-hidden">
        <SplitPane
          direction="horizontal"
          initialRatio={0.15}
          minFirstPx={200}
          minSecondPx={300}
          splitterPx={2}
          fixedPaneOnResize="first"
          first={
            <div class="h-full overflow-hidden">
              <LeftNav
                engine={engine}
                profileId={activeProfileScreen}
                schemas={schemasForEditor}
                currSchema={activeSchema}
                onSchemaChange={onSchemaChange}
                schemaLabel={schemaLabel}
                tablesSectionTitle={tablesSectionTitle}
                tableSearchQuery={tableSearchQuery}
                setTableSearchQuery={setTableSearchQuery}
                expandedSections={expandedSections}
                setExpandedSections={setExpandedSections}
                filteredTables={sidebarTables}
                filteredFunctions={filteredFunctions}
                activeWindowId={activeWindowId}
              />
            </div>
          }
          second={
            <div class="flex h-full flex-1 flex-col overflow-hidden bg-neutral-100">
              {viewMode.includes("right") ? (
                <SplitPane
                  direction="horizontal"
                  initialRatio={0.75}
                  minFirstPx={300}
                  minSecondPx={200}
                  splitterPx={2}
                  fixedPaneOnResize="second"
                  first={mainContent}
                  second={rightPane}
                />
              ) : (
                mainContent
              )}
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div class="flex h-full flex-1 overflow-hidden bg-neutral-100">
      {viewMode.includes("right") ? (
        <SplitPane
          direction="horizontal"
          initialRatio={0.75}
          minFirstPx={300}
          minSecondPx={200}
          splitterPx={2}
          fixedPaneOnResize="second"
          first={mainContent}
          second={rightPane}
        />
      ) : (
        mainContent
      )}
    </div>
  );
}
