import { Button } from "src/components/common/Button";

export type TableViewMode = "data" | "structure";

interface Props {
  viewMode: TableViewMode;
  onViewModeChange?: (mode: TableViewMode) => void;
}

export function TableViewToggle({ viewMode, onViewModeChange }: Props) {
  return (
    <div class="flex items-center gap-0.5 rounded-md bg-neutral-100 p-0.5">
      <Button
        variant={viewMode === "data" ? "default" : "ghost"}
        onClick={() => onViewModeChange?.("data")}
        className="px-3 py-1"
      >
        Data
      </Button>
      <Button
        variant={viewMode === "structure" ? "default" : "ghost"}
        onClick={() => onViewModeChange?.("structure")}
        className="px-3 py-1"
      >
        Structure
      </Button>
    </div>
  );
}
