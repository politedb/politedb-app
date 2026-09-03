import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import { DiagramCanvas } from "src/components/DiagramCanvas";
import { buildDiagramSvg } from "src/components/diagram/diagramExport";
import { loadDiagramState } from "src/components/diagram/diagramMetadata";
import type { DiagramState } from "src/components/diagram/diagramTypes";
import { DownloadIcon, RefreshCwIcon, XIcon } from "src/components/icons";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";
import { saveDialog, showMessage } from "src/lib/system-dialog";
import { writeFile } from "src/lib/system-fs";
import type { DatabaseEngine } from "src/types";
import { OverlayModal } from "./OverlayModal";

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
  const [copied, setCopied] = useState(false);
  const [diagram, setDiagram] = useState<DiagramState | null>(null);
  const disabled = !connectionId || !schema || engine === "redis";

  const loadDiagram = useCallback(async () => {
    if (disabled || !connectionId || !engine || !schema) return;
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      setDiagram(
        await loadDiagramState({
          metadata,
          metaKey,
          connectionId,
          engine,
          schema,
        })
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError)
      );
      setDiagram(null);
    } finally {
      setLoading(false);
    }
  }, [connectionId, disabled, engine, metaKey, metadata, schema]);

  useEffect(() => {
    if (open) void loadDiagram();
  }, [open, connectionId, engine, schema, metaKey, loadDiagram]);

  const subtitle = useMemo(() => {
    if (!diagram) return "";
    return `${diagram.tableCount} tables • ${diagram.relationshipCount} relationships`;
  }, [diagram]);
  const exportBaseName = useMemo(
    () => [database, schema, "diagram"].filter(Boolean).join("-"),
    [database, schema]
  );

  async function handleCopy() {
    if (!diagram?.mermaid) return;
    try {
      await navigator.clipboard.writeText(diagram.mermaid);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (copyError) {
      await showMessage(String(copyError), {
        title: "Copy failed",
        kind: "error",
      });
    }
  }

  async function handleDownloadPng() {
    if (!diagram) return;
    let objectUrl: string | null = null;
    try {
      const path = await saveDialog({
        title: "Export PNG",
        defaultPath: `${exportBaseName || "diagram"}.png`,
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (!path) return;

      const svg = buildDiagramSvg(diagram);
      objectUrl = URL.createObjectURL(
        new Blob([svg], { type: "image/svg+xml;charset=utf-8" })
      );
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Failed to render SVG."));
        image.src = objectUrl!;
      });

      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = image.width * scale;
      canvas.height = image.height * scale;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Failed to create PNG canvas.");
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.drawImage(image, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png")
      );
      if (!blob) throw new Error("Failed to encode PNG.");
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      await showMessage("PNG exported.", {
        title: "Export completed",
        kind: "info",
      });
    } catch (exportError) {
      await showMessage(String(exportError), {
        title: "Export failed",
        kind: "error",
      });
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  return (
    <OverlayModal open={open} onClose={onClose}>
      <div class="flex h-[85vh] w-full max-w-10/12 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div class="flex shrink-0 items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <div class="text-xl font-semibold text-slate-900">
              Generate Diagram
            </div>
            <div class="mt-1 text-sm text-slate-500">
              {schema
                ? `Visual ER diagram for ${schema}.`
                : "Visual ER diagram for the current schema."}
            </div>
            {subtitle ? (
              <div class="mt-2 text-xs font-medium text-slate-400">
                {subtitle}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            class="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close diagram dialog"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-hidden">
          <div class="flex h-full min-h-0 flex-col overflow-hidden px-5 py-4">
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
                <div class="flex min-h-0 w-1/4 min-w-0 shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                  <button
                    type="button"
                    class="flex w-full shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <span>Database Structure</span>
                  </button>
                  <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-4">
                    <div class="group relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                      <button
                        type="button"
                        onClick={() => void handleCopy()}
                        class="absolute top-3 right-3 z-10 hidden rounded-md border border-slate-700 bg-slate-900/90 px-2.5 py-1 text-xs font-medium text-slate-100 group-hover:block hover:border-slate-500 hover:bg-slate-800"
                      >
                        {copied ? "Copied" : "Copy"}
                      </button>
                      <OverlayScrollArea
                        className="min-h-0 flex-1 rounded-lg bg-slate-800"
                        contentClassName="p-4 text-xs leading-6 whitespace-pre text-slate-100"
                        horizontal
                        vertical
                      >
                        {diagram.mermaid}
                      </OverlayScrollArea>
                    </div>
                  </div>
                </div>
                <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                  <DiagramCanvas state={diagram} />
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div class="flex shrink-0 items-center justify-between border-t border-slate-200 px-5 py-4">
          <div class="text-xs text-slate-400">
            Relationships are generated from foreign keys when supported.
          </div>
          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => void loadDiagram()}
              disabled={disabled || loading}
              class="h-9 rounded-lg px-3"
            >
              <RefreshCwIcon className="size-4" />
              Refresh
            </Button>
            <Button
              variant="default"
              onClick={() => void handleDownloadPng()}
              disabled={!diagram || loading}
              class="h-9 rounded-lg px-3"
            >
              <DownloadIcon className="size-4" />
              Export as PNG
            </Button>
          </div>
        </div>
      </div>
    </OverlayModal>
  );
}
