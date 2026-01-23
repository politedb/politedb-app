// NewTableRoute.tsx
import { NewTablePane } from "src/components/table/NewTablePane";
import type { TableItem, DatabaseEngine } from "src/types";

export function NewTableRoute(props: {
  activeTableWindow: { id: string; table: TableItem };
  engine: DatabaseEngine;
  activeSchema: string;
  profileId: string;
  onCreated: (tableName: string) => Promise<void>;
  saveRef: { current: (() => Promise<void>) | null };
}) {
  const {
    activeTableWindow,
    engine,
    activeSchema,
    profileId,
    onCreated,
    saveRef,
  } = props;

  return (
    <NewTablePane
      engine={engine}
      activeSchema={activeSchema}
      table={activeTableWindow.table}
      activeProfileScreen={profileId}
      tableWindowId={activeTableWindow.id}
      onSuccess={onCreated}
      onSaveRef={(fn) => {
        saveRef.current = fn;
      }}
    />
  );
}
