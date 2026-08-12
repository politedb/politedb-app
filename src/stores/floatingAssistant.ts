import { create } from "zustand";
import type { QuerySafetyMode } from "src/lib/queries/querySafety";
import type { AiColumnMetadata, DatabaseEngine, TableItem } from "src/types";

export type FloatingAssistantContext = {
  scopeKey: string;
  engine: DatabaseEngine;
  runtimeConnectionId?: string;
  activeSchema?: string;
  activeTable?: TableItem;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;
  columnDetailsByTable?: Record<string, AiColumnMetadata[]>;
  currentSql?: string;
  querySafetyMode?: QuerySafetyMode;
  onInsertSql?: (sql: string) => Promise<void> | void;
};

type FloatingAssistantState = {
  context: FloatingAssistantContext | null;
  setContext: (context: FloatingAssistantContext) => void;
  clearContext: (scopeKey: string) => void;
};

export const useFloatingAssistantStore = create<FloatingAssistantState>(
  (set) => ({
    context: null,
    setContext: (context) => set({ context }),
    clearContext: (scopeKey) =>
      set((state) =>
        state.context?.scopeKey === scopeKey ? { context: null } : state
      ),
  })
);
