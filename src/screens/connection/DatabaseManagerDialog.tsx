import { Button } from "src/components/common/Button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Input } from "src/components/common/Input";
import { Database, Search } from "src/components/icons";
import type { DatabaseEngine } from "src/types";
import { cn } from "src/utils/cn";
import { useCallback, useEffect, useState } from "preact/hooks";
import { canManageDatabases, useDatabases } from "src/hooks/useDatabases";
import { DatabaseEditorDialog } from "./DatabaseEditorDialog";
import { ContextMenu, MenuItem } from "src/components/common/ContextMenu";

type MenuState = {
  x: number;
  y: number;
  dbName: string;
};

interface Props {
  open: boolean;
  engine?: DatabaseEngine;
  runtimeConnectionId?: string;
  onOpenDatabase?: (dbName: string) => Promise<void>;
  onClose: () => void;
}

export function DatabaseManagerDialog({
  open,
  engine,
  runtimeConnectionId,
  onOpenDatabase,
  onClose,
}: Props) {
  const [menuState, setMenuState] = useState<MenuState | null>(null);
  const [dropConfirmDb, setDropConfirmDb] = useState<string | null>(null);
  const [dropConfirmName, setDropConfirmName] = useState("");

  const {
    search,
    selectedDb,
    busy,
    error,
    editorMode,
    nameDraft,
    visibleDbs,
    setSearch,
    setSelectedDb,
    setEditorMode,
    setNameDraft,
    onCreateDb,
    onRenameDb,
    onDropDbByName,
    onOpenDb,
  } = useDatabases({
    open,
    engine,
    runtimeConnectionId,
    onOpenDatabase,
  });

  const closeEditor = () => {
    setEditorMode(null);
    setNameDraft("");
  };

  useEffect(() => {
    if (open) return;
    setDropConfirmDb(null);
    setDropConfirmName("");
  }, [open]);

  const dbMenuItems: MenuItem[] = [
    {
      type: "item",
      label: "Open",
      onClick: () => {
        if (!menuState) return;
        setSelectedDb(menuState.dbName);
        setMenuState(null);
      },
    },
    { type: "sep" },
    {
      type: "item",
      label: "Copy name",
      onClick: () => {
        if (!menuState) return;
        navigator.clipboard.writeText(menuState.dbName);
      },
    },
    { type: "sep" },
    {
      type: "item",
      label: "New...",
      onClick: () => {
        setEditorMode("create");
        setNameDraft("");
      },
    },
    {
      type: "item",
      label: "Rename...",
      onClick: () => {
        if (!menuState) return;
        setSelectedDb(menuState.dbName);
        setEditorMode("rename");
        setNameDraft(menuState.dbName);
        setMenuState(null);
      },
    },
    { type: "sep" },
    {
      type: "item",
      label: "Drop...",
      onClick: () => {
        if (!menuState) return;
        setSelectedDb(menuState.dbName);
        setDropConfirmDb(menuState.dbName);
        setDropConfirmName("");
        setMenuState(null);
      },
    },
  ];

  const handleOpenDatabase = useCallback(async () => {
    if (!selectedDb) return false;
    const ok = await onOpenDb();
    if (ok) onClose();
  }, [selectedDb, onOpenDb, onClose]);

  return (
    <Dialog open={open} size="sm" onClose={onClose}>
      <DialogHeader>
        <DialogTitle>Open database</DialogTitle>
      </DialogHeader>
      <DialogContent className="gap-3 pt-0">
        <Input
          value={search}
          placeholder="Search for database..."
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          className="h-10 rounded-lg border border-neutral-300 text-sm"
          left={<Search className="size-5 text-neutral-500" />}
        />

        {!canManageDatabases(engine) && (
          <div class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Database management is not supported for this engine.
          </div>
        )}

        {error && (
          <div class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div class="min-h-80 gap-4">
          <div class="flex flex-col gap-1.5 overflow-auto rounded-lg">
            {visibleDbs.length === 0 ? (
              <div class="px-2 py-4 text-sm text-neutral-500">No databases</div>
            ) : (
              visibleDbs.map((dbName) => (
                <Button
                  variant={selectedDb === dbName ? "default" : "ghost"}
                  className="justify-start px-2 py-1.5 text-sm"
                  key={dbName}
                  onClick={() => setSelectedDb(dbName)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSelectedDb(dbName);
                    setMenuState({
                      x: e.clientX,
                      y: e.clientY,
                      dbName,
                    });
                  }}
                  onDblClick={handleOpenDatabase}
                >
                  <Database
                    className={cn(
                      "size-5 text-blue-500",
                      selectedDb === dbName && "text-blue-200"
                    )}
                  />
                  <span>{dbName}</span>
                </Button>
              ))
            )}
          </div>
        </div>
      </DialogContent>
      <DialogFooter className="justify-between">
        <Button variant="shadow" className="py-1.5" onClick={onClose}>
          Cancel
        </Button>

        <div class="flex gap-2">
          <Button
            variant="shadow"
            className="py-1.5"
            onClick={() => {
              setEditorMode("create");
              setNameDraft("");
            }}
            disabled={busy || !canManageDatabases(engine)}
          >
            New...
          </Button>

          <Button
            variant="default"
            className="border border-blue-500 py-1.5"
            onClick={() => {
              void handleOpenDatabase();
            }}
            loading={busy}
            disabled={busy || !selectedDb || !onOpenDatabase}
          >
            Open
          </Button>
        </div>
      </DialogFooter>

      <ContextMenu
        open={menuState !== null}
        x={menuState?.x ?? 0}
        y={menuState?.y ?? 0}
        onClose={() => setMenuState(null)}
        items={dbMenuItems}
      />

      {editorMode && (
        <DatabaseEditorDialog
          open={true}
          mode={editorMode}
          busy={busy}
          nameDraft={nameDraft}
          setNameDraft={setNameDraft}
          onClose={closeEditor}
          onSave={editorMode === "create" ? onCreateDb : onRenameDb}
        />
      )}

      <Dialog
        open={dropConfirmDb !== null}
        size="xs"
        onClose={() => {
          setDropConfirmDb(null);
          setDropConfirmName("");
        }}
      >
        <DialogHeader>
          <DialogTitle>Drop database '{dropConfirmDb ?? ""}'</DialogTitle>
        </DialogHeader>
        <DialogContent className="py-1">
          <p className="text-sm text-neutral-800">
            Permanently drop the database <strong>{dropConfirmDb ?? ""}</strong>
            ? This cannot be undone.
          </p>
          <p className="text-xs text-neutral-600">
            Enter <strong>{dropConfirmDb ?? ""}</strong> to confirm.
          </p>
          <Input
            value={dropConfirmName}
            onInput={(e) =>
              setDropConfirmName((e.target as HTMLInputElement).value)
            }
            placeholder={dropConfirmDb ?? ""}
            className="h-9 rounded-lg border border-neutral-300 text-sm"
          />
        </DialogContent>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setDropConfirmDb(null);
              setDropConfirmName("");
            }}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            className="border border-blue-500"
            onClick={() => {
              if (!dropConfirmDb) return;
              onDropDbByName(dropConfirmDb);
              setDropConfirmDb(null);
              setDropConfirmName("");
            }}
            disabled={busy || dropConfirmName.trim() !== (dropConfirmDb ?? "")}
          >
            {busy ? "Dropping..." : "Drop"}
          </Button>
        </DialogFooter>
      </Dialog>
    </Dialog>
  );
}
