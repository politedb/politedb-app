import { Button } from "src/components/common/Button";

export type TableViewMode = "data" | "structure";

interface Props {
  viewMode: TableViewMode;
  onViewModeChange?: (mode: TableViewMode) => void;
}

const MODES: { mode: TableViewMode; label: string }[] = [
  { mode: "data", label: "Data" },
  { mode: "structure", label: "Structure" },
];

export function TableViewToggle({ viewMode, onViewModeChange }: Props) {
  return (
    <div
      role="group"
      aria-label="Table view"
      class="flex items-center rounded-md bg-neutral-100"
    >
      {MODES.map(({ mode, label }) => (
        <Button
          key={mode}
          variant={viewMode === mode ? "default" : "ghost"}
          aria-pressed={viewMode === mode}
          onClick={() => onViewModeChange?.(mode)}
          className="px-4 py-0.75 text-sm font-medium"
        >
          {label}
        </Button>
      ))}
    </div>
  );
}
