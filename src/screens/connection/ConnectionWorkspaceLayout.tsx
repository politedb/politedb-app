import { SplitPane } from "src/components/SplitPane";
import { NavigationTabs } from "./NavigationTabs";
import { LeftNav } from "./LeftNav";
import { RightNav } from "./RightNav";
import { ActiveWindowContent } from "./ActiveWindowContent";
import { ConnectionBottomPanel } from "./ConnectionBottomPanel";
import type { Dispatch, StateUpdater } from "preact/hooks";
import type {
  DatabaseEngine,
  OpenWindow,
  TableItem,
  TableSizeInfo,
} from "src/types";
import type { SelectedRowDetail } from "src/stores/connection";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";

type ViewMode = Array<"left" | "right" | "bottom">;

export function ConnectionWorkspaceLayout(props: {
  viewMode: ViewMode;
  activeWindows: OpenWindow[];
  activeWindowId: string | null;
  selectWindow: (id: string) => void;
  activeProfileScreen: string;
  connectionProfileId: string | null;
  onInsertSnippet: (sql: string) => void | Promise<void>;
  engine: DatabaseEngine | undefined;
  schemasForEditor: string[];
  activeSchema: string;
  onSchemaChange: (schema: string) => void;
  tableSearchQuery: string;
  setTableSearchQuery: Dispatch<StateUpdater<string>>;
  expandedSections: { views: boolean; tables: boolean };
  setExpandedSections: Dispatch<
    StateUpdater<{ views: boolean; tables: boolean }>
  >;
  sidebarTables: TableItem[];
  filteredViews: TableItem[];
  activeTableDataSizeInfo: TableSizeInfo | null;
  selectedRowDetail: SelectedRowDetail | null;
  activeTableLoadKey: string | null;
  isProfileLocked: boolean;
}) {
  const {
    viewMode,
    activeWindows,
    activeWindowId,
    selectWindow,
    activeProfileScreen,
    connectionProfileId,
    onInsertSnippet,
    engine,
    schemasForEditor,
    activeSchema,
    onSchemaChange,
    tableSearchQuery,
    setTableSearchQuery,
    expandedSections,
    setExpandedSections,
    sidebarTables,
    filteredViews,
    activeTableDataSizeInfo,
    selectedRowDetail,
    activeTableLoadKey,
    isProfileLocked,
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

      <OverlayScrollArea
        className="min-h-0 flex-1"
        contentClassName="h-full min-h-0"
        horizontal
        vertical
      >
        <ActiveWindowContent />
      </OverlayScrollArea>
    </div>
  );

  const rightPane = (
    <div class="h-full overflow-hidden border-l border-neutral-200">
      <RightNav
        sizeInfo={activeTableDataSizeInfo}
        selectedRowDetail={selectedRowDetail}
        tableLoadKey={activeTableLoadKey}
        dataReadOnly={isProfileLocked}
      />
    </div>
  );

  const showBottom = viewMode.includes("bottom");
  const showLeft = viewMode.includes("left");
  const showRight = viewMode.includes("right");

  // Always keep SplitPanes mounted so toggling left/right/bottom does not
  // remount the main editor content (Objects / SQL state).
  const mainContent = (
    <SplitPane
      key="workspace-main-bottom"
      direction="vertical"
      initialRatio={0.7}
      minFirstPx={200}
      minSecondPx={150}
      splitterPx={2}
      fixedPaneOnResize="second"
      secondCollapsed={!showBottom}
      first={contentArea}
      second={
        <div class="h-full overflow-hidden border-t border-neutral-200">
          <ConnectionBottomPanel
            activeProfileScreen={activeProfileScreen}
            connectionProfileId={connectionProfileId}
          />
        </div>
      }
    />
  );

  const leftPane = (
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
        filteredViews={filteredViews}
        activeWindowId={activeWindowId}
        connectionProfileId={connectionProfileId}
        onInsertSnippet={onInsertSnippet}
      />
    </div>
  );

  return (
    <div class="flex h-full flex-1 overflow-hidden bg-neutral-100">
      <SplitPane
        key="workspace-with-left"
        direction="horizontal"
        initialRatio={0.15}
        minFirstPx={245}
        minSecondPx={300}
        splitterPx={2}
        fixedPaneOnResize="first"
        firstCollapsed={!showLeft}
        first={leftPane}
        second={
          <div class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-neutral-100">
            <SplitPane
              key="workspace-main-right"
              direction="horizontal"
              initialRatio={0.75}
              minFirstPx={300}
              minSecondPx={200}
              splitterPx={2}
              fixedPaneOnResize="second"
              secondCollapsed={!showRight}
              first={mainContent}
              second={rightPane}
            />
          </div>
        }
      />
    </div>
  );
}
