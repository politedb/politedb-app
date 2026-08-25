import { Button } from "src/components/common/Button";

export type TableViewMode = "data" | "structure";

interface Props {
  viewMode: TableViewMode;
  onViewModeChange?: (mode: TableViewMode) => void;
}

export function TableViewToggle({ viewMode, onViewModeChange }: Props) {
  return (
    <div class="flex items-center rounded-md bg-neutral-100">
      <Button
        variant={viewMode === "data" ? "default" : "ghost"}
        onClick={() => onViewModeChange?.("data")}
        className="px-5 py-0.75 text-sm font-medium"
      >
        Data
      </Button>
      <Button
        variant={viewMode === "structure" ? "default" : "ghost"}
        onClick={() => onViewModeChange?.("structure")}
        className="px-3 py-0.75 text-sm font-medium"
      >
        Structure
      </Button>
    </div>
  );
}
