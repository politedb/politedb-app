import { useCallback, useState } from "preact/hooks";
import type { TabViewMode } from "src/types";

export function useViewMode(initial: TabViewMode[] = ["left"]) {
  const [viewMode, setViewMode] = useState<TabViewMode[]>(initial);

  const toggleViewMode = useCallback((mode: TabViewMode) => {
    setViewMode((prev) =>
      prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode]
    );
  }, []);

  return { viewMode, toggleViewMode, setViewMode };
}
