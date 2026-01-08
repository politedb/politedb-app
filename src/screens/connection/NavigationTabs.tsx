import { Button } from "../../components/common/Button";
import { Table, X } from "../../components/icons";
import { OpenTable } from "../../types";
import { cn } from "../../utils/cn";

interface Props {
  openTables: OpenTable[];
  setActiveTableId: (id: string) => void;
  activeTableId: string | null;
  handleCloseTable: (id: string, e: MouseEvent) => void;
}

export function NavigationTabs({
  openTables,
  setActiveTableId,
  activeTableId,
  handleCloseTable,
}: Props) {
  return (
    <div
      class={cn(
        "flex items-center gap-0.5 overflow-x-auto border-b border-neutral-200 bg-neutral-100 pt-1",
        "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      )}
    >
      {openTables.map((openTable) => (
        <div
          key={openTable.id}
          onClick={() => setActiveTableId(openTable.id)}
          class={`group flex shrink-0 cursor-pointer items-center gap-2 rounded-t-md px-2 py-1.5 transition-colors ${
            activeTableId === openTable.id
              ? "bg-white text-neutral-700"
              : "bg-neutral-200 text-neutral-600 hover:bg-slate-200"
          }`}
        >
          <div class="flex items-center gap-2">
            <Table className="size-4" />
            <span
              class={cn(
                "text-xs",
                activeTableId === openTable.id
                  ? "font-bold text-neutral-700"
                  : "text-neutral-600"
              )}
            >
              {openTable.table.name}
            </span>
          </div>

          <Button
            variant="ghost"
            onClick={(e) => handleCloseTable(openTable.id, e)}
            class={`p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-neutral-100 ${
              activeTableId === openTable.id ? "opacity-100" : ""
            }`}
            title="Close table"
          >
            <X className="size-3.5 text-neutral-500" />
          </Button>
        </div>
      ))}
    </div>
  );
}
