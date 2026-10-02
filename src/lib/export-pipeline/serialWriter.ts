/**
 * Bounded serial write queue for streaming export.
 * Progress means completed writes, not submitted rows.
 */

export type SerialWriterOptions = {
  maxPending: number;
  write: (content: string) => Promise<void>;
};

export type SerialWriter = {
  enqueue: (content: string) => Promise<void>;
  drain: () => Promise<void>;
  fail: (error: Error) => void;
  close: () => void;
  readonly pendingCount: number;
  readonly completedWrites: number;
  readonly failed: boolean;
  readonly closed: boolean;
  readonly error: Error | null;
};

export function createSerialWriter(options: SerialWriterOptions): SerialWriter {
  const maxPending = Math.max(1, options.maxPending);
  let chain: Promise<void> = Promise.resolve();
  let pendingCount = 0;
  let completedWrites = 0;
  let failed = false;
  let closed = false;
  let error: Error | null = null;

  const enqueue = (content: string): Promise<void> => {
    if (failed) {
      return Promise.reject(error ?? new Error("Export writer failed"));
    }
    if (closed) {
      return Promise.reject(new Error("Export writer is closed"));
    }
    if (pendingCount >= maxPending) {
      return Promise.reject(
        new Error("Export write buffer full; slow consumer backpressure")
      );
    }
    pendingCount += 1;
    const run = async () => {
      if (failed) throw error ?? new Error("Export writer failed");
      await options.write(content);
      completedWrites += 1;
    };
    const task = chain.then(run, run);
    chain = task.then(
      () => {
        pendingCount -= 1;
      },
      (err) => {
        pendingCount -= 1;
        if (!failed) {
          failed = true;
          error = err instanceof Error ? err : new Error(String(err));
        }
      }
    );
    return task;
  };

  return {
    enqueue,
    drain: () => chain,
    fail: (err) => {
      failed = true;
      error = err;
    },
    close: () => {
      closed = true;
    },
    get pendingCount() {
      return pendingCount;
    },
    get completedWrites() {
      return completedWrites;
    },
    get failed() {
      return failed;
    },
    get closed() {
      return closed;
    },
    get error() {
      return error;
    },
  };
}
