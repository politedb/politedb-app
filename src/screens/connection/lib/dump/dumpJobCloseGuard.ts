import { showMessage } from "src/lib/system-dialog";
import {
  admitClose,
  releaseCloseLease,
  type CloseScope,
} from "src/stores/dumpJob";

/**
 * Runs a close (a tab, or the app) only when no backup or restore runs in
 * its scope (D8): refused at once with a message otherwise, before any
 * prompt or change. While the close runs it holds a lease, so no job can
 * start in its scope until it is done, declined or failed. A nested close
 * passing the same `intent` borrows the caller's lease instead of taking
 * (and releasing) its own.
 *
 * Returns false when refused (nothing was done).
 */
export async function withCloseAdmission(
  scope: CloseScope,
  intent: symbol | undefined,
  close: () => Promise<void> | void
): Promise<boolean> {
  const admitted = admitClose(scope, intent);
  if (!admitted.ok) {
    void showMessage(admitted.message, { title: "Close", kind: "info" });
    return false;
  }
  try {
    await close();
    return true;
  } finally {
    if (admitted.owned) releaseCloseLease(admitted.lease.leaseId);
  }
}

/** A close's scope for a connection tab. */
export function tabCloseScope(
  tabId: string,
  runtimeConnectionId?: string | null
): CloseScope {
  return {
    kind: "tab",
    tabId,
    ...(runtimeConnectionId ? { runtimeConnectionId } : {}),
  };
}
