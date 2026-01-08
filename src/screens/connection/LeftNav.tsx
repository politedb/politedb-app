import { SetStateAction } from "preact/compat";
import { Dispatch } from "preact/hooks";
import {
  ChevronDown,
  ChevronRight,
  Search,
  Table,
} from "../../components/icons";
import { Button } from "../../components/common/Button";
import { Select } from "../../components/common/Select";
import { cn } from "../../utils/cn";
import { TableItem } from "../../types";

interface Props {
  schemas: string[];
  currSchema: string;
  onSchemaChange: (schema: string) => void;
  tableSearchQuery: string;
  setTableSearchQuery: Dispatch<SetStateAction<string>>;
  expandedSections: { functions: boolean; tables: boolean };
  setExpandedSections: Dispatch<
    SetStateAction<{ functions: boolean; tables: boolean }>
  >;
  filteredTables: TableItem[];
  handleSelectTable: (table: TableItem) => void;
  activeTableId: string | null;
}

export function LeftNav({
  schemas,
  currSchema,
  onSchemaChange,
  tableSearchQuery,
  setTableSearchQuery,
  expandedSections,
  setExpandedSections,
  filteredTables,
  handleSelectTable,
  activeTableId,
}: Props) {
  return (
    <div class="flex h-full w-64 shrink-0 flex-col bg-neutral-100 pt-1">
      {/* Search Bar */}
      <div class="border-b border-neutral-100 px-2 py-1">
        <div class="relative">
          <input
            type="text"
            placeholder="Search for item..."
            value={tableSearchQuery}
            onInput={(e: any) => setTableSearchQuery(e.currentTarget.value)}
            class="w-full rounded-md border border-neutral-200 bg-neutral-50 py-1 pr-8 pl-8 text-xs text-neutral-700 placeholder:text-neutral-500 focus:outline-none"
          />
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-neutral-500" />
        </div>
      </div>

      {/* Collapsible Sections */}
      <div class="flex-1 overflow-y-auto p-2">
        {/* Functions Section */}
        <Button
          variant="ghost"
          onClick={() =>
            setExpandedSections((prev) => ({
              ...prev,
              functions: !prev.functions,
            }))
          }
          className="w-full justify-start px-2"
        >
          {expandedSections.functions ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          <span>Functions</span>
        </Button>

        {/* Tables Section */}
        <div class="mt-1">
          <Button
            variant="ghost"
            onClick={() =>
              setExpandedSections((prev) => ({
                ...prev,
                tables: !prev.tables,
              }))
            }
            className="w-full justify-start px-2"
          >
            {expandedSections.tables ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            <span>Tables</span>
          </Button>

          {expandedSections.tables && (
            <div class="mt-1 space-y-0.5 pl-4">
              {filteredTables.length === 0 ? (
                <div class="px-3 py-2 text-xs text-neutral-500">
                  No tables found
                </div>
              ) : (
                filteredTables.map((table) => {
                  const key = `${table.schema}.${table.name}`;
                  return (
                    <Button
                      variant="ghost"
                      key={key}
                      onClick={() => handleSelectTable(table)}
                      active={activeTableId === key}
                      className="w-full justify-start gap-1.5 rounded-md px-3 py-1.5 text-sm"
                    >
                      <Table className="size-4" />
                      {table.name}
                    </Button>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>

      <div class="flex gap-1 px-2 py-2.5">
        <Button
          variant="shadow"
          className="size-6 border-neutral-300 bg-white p-2"
        >
          +
        </Button>
        <Select
          className={cn(
            "flex h-6 w-full border-neutral-300 text-center",
            "text-xs! font-medium! text-neutral-700 focus:border-neutral-300 focus:ring-0"
          )}
          defaultValue={currSchema}
          onChange={(e) => onSchemaChange(e.currentTarget.value)}
        >
          {schemas.map((schema) => (
            <option value={schema}>{schema}</option>
          ))}
        </Select>
      </div>
    </div>
  );
}
