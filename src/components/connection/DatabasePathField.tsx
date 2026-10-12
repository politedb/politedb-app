import { Button } from "src/components/common/Button";
import { FilePathPicker } from "src/components/common/FilePathPicker";
import { Input } from "src/components/form";
import {
  DISTRIBUTION_FEATURES,
  type DistributionFeatures,
} from "src/lib/distribution";
import { describeFileAccessError, isInMemoryPath } from "src/lib/file-access";
import { showMessage } from "src/lib/system-dialog";
import { fileAccessPickDatabase } from "src/lib/tauri/fileAccess";
import { cn } from "src/utils/cn";

/**
 * SQLite/DuckDB database location. Direct builds keep the typed path and add Browse /
 * New; sandboxed builds can only pick (a typed path would have no access, plan D18).
 */
export function DatabasePathField(props: {
  value: string;
  placeholder?: string;
  error?: boolean;
  onChange: (path: string) => void;
  className?: string;
  features?: DistributionFeatures;
}) {
  const features = props.features ?? DISTRIBUTION_FEATURES;
  const inMemory = props.value.trim().toLowerCase() === ":memory:";

  async function pick(mode: "open" | "create") {
    try {
      const path = await fileAccessPickDatabase(mode);
      if (path) props.onChange(path);
    } catch (error) {
      await showMessage(
        describeFileAccessError(error) ??
          (error instanceof Error ? error.message : String(error)),
        { title: "Database file", kind: "error" }
      );
    }
  }

  const buttons = (
    <>
      <Button type="button" variant="outline" onClick={() => void pick("open")}>
        Browse…
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={() => void pick("create")}
      >
        New…
      </Button>
    </>
  );

  if (!features.fileGrants) {
    return (
      <div class={cn("flex min-w-0 gap-2", props.className)}>
        <Input
          value={props.value}
          placeholder={props.placeholder}
          error={props.error}
          class="min-w-0 flex-1"
          onInput={(e: { currentTarget: HTMLInputElement }) =>
            props.onChange(e.currentTarget.value)
          }
        />
        {buttons}
      </div>
    );
  }

  return (
    <div class={cn("flex min-w-0 gap-2", props.className)}>
      {inMemory ? (
        <div class="flex h-10 min-w-0 flex-1 items-center rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm text-slate-700">
          In-memory database
        </div>
      ) : (
        <FilePathPicker
          value={isInMemoryPath(props.value) ? "" : props.value}
          placeholder="Choose a database file…"
          error={props.error}
          onPick={() => pick("open")}
          className="min-w-0 flex-1"
        />
      )}
      {buttons}
      <Button
        type="button"
        variant={inMemory ? "secondary" : "outline"}
        aria-pressed={inMemory}
        onClick={() => props.onChange(inMemory ? "" : ":memory:")}
      >
        In-memory
      </Button>
    </div>
  );
}
