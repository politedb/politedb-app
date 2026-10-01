import { SetStateAction } from "preact/compat";
import { Dispatch, useState } from "preact/hooks";
import { LeftNavSnippetsPane } from "./LeftNavSnippetsPane";
import { LeftNavObjectsPane } from "./LeftNavObjectsPane";
import { LeftNavItemsPane } from "./LeftNavItemsPane";
import { cn } from "src/utils/cn";
import type { DatabaseEngine, TableItem } from "src/types";

interface Props {
  engine?: DatabaseEngine;
  profileId: string;
  schemas: string[];
  currSchema: string;
  onSchemaChange: (schema: string) => void;
  /** e.g. "Database" for Mongo, "Schema" for SQL engines */
  schemaLabel?: string;
  /** e.g. "Collections" for Mongo, "Tables" for SQL engines */
  tablesSectionTitle?: string;

  tableSearchQuery: string;
  setTableSearchQuery: Dispatch<SetStateAction<string>>;

  expandedSections: { views: boolean; tables: boolean };
  setExpandedSections: Dispatch<
    SetStateAction<{ views: boolean; tables: boolean }>
  >;

  filteredTables: TableItem[];
  filteredViews: TableItem[];
  activeWindowId: string | null;
  connectionProfileId: string | null;
  onInsertSnippet: (sql: string) => void | Promise<void>;
}

type LeftNavTab = "items" | "snippets" | "objects";

function LeftNavTabButton(props: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  const { active, onClick, label } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      class={cn(
        "min-w-0 flex-1 rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-white text-neutral-800 shadow-sm"
          : "text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-800 dark:hover:bg-neutral-900/40! dark:hover:text-neutral-200!"
      )}
    >
      {label}
    </button>
  );
}

export function LeftNav({
  engine,
  profileId,
  schemas,
  currSchema,
  onSchemaChange,
  schemaLabel = "Schema",
  tablesSectionTitle = "Tables",
  tableSearchQuery,
  setTableSearchQuery,
  expandedSections,
  setExpandedSections,
  filteredTables,
  filteredViews,
  activeWindowId,
  connectionProfileId,
  onInsertSnippet,
}: Props) {
  const [leftTab, setLeftTab] = useState<LeftNavTab>("items");

  return (
    <aside
      data-density-region="sidebar"
      class={cn(
        "flex h-full w-full flex-col",
        "border-r border-neutral-200 bg-slate-50"
      )}
    >
      <div class="shrink-0 px-2 pt-2">
        <div class="flex items-center gap-0.5 rounded-lg bg-neutral-200/70 p-0.5">
          <LeftNavTabButton
            active={leftTab === "items"}
            onClick={() => setLeftTab("items")}
            label="Items"
          />
          <LeftNavTabButton
            active={leftTab === "objects"}
            onClick={() => setLeftTab("objects")}
            label="Objects"
          />
          <LeftNavTabButton
            active={leftTab === "snippets"}
            onClick={() => setLeftTab("snippets")}
            label="Snippets"
          />
        </div>
      </div>

      {leftTab === "items" ? (
        <LeftNavItemsPane
          engine={engine}
          profileId={profileId}
          schemas={schemas}
          currSchema={currSchema}
          onSchemaChange={onSchemaChange}
          schemaLabel={schemaLabel}
          tablesSectionTitle={tablesSectionTitle}
          tableSearchQuery={tableSearchQuery}
          setTableSearchQuery={setTableSearchQuery}
          expandedSections={expandedSections}
          setExpandedSections={setExpandedSections}
          filteredTables={filteredTables}
          filteredViews={filteredViews}
          activeWindowId={activeWindowId}
        />
      ) : leftTab === "snippets" ? (
        <LeftNavSnippetsPane
          profileId={connectionProfileId}
          onInsert={onInsertSnippet}
        />
      ) : (
        <LeftNavObjectsPane profileId={profileId} />
      )}
    </aside>
  );
}
