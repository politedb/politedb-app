import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { Spinner } from "src/components/common/Spinner";
import { ImportTableDialog } from "src/components/modal/ImportTableDialog";
import {
  importUsesTransaction,
  useImportTableData,
  type ImportOutcome,
} from "src/hooks/useImportTableData";
import { showToast } from "src/stores/toast";
import type { ColumnMeta } from "src/lib/tauri/types";
import { useScreenStore } from "src/stores/screen";
import type { DatabaseEngine } from "src/types";
import {
  loadStandaloneExportMetadata,
  sanitizeStandaloneExportError,
} from "../export/standalone-export/loadStandaloneExportMetadata";
import type { StandaloneExportTarget } from "../export/standalone-export/types";

type Phase =
  | { status: "picking" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; columns: ColumnMeta[] };

type HostProps = {
  profileScreenId: string;
  runtimeConnectionId: string | undefined;
  engine: DatabaseEngine | undefined;
  target: StandaloneExportTarget | null;
  onClearTarget: () => void;
  /**
   * Rows were added to this table of this connection screen tab. Called
   * even if the dialog has closed since; never for another tab.
   */
  onImported: (profileScreenId: string, target: StandaloneExportTarget) => void;
};

/** An import's outcome when its dialog is no longer on screen. */
function reportOutcome(identity: string, outcome: ImportOutcome) {
  if (outcome.status === "imported") {
    const rows = `${outcome.imported.toLocaleString()} ${outcome.imported === 1 ? "row" : "rows"}`;
    showToast(`Imported ${rows} into ${identity}.`, { tone: "success" });
  } else if (outcome.status === "failed") {
    showToast(
      `The import into ${identity} stopped: ${outcome.message} Check the table before importing again.`,
      { tone: "error", durationMs: 0 }
    );
  }
}

/** Whether the connection screen tab is in Lock mode right now. */
function isTabLocked(profileScreenId: string): boolean {
  return (
    useScreenStore
      .getState()
      .profileTabs.find((tab) => tab.id === profileScreenId)?.isLocked ?? false
  );
}

/**
 * CSV import started from the sidebar without opening the table. Every
 * request is its own session (keyed by request id), so a replaced or
 * closed request can never hand its file, preview or result to another.
 */
export function StandaloneTableImportHost(props: HostProps) {
  // The session on screen. A request is taken over (and the screen's
  // request slot cleared) as soon as it arrives, so leaving and coming
  // back never starts it again. Once an import is submitted its session
  // stays until the user closes it; requests made meanwhile are dropped.
  const [active, setActive] = useState<StandaloneExportTarget | null>(null);
  const submittedRef = useRef(false);
  const { onClearTarget } = props;
  useEffect(() => {
    if (!props.target) return;
    if (!submittedRef.current) setActive(props.target);
    onClearTarget();
  }, [props.target, onClearTarget]);

  const closeSession = useCallback(() => {
    submittedRef.current = false;
    setActive(null);
  }, []);

  if (!active) return null;
  return (
    <ImportSession
      key={active.requestId}
      {...props}
      target={active}
      onClearTarget={closeSession}
      onSubmitted={() => {
        submittedRef.current = true;
      }}
    />
  );
}

