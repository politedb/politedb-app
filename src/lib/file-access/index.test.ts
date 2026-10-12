import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  missing: vi.fn(),
  pickDatabase: vi.fn(),
  pickSshKey: vi.fn(),
  confirm: vi.fn(),
  track: vi.fn(),
}));

vi.mock("src/lib/tauri/fileAccess", () => ({
  fileAccessMissing: (...a: any[]) => mocks.missing(...a),
  fileAccessPickDatabase: (...a: any[]) => mocks.pickDatabase(...a),
  fileAccessPickSshKey: (...a: any[]) => mocks.pickSshKey(...a),
}));
vi.mock("src/lib/system-dialog", () => ({
  confirmDialog: (...a: any[]) => mocks.confirm(...a),
}));
vi.mock("src/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mocks.track(...a),
}));

import { featuresFor } from "src/lib/distribution";
import {
  describeFileAccessError,
  ensureFileAccess,
  failedBeforePersistence,
  FileAccessCancelled,
  isFileAccessCancelled,
  fileAccessRequests,
  parseFileAccessError,
  withFileAccessRecovery,
} from "./index";

const MAS = featuresFor("appstore");
const DIRECT = featuresFor("direct");
const DB = { role: "database_folder" as const, path: "/Users/me/data/app.db" };
const KEY = { role: "ssh_key" as const, path: "/Users/me/.ssh/id_ed25519" };
const REQUIRED_DB = new Error(
  'RUNTIME_CONNECT_FAILED: FILE_ACCESS_REQUIRED:{"role":"database_folder"}'
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.missing.mockResolvedValue([]);
  mocks.confirm.mockResolvedValue(true);
  mocks.pickDatabase.mockResolvedValue(DB.path);
  mocks.pickSshKey.mockResolvedValue(KEY.path);
});

describe("parseFileAccessError", () => {
  it("finds codes behind backend prefixes", () => {
    expect(parseFileAccessError(REQUIRED_DB)).toEqual({
      code: "FILE_ACCESS_REQUIRED",
      role: "database_folder",
    });
    expect(parseFileAccessError("FILE_ACCESS_WRONG_FILE")).toEqual({
      code: "FILE_ACCESS_WRONG_FILE",
      role: undefined,
    });
    expect(
      parseFileAccessError('FILE_ACCESS_REQUIRED:{"role":"x"}')?.role
    ).toBe(undefined);
    expect(parseFileAccessError("SQLITE_OPEN_FAILED")).toBeNull();
  });

  it("describes errors without paths", () => {
    expect(describeFileAccessError(REQUIRED_DB)).toMatch(/database file/);
    expect(describeFileAccessError("other")).toBeNull();
  });
});

describe("fileAccessRequests", () => {
  it("lists database and key files, skipping in-memory and password auth", () => {
    expect(
      fileAccessRequests({
        engine: "sqlite",
        label: "x",
        sqlite: { path: DB.path },
        ssh: { auth: { kind: "private_key", identity_file: KEY.path } },
      } as any)
    ).toEqual([DB, KEY]);
    expect(
      fileAccessRequests({
        engine: "duckdb",
        label: "x",
        duckdb: { path: ":memory:" },
        ssh: { auth: { kind: "password", password: "" } },
      } as any)
    ).toEqual([]);
  });
});

describe("ensureFileAccess", () => {
  it("does nothing in direct builds", async () => {
    expect(await ensureFileAccess([DB], {}, DIRECT)).toBe(true);
    expect(mocks.missing).not.toHaveBeenCalled();
  });

  it("asks once, then picks every missing file", async () => {
    mocks.missing.mockResolvedValue([DB, KEY]);
    expect(await ensureFileAccess([DB, KEY], {}, MAS)).toBe(true);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.pickDatabase).toHaveBeenCalledWith("open", DB.path);
    expect(mocks.pickSshKey).toHaveBeenCalledWith(KEY.path);
  });

  it("stops when the user declines or cancels", async () => {
    mocks.missing.mockResolvedValue([DB]);
    mocks.confirm.mockResolvedValueOnce(false);
    expect(await ensureFileAccess([DB], {}, MAS)).toBe(false);
    expect(mocks.pickDatabase).not.toHaveBeenCalled();
    mocks.pickDatabase.mockResolvedValueOnce(null);
    expect(await ensureFileAccess([DB], {}, MAS)).toBe(false);
  });

  it("coalesces concurrent pickers for the same file", async () => {
    mocks.missing.mockResolvedValue([DB]);
    let resolve!: (v: string) => void;
    mocks.pickDatabase.mockReturnValue(new Promise((r) => (resolve = r)));
    const a = ensureFileAccess([DB], {}, MAS);
    const b = ensureFileAccess([DB], {}, MAS);
    await vi.waitFor(() => expect(mocks.pickDatabase).toHaveBeenCalled());
    resolve(DB.path);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(mocks.pickDatabase).toHaveBeenCalledTimes(1);
  });

  it("shares one prompt between concurrent callers", async () => {
    mocks.missing.mockResolvedValue([DB]);
    const results = await Promise.all([
      ensureFileAccess([DB], {}, MAS),
      ensureFileAccess([DB], {}, MAS),
    ]);
    expect(results).toEqual([true, true]);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.pickDatabase).toHaveBeenCalledTimes(1);
  });

  it("skips the confirmation after an explicit Grant Access click", async () => {
    mocks.missing.mockResolvedValue([DB]);
    expect(await ensureFileAccess([DB], { confirm: false }, MAS)).toBe(true);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("surfaces unavailable files instead of opening pickers", async () => {
    mocks.missing.mockRejectedValue(
      'FILE_ACCESS_UNAVAILABLE:{"role":"ssh_key"}'
    );
    await expect(ensureFileAccess([KEY], {}, MAS)).rejects.toMatch(
      "FILE_ACCESS_UNAVAILABLE"
    );
    expect(mocks.pickSshKey).not.toHaveBeenCalled();
  });

  it("sends only role and outcome to analytics", async () => {
    mocks.missing.mockResolvedValue([DB]);
    await ensureFileAccess([DB], {}, MAS);
    expect(mocks.track).toHaveBeenCalledWith("file_access_grant", {
      role: "database_folder",
      outcome: "granted",
    });
    expect(JSON.stringify(mocks.track.mock.calls)).not.toContain("/Users/me");
  });
});

