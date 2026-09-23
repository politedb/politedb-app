import { DatabaseIcon } from "src/components/icons";
import { Button } from "src/components/common/Button";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";

export function ConnectionFailedPlaceholder(props: {
  message: string;
  onEditConnection?: () => void;
}) {
  const { message, onEditConnection } = props;

  return (
    <div class="relative flex h-full w-full items-center justify-center px-6">
      <div class="relative w-full max-w-lg text-center">
        <div class="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full border border-red-200 bg-red-50 dark:border-red-700">
          <DatabaseIcon className="size-5 text-red-600" />
        </div>

        <div class="text-lg font-semibold text-red-600">Connection failed</div>

        <OverlayScrollArea
          className="mt-4 max-h-52 rounded-xl border border-red-200 bg-red-50 text-left dark:border-red-700"
          contentClassName="wrap-break-word whitespace-pre-wrap p-4 font-mono text-[12px] leading-relaxed text-red-600"
          horizontal
          vertical
        >
          {message.trim()}
        </OverlayScrollArea>

        <p class="mt-4 text-sm leading-relaxed text-neutral-600">
          See the status bar above for the same message, or edit your connection
          settings and try again.
        </p>

        {onEditConnection ? (
          <div class="mt-6 flex justify-center">
            <Button
              variant="default"
              className="px-5 py-2 text-sm"
              onClick={onEditConnection}
            >
              Edit connection
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

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
          <DatabaseIcon className="size-5 text-neutral-600" />
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
            or choose a {canOpenSql ? "table" : "collection"} from the left
            panel
          </div>
        </div>
      </div>
    </div>
  );
}