function ImportSession(
  props: HostProps & {
    target: StandaloneExportTarget;
    onSubmitted: () => void;
  }
) {
  const { target, onClearTarget, onImported, onSubmitted } = props;
  // Fixed for the session: the tab and connection the import started in.
  const [profileScreenId] = useState(props.profileScreenId);
  const imp = useImportTableData();
  const [phase, setPhase] = useState<Phase>({ status: "picking" });
  // Import was clicked: from now on the session stays to show the outcome.
  const [submitted, setSubmitted] = useState(false);
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    []
  );

  const close = useCallback(() => {
    aliveRef.current = false;
    onClearTarget();
  }, [onClearTarget]);

  const loadColumns = useCallback(async () => {
    setPhase({ status: "loading" });
    try {
      const metadata = await loadStandaloneExportMetadata({
        profileScreenId,
        connectionId: target.connectionId,
        engine: target.engine,
        schema: target.schema,
        tableName: target.tableName,
        isCancelled: () => !aliveRef.current,
      });
      if (!aliveRef.current) return;
      setPhase({ status: "ready", columns: metadata.columns });
    } catch (err) {
      if (!aliveRef.current) return;
      setPhase({
        status: "error",
        message: sanitizeStandaloneExportError(err),
      });
    }
  }, [profileScreenId, target]);

  // Choose the file first; nothing opens if that is cancelled or fails.
  useEffect(() => {
    void (async () => {
      let loaded = false;
      try {
        loaded = await imp.loadDataImport();
      } catch {
        loaded = false;
      }
      if (!aliveRef.current) return;
      if (!loaded) {
        close();
        return;
      }
      await loadColumns();
    })();
    // Once per session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The connection went away or changed, or the tab was locked: before an
  // import is submitted the session just goes away; after, it stays to
  // show the outcome but cannot import again.
  const locked = useScreenStore(
    (s) => s.profileTabs.find((tab) => tab.id === profileScreenId)?.isLocked
  );
  const connectionGone =
    props.runtimeConnectionId !== target.connectionId ||
    (!!props.engine && props.engine !== target.engine);
  const blockedReason = locked
    ? "This tab is locked: importing is not possible."
    : connectionGone
      ? "The connection changed since this import started: importing again is not possible."
      : null;
  useEffect(() => {
    if (!submitted && blockedReason) close();
  }, [submitted, blockedReason, close]);

  const identity = target.schema
    ? `${target.schema}.${target.tableName}`
    : target.tableName;

  if (phase.status === "picking") return null;

  if (phase.status === "loading") {
    return (
      <Dialog open onClose={close} size="sm" showCloseButton>
        <DialogHeader>
          <DialogTitle className="text-base">Preparing import</DialogTitle>
        </DialogHeader>
        <DialogContent className="flex items-center gap-3 py-4">
          <Spinner className="size-5 text-neutral-500" />
          <span class="truncate font-mono text-sm">{identity}</span>
        </DialogContent>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  if (phase.status === "error") {
    return (
      <Dialog open onClose={close} size="sm" showCloseButton>
        <DialogHeader>
          <DialogTitle className="text-base">Import CSV data</DialogTitle>
        </DialogHeader>
        <DialogContent className="space-y-2 py-2">
          <div class="truncate font-mono text-sm">{identity}</div>
          <div
            role="alert"
            class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            <div class="font-medium">The table could not be prepared.</div>
            <div class="mt-1 wrap-break-word">{phase.message}</div>
          </div>
        </DialogContent>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button variant="default" onClick={() => void loadColumns()}>
            Try again
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  return (
    <ImportTableDialog
      open
      schema={target.schema}
      tableName={target.tableName}
      columns={phase.columns}
      dataPreview={imp.dataPreview}
      error={imp.error}
      importing={imp.importing}
      progress={imp.importProgress}
      usesTransaction={importUsesTransaction(target.engine)}
      blockedReason={submitted ? blockedReason : null}
      delimiter={imp.delimiter}
      onDelimiterChange={imp.setDelimiter}
      handleClose={close}
      onImport={(options) => {
        // Lock mode may have been turned on since the dialog opened.
        if (isTabLocked(profileScreenId)) {
          if (!submitted) close();
          return;
        }
        if (blockedReason) return;
        setSubmitted(true);
        onSubmitted();
        void imp
          .runImport({
            connectionId: target.connectionId,
            schema: target.schema,
            tableName: target.tableName,
            columns: phase.columns,
            limit: 0,
            offset: 0,
            engine: target.engine,
            ...options,
            onSuccess: async () => onImported(profileScreenId, target),
          })
          .then((outcome) => {
            // Still on screen: the dialog shows it. Gone (the user left the
            // connection screen): say it in a toast instead.
            if (!aliveRef.current) reportOutcome(identity, outcome);
          });
      }}
    />
  );
}
