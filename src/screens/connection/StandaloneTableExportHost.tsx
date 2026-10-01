import { useEffect, useMemo, useRef } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { Spinner } from "src/components/common/Spinner";
import { ExportTableDialog } from "src/components/modal/ExportTableDialog";
import { showMessage } from "src/lib/system-dialog";
import type { DatabaseEngine } from "src/types";
import { useStandaloneTableExport } from "./hooks/useStandaloneTableExport";
import type { StandaloneExportTarget } from "./standaloneExport/types";

export function StandaloneTableExportHost(props: {
  profileScreenId: string;
  runtimeConnectionId: string | undefined;
  engine: DatabaseEngine | undefined;
  target: StandaloneExportTarget | null;
  onClearTarget: () => void;
}) {
  const { phase, close } = useStandaloneTableExport(props);

  const ready = phase.status === "ready" ? phase : null;
  const loading = phase.status === "loading" ? phase : null;
  const errored = phase.status === "error" ? phase : null;
  const shownErrorRef = useRef<string | null>(null);

  const identityLabel = useMemo(() => {
    const t = ready?.target ?? loading?.target ?? errored?.target;
    if (!t) return "";
    return t.schema ? `${t.schema}.${t.tableName}` : t.tableName;
  }, [ready, loading, errored]);

  useEffect(() => {
    if (!errored) {
      shownErrorRef.current = null;
      return;
    }
    const key = `${errored.target.requestId}:${errored.message}`;
    if (shownErrorRef.current === key) return;
    shownErrorRef.current = key;
    void showMessage(errored.message, {
      title: "Export error",
      kind: "error",
    }).then(() => {
      close();
    });
  }, [errored, close]);

  return (
    <>
      {loading && (
        <Dialog
          open
          onClose={close}
          size="sm"
          closeOnOutsideClick
          showCloseButton
        >
          <DialogHeader>
            <DialogTitle className="text-base dark:text-neutral-100">
              Preparing export
            </DialogTitle>
          </DialogHeader>
          <DialogContent className="flex items-center gap-3 py-4">
            <Spinner className="size-5 text-neutral-500" />
            <div class="min-w-0 text-sm text-neutral-600 dark:text-neutral-300">
              <div class="truncate font-mono text-neutral-800 dark:text-neutral-100">
                {identityLabel}
              </div>
              <div class="mt-0.5 text-neutral-500">
                Loading column metadata…
              </div>
            </div>
          </DialogContent>
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
          </DialogFooter>
        </Dialog>
      )}

      {ready && (
        <ExportTableDialog
          open
          handleClose={close}
          connectionId={ready.target.connectionId}
          schema={ready.target.schema}
          tableName={ready.target.tableName}
          columns={ready.metadata.columns}
          constraints={ready.metadata.constraints}
          appliedFilters={[]}
          appliedFilterCombine="AND"
          pagination={undefined}
          sortState={null}
          totalRows={ready.metadata.totalRows}
          engine={ready.target.engine}
        />
      )}
    </>
  );
}
