import { act, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDatabaseObjectItem } from "src/lib/databaseObjects";
import {
  useDatabaseMetadata,
  type MetadataApi,
} from "src/hooks/useDatabaseMetadata";
import { canExecute, useObjectDraftStore } from "src/stores/objectDrafts";
import { useScreenStore } from "src/stores/screen";
import type { DatabaseObjectItem } from "src/types";
import { reconcileObjectDraftsOnMetadataLoads } from "./objectReconcile";
import { resetTabRuntimes, seedTabRuntime } from "src/test/fixtures/tabRuntime";

const mocks = vi.hoisted(() => ({
  objects: [] as DatabaseObjectItem[],
  runSqlQuery: vi.fn(),
}));

vi.mock("src/lib/tauri/query", () => ({ runSqlQuery: mocks.runSqlQuery }));
vi.mock("src/lib/tauri", () => ({
  connectionVersion: vi.fn(async () => "16"),
}));
vi.mock("src/lib/databaseObjects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/databaseObjects")>()),
  parseDatabaseObjectsFromRows: () => mocks.objects,
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

const fn = buildDatabaseObjectItem({
  engine: "postgres",
  kind: "function",
  schema: "public",
  name: "calc",
  signature: "",
});
const EDIT = `obj:${fn.id}`;
const META = "postgres:t1";
const drafts = () => useObjectDraftStore.getState();
const draft = () => drafts().drafts.t1?.[EDIT];

let api!: MetadataApi;
function Harness() {
  api = useDatabaseMetadata();
  return null;
}

function seedEdit(sql: string) {
  drafts().ensureEditDraft("t1", EDIT, fn);
  drafts().applyDefinition("t1", EDIT, draft()!.generation, "v1", fn);
  drafts().setSql("t1", EDIT, sql);
}

const refresh = () =>
  act(async () => {
    await api.refresh({
      metaKey: META,
      engine: "postgres",
      connectionId: "c1",
    });
  });

let unsubscribe: () => void;
beforeEach(() => {
  drafts().clearAll();
  mocks.objects = [];
  mocks.runSqlQuery.mockReset().mockResolvedValue({ rows: [] });
  useScreenStore.setState({
    profileTabs: [
      { id: "t1", engine: "postgres", runtimeConnectionId: "c1" } as never,
    ],
    tabEpoch: {},
  });
  resetTabRuntimes();
  seedTabRuntime({ tabId: "t1", runtimeId: "c1" });
  useScreenStore.setState({ tabEpoch: {} });
  unsubscribe = reconcileObjectDraftsOnMetadataLoads();
  render(<Harness />);
});
afterEach(() => unsubscribe());

describe("object drafts follow complete metadata loads", () => {
  it("blocks a dirty edit of an externally dropped object, then clears", async () => {
    seedEdit("v2");
    await refresh();
    expect(draft()!.missing).toBe(true);
    expect(canExecute(draft()!)).toBe(false);

    mocks.objects = [fn];
    await refresh();
    expect(draft()!.missing).toBe(false);
  });

  it("drops a clean edit of a vanished object", async () => {
    seedEdit("v1");
    await refresh();
    expect(draft()).toBeUndefined();
  });

  it("changes nothing when the load fails", async () => {
    seedEdit("v2");
    mocks.runSqlQuery.mockRejectedValue(new Error("boom"));
    await refresh();
    expect(draft()!.missing).toBe(false);
  });

  it("ignores a load overtaken by a reconnect, reset or a newer draft", async () => {
    let pending: Array<() => void> = [];
    const gate = () => {
      pending = [];
      mocks.runSqlQuery.mockClear();
      mocks.runSqlQuery.mockImplementation(
        () =>
          new Promise((resolve) => pending.push(() => resolve({ rows: [] })))
      );
    };
    const release = async () => {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.forEach((r) => r());
    };

    seedEdit("v2");
    gate();
    let run = refresh();
    useScreenStore.getState().updateTab("t1", { runtimeConnectionId: "c2" });
    useScreenStore.getState().updateTab("t1", { runtimeConnectionId: "c1" });
    await release();
    await run;
    expect(draft()!.missing).toBe(false);

    // A draft re-created while the load runs is newer than its list.
    drafts().clearAll();
    gate();
    run = refresh();
    seedEdit("v2");
    await release();
    await run;
    expect(draft()!.missing).toBe(false);
  });
});
