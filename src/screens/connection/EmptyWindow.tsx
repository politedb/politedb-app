import { Database } from "src/components/icons";

export function EmptyWindow(props: {
  onNewSql: () => void;
  canOpenSql?: boolean;
}) {
  const { canOpenSql = true } = props;
  return (
    <div class="relative flex h-full w-full items-center justify-center">
      {/* subtle backdrop */}
      <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div class="h-56 w-140 rounded-2xl bg-neutral-100/50" />
      </div>

      <div class="relative w-full max-w-lg px-6 text-center">
        <div class="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-white ring-1 ring-neutral-200">
          <Database className="size-5 text-neutral-600" />
        </div>

        <div class="text-lg font-semibold text-neutral-900">
          Ready to explore
        </div>

        <div class="mt-2 text-sm leading-relaxed text-neutral-600">
          This connection is ready.
          <br />
          {canOpenSql
            ? "Select a table from the sidebar, or open the SQL editor to run queries."
            : "Select a collection from the sidebar to start browsing documents."}
        </div>

        <div class="mt-6 flex flex-col items-center gap-2">
          {canOpenSql ? (
            <button
              class="h-9 rounded-md border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-900 hover:bg-neutral-50 active:bg-neutral-100"
              onClick={props.onNewSql}
            >
              Open SQL Editor
            </button>
          ) : null}

          <div class="text-xs text-neutral-400">
            or choose a {canOpenSql ? "table" : "collection"} from the left panel
          </div>
        </div>
      </div>
    </div>
  );
}
