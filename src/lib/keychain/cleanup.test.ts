import { describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "src/lib/tauri/types";
import { deleteUnusedKeys, describeUnusedKeyCleanup } from "./cleanup";

const dbKey = (id: string) => `politedb/profile/${id}/credential/database`;
const profile = (id: string) =>
  ({
    id,
    engine: "postgres",
    label: id,
    input: {},
  }) as unknown as ConnectionProfile;

describe("deleteUnusedKeys", () => {
  it("checks the owners again and skips keys that are in use now", async () => {
    const deleteKey = vi.fn().mockResolvedValue(undefined);
    // "a" looked unused on screen, but its connection exists by now.
    const result = await deleteUnusedKeys([dbKey("a"), dbKey("gone")], {
      loadOwners: async () => ({ profiles: [profile("a")], aiProviders: [] }),
      deleteKey,
    });

    expect(deleteKey.mock.calls).toEqual([[dbKey("gone")]]);
    expect(result).toEqual({
      deleted: [dbKey("gone")],
      failed: [],
      skipped: [dbKey("a")],
    });
  });

  it("deletes nothing when the owners cannot be loaded", async () => {
    const deleteKey = vi.fn();
    await expect(
      deleteUnusedKeys([dbKey("gone")], {
        loadOwners: async () => {
          throw new Error("profile store locked");
        },
        deleteKey,
      })
    ).rejects.toThrow("profile store locked");
    expect(deleteKey).not.toHaveBeenCalled();
  });

  it("keeps going after a failure and reports every outcome", async () => {
    const deleteKey = vi.fn(async (key: string) => {
      if (key === dbKey("b")) throw new Error("keychain locked");
    });
    const result = await deleteUnusedKeys(
      [dbKey("a"), dbKey("b"), dbKey("c")],
      { loadOwners: async () => ({ profiles: [], aiProviders: [] }), deleteKey }
    );

    expect(result.deleted).toEqual([dbKey("a"), dbKey("c")]);
    expect(result.failed).toEqual([
      { key: dbKey("b"), error: "keychain locked" },
    ]);
    expect(describeUnusedKeyCleanup(result)).toBe(
      "Deleted 2 unused keys. Could not delete 1 key: keychain locked"
    );
  });

  it("describes all-failed, skipped and empty cleanups", () => {
    expect(
      describeUnusedKeyCleanup({
        deleted: [],
        failed: [{ key: "x", error: "denied" }],
        skipped: [],
      })
    ).toBe("Could not delete 1 key: denied");
    expect(
      describeUnusedKeyCleanup({
        deleted: ["x"],
        failed: [],
        skipped: ["y", "z"],
      })
    ).toBe("Deleted 1 unused key. Kept 2 keys that are in use now.");
    expect(
      describeUnusedKeyCleanup({ deleted: [], failed: [], skipped: [] })
    ).toBe("Nothing to delete.");
  });
});
