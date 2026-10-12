import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import {
  describeFileAccessError,
  ensureFileAccess,
  type FileAccessError,
} from "src/lib/file-access";
import { showMessage } from "src/lib/system-dialog";
import type { FileAccessRequest } from "src/lib/tauri/fileAccess";

/**
 * Shown when restoring a connection needs file access again (sandboxed builds). Panels
 * open only after the user clicks Grant Access; nothing happens automatically.
 */
export function FileAccessBanner(props: {
  error: FileAccessError;
  requests: FileAccessRequest[];
  /** Identifies the tab/profile; a grant finishing after it changed is ignored. */
  scope: string;
  onGranted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const scope = useRef(props.scope);
  scope.current = props.scope;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function grant() {
    const startedFor = props.scope;
    const onGranted = props.onGranted;
    setBusy(true);
    try {
      const failed = props.requests.filter(
        (r) => !props.error.role || r.role === props.error.role
      );
      // The click is the user's consent: no extra confirmation dialog.
      const granted = await ensureFileAccess(props.requests, {
        force: failed,
        confirm: false,
      });
      // Only reconnect the tab that asked; the user may have switched or closed it.
      if (granted && mounted.current && scope.current === startedFor)
        onGranted();
    } catch (error) {
      await showMessage(describeFileAccessError(error) ?? String(error), {
        title: "File access",
        kind: "error",
      });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div
      role="alert"
      class="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
    >
      <span>
        {describeFileAccessError(
          `${props.error.code}:${JSON.stringify({ role: props.error.role })}`
        )}
      </span>
      <Button
        variant="outline"
        class="shrink-0"
        loading={busy}
        onClick={() => void grant()}
      >
        Grant Access…
      </Button>
    </div>
  );
}
