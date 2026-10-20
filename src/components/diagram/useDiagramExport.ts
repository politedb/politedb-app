import { useMemo } from "preact/hooks";
import {
  buildDiagramJson,
  buildDiagramSvg,
} from "src/components/diagram/diagramExport";
import type { DiagramState } from "src/components/diagram/diagramTypes";
import { useProGate } from "src/hooks/useProGate";
import { saveDialog, showMessage } from "src/lib/system-dialog";
import { writeFile, writeTextFile } from "src/lib/system-fs";

async function reportFailure(error: unknown) {
  await showMessage(String(error), { title: "Export failed", kind: "error" });
}

async function reportDone(format: string) {
  await showMessage(`${format} exported.`, {
    title: "Export completed",
    kind: "info",
  });
}

/** Renders the diagram's SVG into PNG bytes at 2x scale. */
async function renderPng(svg: string) {
  const objectUrl = URL.createObjectURL(
    new Blob([svg], { type: "image/svg+xml;charset=utf-8" })
  );
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Failed to render SVG."));
      image.src = objectUrl;
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
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Diagram export to files. PNG and JSON are free; SVG is a Pro feature. Each export asks
 * for a path first and does nothing when the save dialog is cancelled.
 */
export function useDiagramExport(args: {
  diagram: DiagramState;
  database?: string | null;
  schema?: string | null;
}) {
  const { diagram, database, schema } = args;
  const { requirePro } = useProGate();
  const baseName = useMemo(
    () => [database, schema, "diagram"].filter(Boolean).join("-") || "diagram",
    [database, schema]
  );

  const ask = (format: string, extension: string) =>
    saveDialog({
      title: `Export ${format}`,
      defaultPath: `${baseName}.${extension}`,
      filters: [{ name: format, extensions: [extension] }],
    });

  async function exportPng() {
    try {
      const path = await ask("PNG", "png");
      if (!path) return;
      await writeFile(path, await renderPng(buildDiagramSvg(diagram)));
      await reportDone("PNG");
    } catch (error) {
      await reportFailure(error);
    }
  }

  /** Tables, columns, primary keys and relationships, for other tools. */
  async function exportJson() {
    try {
      const path = await ask("JSON", "json");
      if (!path) return;
      await writeTextFile(
        path,
        buildDiagramJson(diagram, { database, schema })
      );
      await reportDone("JSON");
    } catch (error) {
      await reportFailure(error);
    }
  }

  async function exportSvg() {
    if (!requirePro("er-diagram-export")) return;
    try {
      const path = await ask("SVG", "svg");
      if (!path) return;
      await writeTextFile(path, buildDiagramSvg(diagram));
      await reportDone("SVG");
    } catch (error) {
      await reportFailure(error);
    }
  }

  return { exportPng, exportJson, exportSvg };
}
