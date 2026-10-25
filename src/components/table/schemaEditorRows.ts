import type { InputOption } from "src/components/common/Input";
import type { CanvasCellOption } from "./CanvasTable";

/**
 * The rows a structure or index editor shows: the edited copy once there
 * is one, else what was loaded; none when loading failed.
 */
export function schemaEditorRows<T>(
  edited: T[],
  loaded: T[] | null,
  error: string | null
): T[] {
  if (error) return [];
  if (edited.length > 0) return edited;
  return loaded ?? [];
}

/** Input options as canvas cell options. */
export function canvasOptions(
  options: InputOption[] | undefined
): CanvasCellOption[] | undefined {
  return options?.map((option) =>
    typeof option === "string" ? { label: option, value: option } : option
  );
}