describe("withFileAccessRecovery", () => {
  it("retries once after a stale grant is replaced", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(REQUIRED_DB)
      .mockResolvedValueOnce("ok");
    expect(await withFileAccessRecovery(run, [DB], {}, MAS)).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(mocks.pickDatabase).toHaveBeenCalledTimes(1);
  });

  it("does not retry other errors or loop on repeated failures", async () => {
    const other = vi.fn().mockRejectedValue(new Error("AUTH_FAILED"));
    await expect(withFileAccessRecovery(other, [DB], {}, MAS)).rejects.toThrow(
      "AUTH_FAILED"
    );
    expect(other).toHaveBeenCalledTimes(1);

    const always = vi.fn().mockRejectedValue(REQUIRED_DB);
    await expect(withFileAccessRecovery(always, [DB], {}, MAS)).rejects.toBe(
      REQUIRED_DB
    );
    expect(always).toHaveBeenCalledTimes(2);
  });

  it("stops before running when the user declines or cancels up front", async () => {
    mocks.missing.mockResolvedValue([DB]);
    mocks.confirm.mockResolvedValueOnce(false);
    const run = vi.fn().mockResolvedValue("saved");
    await expect(
      withFileAccessRecovery(run, [DB], {}, MAS)
    ).rejects.toBeInstanceOf(FileAccessCancelled);
    mocks.pickDatabase.mockResolvedValueOnce(null);
    await expect(withFileAccessRecovery(run, [DB], {}, MAS)).rejects.toSatisfy(
      isFileAccessCancelled
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("stops after a failed run when the user cancels the re-grant", async () => {
    mocks.pickDatabase.mockResolvedValue(null);
    const run = vi.fn().mockRejectedValue(REQUIRED_DB);
    await expect(
      withFileAccessRecovery(run, [DB], {}, MAS)
    ).rejects.toBeInstanceOf(FileAccessCancelled);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries save-and-connect only when nothing was persisted", async () => {
    const early = new Error('FILE_ACCESS_REQUIRED:{"role":"database_folder"}');
    const run = vi
      .fn()
      .mockRejectedValueOnce(early)
      .mockResolvedValueOnce("ok");
    expect(
      await withFileAccessRecovery(
        run,
        [DB],
        { retryIf: failedBeforePersistence },
        MAS
      )
    ).toBe("ok");

    const late = vi.fn().mockRejectedValue(REQUIRED_DB);
    await expect(
      withFileAccessRecovery(
        late,
        [DB],
        { retryIf: failedBeforePersistence },
        MAS
      )
    ).rejects.toBe(REQUIRED_DB);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("runs directly in direct builds", async () => {
    const run = vi.fn().mockResolvedValue(1);
    expect(await withFileAccessRecovery(run, [DB], {}, DIRECT)).toBe(1);
    expect(mocks.missing).not.toHaveBeenCalled();
  });
});

describe("errorCode (analytics)", () => {
  it("keeps the leading code and drops text that may hold paths", async () => {
    const { errorCode } =
      await vi.importActual<typeof import("src/lib/analytics")>(
        "src/lib/analytics"
      );
    expect(
      errorCode(new Error("SQLITE_OPEN_FAILED: unable to open /Users/me/x.db"))
    ).toBe("SQLITE_OPEN_FAILED");
    expect(errorCode(REQUIRED_DB)).toBe("RUNTIME_CONNECT_FAILED");
    expect(errorCode("could not open /Users/me/x.db")).toBe("OTHER");
  });
});
