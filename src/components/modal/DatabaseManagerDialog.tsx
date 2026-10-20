import { Button } from "src/components/common/Button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Input } from "src/components/common/Input";
import { DatabaseIcon, SearchIcon } from "src/components/icons";
import type { DatabaseEngine } from "src/types";
import { cn } from "src/utils/cn";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import { useCallback, useEffect, useState } from "preact/hooks";
import {
  canManageDatabases,
  canOpenDatabases,
  useDatabases,
} from "src/hooks/useDatabases";
import { DatabaseEditorDialog } from "./DatabaseEditorDialog";
import { ContextMenu, MenuItem } from "src/components/common/ContextMenu";
import { showMessage } from "src/lib/system-dialog";

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
    setError,
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

  useEffect(() => {
    if (!error) return;
    void showMessage(error, { title: "Error", kind: "error" }).then(() => {
      setError("");
    });
  }, [error, setError]);

  return (
    <Dialog open={open} size="md" onClose={onClose}>
      <DialogHeader className="border-b border-neutral-200">
        <DialogTitle className="flex items-center gap-2">
          <DatabaseIcon className="size-4.5 text-neutral-600" />
          Open database
        </DialogTitle>
      </DialogHeader>
      <DialogContent className="gap-3">
        <Input
          value={search}
          placeholder="Search for database..."
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          className="h-10 rounded-lg border border-neutral-300 text-sm"
          left={<SearchIcon className="size-5 text-neutral-500" />}
        />

        {!canOpenDatabases(engine) && (
          <div class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Database management is not supported for this engine.
          </div>
        )}

        <div class="min-h-98 gap-4">
          <OverlayScrollArea
            className="h-98 rounded-lg"
            contentClassName="flex flex-col gap-1.5"
          >
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
                  <DatabaseIcon
                    className={cn(
                      "size-5 text-blue-500",
                      selectedDb === dbName && "text-blue-200"
                    )}
                  />
                  <span>{dbName}</span>
                </Button>
              ))
            )}
          </OverlayScrollArea>
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
            className="py-1.5"
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
        size="sm"
        onClose={() => {
          setDropConfirmDb(null);
          setDropConfirmName("");
        }}
      >
        <DialogHeader className="border-b border-neutral-200">
          <DialogTitle className="flex items-center gap-2">
            <DatabaseIcon className="size-4.5 text-neutral-600" />
            Drop database "{dropConfirmDb ?? ""}"
          </DialogTitle>
        </DialogHeader>
        <DialogContent className="gap-2">
          <p className="text-sm text-neutral-600">
            Enter{" "}
            <span class="font-semibold text-neutral-900">
              {dropConfirmDb ?? ""}
            </span>{" "}
            to confirm:
          </p>
          <Input
            value={dropConfirmName}
            onInput={(e) =>
              setDropConfirmName((e.target as HTMLInputElement).value)
            }
            placeholder={dropConfirmDb ?? ""}
            className="h-9 rounded-lg border border-neutral-300 text-sm"
          />
          <p className="text-xs text-neutral-800">
            Permanently drop the database{" "}
            <span class="font-semibold text-neutral-900">
              {dropConfirmDb ?? ""}
            </span>
            ? This cannot be undone.
          </p>
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
