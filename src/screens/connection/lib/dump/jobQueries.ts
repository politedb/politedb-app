import type { DumpOperation } from "src/lib/tauri/dumpOperation";
import { setDumpQueryScope } from "./backupSql";
import type { DumpJobHandle } from "./dumpJobController";

/**
 * Holds a job's catalog queries for the length of its run: none starts
 * once a cancel was asked, and `stopAll` stops those still running and
 * waits for them (in the job's cleanup group) before the run ends its
 * snapshot or file. Returns whether every one was confirmed released.
 */
export function holdJobQueries(job: DumpJobHandle) {
  const running = new Set<DumpOperation<unknown>>();
  setDumpQueryScope({
    stopRequested: () => job.stopRequested(),
    track: (op) => {
      running.add(op);
      void op.settled.then(() => running.delete(op));
    },
  });
  return {
    /** Stops and joins the queries still running; false if a cancel failed. */
    async stopAll(): Promise<boolean> {
      let confirmed = true;
      for (const op of [...running]) {
        await job.cleanup.run(async () => {
          const ack = await op.cancel();
          await op.settled;
          if (ack.kind === "rejected") confirmed = false;
        });
      }
      return confirmed;
    },
    release(): void {
      setDumpQueryScope(null);
    },
  };
}
