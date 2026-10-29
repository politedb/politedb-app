import type { DumpOperation } from "src/lib/tauri/dumpOperation";
import { setDumpQueryScope } from "./backupSql";
import type { DumpJobHandle } from "./dumpJobController";

/**
 * Holds a job's catalog queries for the length of its run: none starts
 * once a cancel was asked, and `stopAll` stops those still running and
 * waits for them (in the job's cleanup group) before the run ends its
 * snapshot or file. Whether every one was confirmed released is kept for
 * the whole run: a query whose cancel was refused (asked by the job, or by
 * the port itself on a timeout) still counts after it settled.
 */
export function holdJobQueries(job: DumpJobHandle) {
  const running = new Set<DumpOperation<unknown>>();
  let unconfirmed = false;
  setDumpQueryScope({
    stopRequested: () => job.stopRequested(),
    track: (op) => {
      running.add(op);
      void op.settled.then((settled) => {
        if (settled.cancelRejected) unconfirmed = true;
        running.delete(op);
      });
    },
  });
  return {
    /**
     * Stops and joins the queries still running; false if any query of
     * the run could not be confirmed released.
     */
    async stopAll(): Promise<boolean> {
      for (const op of [...running]) {
        await job.cleanup.run(async () => {
          const ack = await op.cancel();
          const settled = await op.settled;
          if (ack.kind === "rejected" || settled.cancelRejected) {
            unconfirmed = true;
          }
        });
      }
      return !unconfirmed;
    },
    release(): void {
      setDumpQueryScope(null);
    },
  };
}
