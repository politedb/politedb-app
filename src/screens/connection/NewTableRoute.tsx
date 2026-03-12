// NewTableRoute.tsx
import { NewTablePane } from "src/components/table/NewTablePane";
import type { TableItem, DatabaseEngine } from "src/types";

export function NewTableRoute(props: {
  activeTableWindow: { id: string; table: TableItem };
  engine: DatabaseEngine;
  activeSchema: string;
  profileId: string;
  isProfileLocked?: boolean;
  onCreated: (tableName: string) => Promise<void>;
  saveRef: { current: (() => Promise<void>) | null };
}) {
  const {
    activeTableWindow,
    engine,
    activeSchema,
    profileId,
    isProfileLocked = false,
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
      isProfileLocked={isProfileLocked}
      onSuccess={onCreated}
      onSaveRef={(fn) => {
        saveRef.current = fn;
      }}
    />
  );
}
