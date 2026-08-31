import { describe, expect, it, vi } from "vitest";
import {
  consumeUndrainedSqlForLiveEditor,
  enqueueSqlIntoLiveEditor,
  getLiveSqlEditorContent,
  registerLiveSqlEditor,
} from "./liveSqlEditorRegistry";

describe("live SQL editor registry", () => {
  it("drains SQL queued before the editor registers exactly once", async () => {
    const appendSql = vi.fn(async () => {});

    enqueueSqlIntoLiveEditor("queued-editor", " SELECT 1 ");
    const unregister = registerLiveSqlEditor("queued-editor", {
      getValue: () => "",
      appendSql,
    });

    await vi.waitFor(() => expect(appendSql).toHaveBeenCalledTimes(1));
    expect(appendSql).toHaveBeenCalledWith("SELECT 1");
    unregister();
  });

  it("preserves FIFO order while an editor is draining", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstAppend = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const appended: string[] = [];
    const unregister = registerLiveSqlEditor("ordered-editor", {
      getValue: () => "",
      appendSql: async (sql) => {
        appended.push(sql);
        if (sql === "first") await firstAppend;
      },
    });

    enqueueSqlIntoLiveEditor("ordered-editor", "first");
    enqueueSqlIntoLiveEditor("ordered-editor", "second");
    expect(appended).toEqual(["first"]);

    releaseFirst?.();
    await vi.waitFor(() => expect(appended).toEqual(["first", "second"]));
    unregister();
  });

  it("does not let stale cleanup unregister a newer editor", () => {
    const unregisterOld = registerLiveSqlEditor("replaced-editor", {
      getValue: () => "old",
      appendSql: async () => {},
    });
    const unregisterNew = registerLiveSqlEditor("replaced-editor", {
      getValue: () => "new",
      appendSql: async () => {},
    });

    unregisterOld();
    expect(getLiveSqlEditorContent("replaced-editor")).toBe("new");
    unregisterNew();
  });

  it("retries a failed queued append through a replacement editor", async () => {
    let rejectOld: ((reason?: unknown) => void) | undefined;
    const oldAppend = new Promise<void>((_, reject) => {
      rejectOld = reject;
    });
    const unregisterOld = registerLiveSqlEditor("failed-editor", {
      getValue: () => "old",
      appendSql: () => oldAppend,
    });
    enqueueSqlIntoLiveEditor("failed-editor", "SELECT retry");

    const newAppend = vi.fn(async () => {});
    const unregisterNew = registerLiveSqlEditor("failed-editor", {
      getValue: () => "new",
      appendSql: newAppend,
    });
    rejectOld?.(new Error("old editor disposed"));

    await vi.waitFor(() => expect(newAppend).toHaveBeenCalledTimes(1));
    expect(newAppend).toHaveBeenCalledWith("SELECT retry");
    unregisterOld();
    unregisterNew();
  });

  it("consumes queued SQL when its window closes before registration", async () => {
    enqueueSqlIntoLiveEditor("closed-editor", "SELECT stale");
    expect(consumeUndrainedSqlForLiveEditor("closed-editor")).toEqual([
      "SELECT stale",
    ]);

    const appendSql = vi.fn(async () => {});
    const unregister = registerLiveSqlEditor("closed-editor", {
      getValue: () => "",
      appendSql,
    });

    await Promise.resolve();
    expect(appendSql).not.toHaveBeenCalled();
    unregister();
  });

  it("does not remove new SQL when an old append finishes after close", async () => {
    let releaseOld: (() => void) | undefined;
    const oldAppend = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const unregisterOld = registerLiveSqlEditor("reopened-editor", {
      getValue: () => "old",
      appendSql: () => oldAppend,
    });
    enqueueSqlIntoLiveEditor("reopened-editor", "SELECT old");

    consumeUndrainedSqlForLiveEditor("reopened-editor");
    unregisterOld();
    const newAppend = vi.fn(async () => {});
    const unregisterNew = registerLiveSqlEditor("reopened-editor", {
      getValue: () => "new",
      appendSql: newAppend,
    });
    enqueueSqlIntoLiveEditor("reopened-editor", "SELECT new");
    releaseOld?.();

    await vi.waitFor(() => expect(newAppend).toHaveBeenCalledTimes(1));
    expect(newAppend).toHaveBeenCalledWith("SELECT new");
    unregisterNew();
  });

  it("consumes queued SQL without duplicating the active append", async () => {
    let releaseActive: (() => void) | undefined;
    const activeAppend = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const unregister = registerLiveSqlEditor("closing-editor", {
      getValue: () => "SELECT active",
      appendSql: (sql) =>
        sql === "SELECT active" ? activeAppend : Promise.resolve(),
    });
    enqueueSqlIntoLiveEditor("closing-editor", "SELECT active");
    enqueueSqlIntoLiveEditor("closing-editor", "SELECT queued");

    expect(consumeUndrainedSqlForLiveEditor("closing-editor")).toEqual([
      "SELECT queued",
    ]);

    releaseActive?.();
    await activeAppend;
    unregister();
  });
});
