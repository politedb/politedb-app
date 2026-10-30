import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { useScreenStore } from "src/stores/screen";
import { useRuntimeLifetime } from "src/hooks/useRuntimeLifetime";
import { DiagramCanvas } from "src/components/diagram/DiagramCanvas";
import { loadDiagramState } from "src/components/diagram/diagramMetadata";
import type { DiagramState } from "src/components/diagram/diagramTypes";
import { DiagramIcon, XIcon } from "src/components/icons";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";
import type { DatabaseEngine } from "src/types";
import { OverlayModal } from "./OverlayModal";
import { DialogDescription, DialogTitle } from "../common/Dialog";

type DiagramGeneratorDialogProps = {
  open: boolean;
  onClose: () => void;
  engine?: DatabaseEngine;
  database?: string;
  schema: string;
  connectionId?: string;
  metaKey: string;
  metadata: MetadataApi;
};

export function DiagramGeneratorDialog(props: DiagramGeneratorDialogProps) {
  const {
    open,
    onClose,
    engine,
    database,
    schema,
    connectionId,
    metaKey,
    metadata,
  } = props;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagram, setDiagram] = useState<DiagramState | null>(null);
  const disabled = !connectionId || !schema || engine === "redis";

  const seqRef = useRef(0);
  // The connection lost authority: retire the obsolete load now.
  const lifetime = useRuntimeLifetime(connectionId);
  useEffect(() => {
    seqRef.current += 1;
    setLoading(false);
  }, [lifetime]);
  const connectionRef = useRef(connectionId);
  connectionRef.current = connectionId;

  const loadDiagram = useCallback(async () => {
    if (disabled || !connectionId || !engine || !schema) return;
    // What this load may still publish (R5): nothing once a newer load
    // started, the connection changed, or its tab's epoch moved (profile
    // saved again, connection refused); its own spinner is still retired.
    const seq = ++seqRef.current;
    const epochOf = () => {
      const screen = useScreenStore.getState();
      const tab = screen.profileTabs.find(
        (t) => t.runtimeConnectionId === connectionId
      );
      return tab ? (screen.tabEpoch[tab.id] ?? 0) : -1;
    };
    const epoch = epochOf();
    const current = () =>
      seqRef.current === seq &&
      connectionRef.current === connectionId &&
      epochOf() === epoch;
    setLoading(true);
    setError(null);
    try {
      const state = await loadDiagramState({
        metadata,
        metaKey,
        connectionId,
        engine,
        schema,
      });
      if (current()) setDiagram(state);
    } catch (loadError) {
      if (!current()) return;
      setError(
        loadError instanceof Error ? loadError.message : String(loadError)
      );
      setDiagram(null);
    } finally {
      if (seqRef.current === seq) setLoading(false);
    }
  }, [connectionId, disabled, engine, metaKey, metadata, schema]);

  useEffect(() => {
    if (open) void loadDiagram();
  }, [open, connectionId, engine, schema, metaKey, loadDiagram]);

  return (
    <OverlayModal open={open} onClose={onClose}>
      <div class="flex h-[85vh] w-full max-w-10/12 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div class="flex shrink-0 items-start justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <DialogTitle className="flex items-center gap-2">
              <DiagramIcon className="size-4.5" />
              Database schema diagram
            </DialogTitle>
            <DialogDescription>
              Generate Visual ER diagram for the current schema.
            </DialogDescription>
          </div>
          <button
            type="button"
            onClick={onClose}
            class="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close diagram dialog"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-hidden">
          <div class="flex h-full min-h-0 flex-col overflow-hidden">
            {disabled ? (
              <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-300">
                Diagram generation is available for database schemas with
                tables.
              </div>
            ) : loading ? (
              <div class="flex min-h-0 flex-1 items-center justify-center">
                <div class="text-center">
                  <div class="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-blue-100 border-t-blue-600 dark:border-slate-700 dark:border-t-sky-400" />
                  <div class="mt-4 text-sm text-slate-500">
                    Building diagram from schema metadata...
                  </div>
                </div>
              </div>
            ) : error ? (
              <div class="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-500/40 dark:bg-rose-950/40 dark:text-rose-300">
                {error}
              </div>
            ) : diagram ? (
              <div class="flex min-h-0 flex-1 gap-3">
                <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                  <DiagramCanvas
                    state={diagram}
                    loadDiagram={() => void loadDiagram()}
                    database={database}
                    schema={schema}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </OverlayModal>
  );
}
