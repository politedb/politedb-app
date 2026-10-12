import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: any[]) => mocks.invoke(...a),
}));

import { profileSaveAndConnect } from "./profile";

const base = {
  engine: "sqlite",
  label: "Local",
  tags: [],
  storeKeychain: false,
  sqlite: { path: "/d/app.db", statement_timeout_ms: 1 },
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue({});
});

describe("profileSaveAndConnect create id", () => {
  it("uses a caller-supplied id for a new profile", async () => {
    await profileSaveAndConnect({
      ...base,
      mode: "create",
      profileId: "fixed-id",
    });
    const [, args] =
      mocks.invoke.mock.calls[mocks.invoke.mock.calls.length - 1];
    expect(args.payload.mode).toBe("create");
    expect(args.payload.profile_id).toBe("fixed-id");
  });

  it("still generates an id when none is given", async () => {
    await profileSaveAndConnect({ ...base, mode: "create" });
    const [, args] =
      mocks.invoke.mock.calls[mocks.invoke.mock.calls.length - 1];
    expect(args.payload.profile_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
