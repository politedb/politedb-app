import { describe, expect, it } from "vitest";
import { runSaveJobs, saveFailureMessages, SaveJobsError } from "./saveJobs";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runSaveJobs", () => {
  it("settles only after every job, even when one fails early", async () => {
    const patches = deferred();
    const objects = deferred();
    let settled = false;
    const run = runSaveJobs([patches.promise, objects.promise]).finally(
      () => (settled = true)
    );
    objects.reject(new Error("syntax error at or near x"));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    patches.reject(new Error("permission denied"));
    await expect(run).rejects.toBeInstanceOf(SaveJobsError);
    await run.catch((e: SaveJobsError) =>
      expect(e.failures.map((f) => (f as Error).message)).toEqual([
        // In job order.
        "permission denied",
        "syntax error at or near x",
      ])
    );
  });

  it("resolves when every job succeeds", async () => {
    await expect(
      runSaveJobs([Promise.resolve(), Promise.resolve()])
    ).resolves.toBeUndefined();
  });
});

describe("saveFailureMessages", () => {
  it("keeps every distinct failure once", () => {
    const thrown = new SaveJobsError([
      new Error("duplicate key value"),
      new Error("relation t does not exist"),
    ]);
    expect(
      saveFailureMessages(
        ["duplicate key value", "duplicate key value"],
        thrown
      )
    ).toEqual(["duplicate key value", "relation t does not exist"]);
  });

  it("uses the rejection when nothing was reported", () => {
    expect(saveFailureMessages([], new Error("boom"))).toEqual(["boom"]);
    expect(saveFailureMessages([], null)).toEqual([]);
  });
});
