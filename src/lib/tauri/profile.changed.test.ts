import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { PROFILE_CHANGED_EVENT, profileImport, profileRemove } from "./profile";

describe("profile change notification", () => {
  it("is sent even when removal fails after committing", async () => {
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener(PROFILE_CHANGED_EVENT, listener);
    invoke.mockRejectedValueOnce(new Error("AI_DATA_ACCESS_WRITE_FAILED"));
    await expect(profileRemove("p1")).rejects.toThrow();
    invoke.mockResolvedValueOnce(undefined);
    await profileRemove("p2");
    window.removeEventListener(PROFILE_CHANGED_EVENT, listener);
    expect(seen).toEqual(["p1", "p2"]);
  });

  it("is sent for every profile an import wrote", async () => {
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener(PROFILE_CHANGED_EVENT, listener);
    invoke.mockResolvedValueOnce({
      created: 1,
      updated: 1,
      total: 3,
      profiles: [],
      importedIds: ["a", "b"],
    });
    await profileImport("{}");
    window.removeEventListener(PROFILE_CHANGED_EVENT, listener);
    expect(seen).toEqual(["a", "b"]);
  });
});
