import { useMemo } from "preact/hooks";
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
import type { DatabaseEngine } from "src/types";
import { useStandaloneTableExport } from "../hooks/useStandaloneTableExport";
import type { StandaloneExportTarget } from "./standalone-export/types";

export function StandaloneTableExportHost(props: {
  profileScreenId: string;
  runtimeConnectionId: string | undefined;
  engine: DatabaseEngine | undefined;
  target: StandaloneExportTarget | null;
  onClearTarget: () => void;
}) {
  const { phase, close, retry } = useStandaloneTableExport(props);

  const ready = phase.status === "ready" ? phase : null;
  const loading = phase.status === "loading" ? phase : null;
  const errored = phase.status === "error" ? phase : null;

  const identityLabel = useMemo(() => {
    const t = ready?.target ?? loading?.target ?? errored?.target;
    if (!t) return "";
    return t.schema ? `${t.schema}.${t.tableName}` : t.tableName;
  }, [ready, loading, errored]);

  return (
    <>
      {/* Preparing failed: say why here and offer to try again. */}
      {errored && (
        <Dialog open onClose={close} size="sm" showCloseButton>
          <DialogHeader>
            <DialogTitle className="text-base dark:text-neutral-100">
              Export data
            </DialogTitle>
          </DialogHeader>
          <DialogContent className="space-y-2 py-2">
            <div class="truncate font-mono text-sm text-neutral-800 dark:text-neutral-100">
              {identityLabel}
            </div>
            <div
              role="alert"
              class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            >
              <div class="font-medium">The table could not be prepared.</div>
              <div class="mt-1 wrap-break-word">{errored.message}</div>
            </div>
          </DialogContent>
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button variant="default" onClick={retry}>
              Try again
            </Button>
          </DialogFooter>
        </Dialog>
      )}

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
          tabId={props.profileScreenId}
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
