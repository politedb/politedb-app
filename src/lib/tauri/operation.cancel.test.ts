import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { operationCancel } from "./operation";
import { CMD } from "./commands";

describe("operationCancel IPC args", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("passes camelCase opId (Tauri default rename_all)", async () => {
    const id = "37f37825-99c5-4742-af61-62e8fc3a6417";
    await operationCancel(id);
    expect(invokeMock).toHaveBeenCalledWith(CMD.operationCancel, { opId: id });
    // Snake_case would miss the IPC key and silently fail cancel → sql_busy stuck.
    const args = invokeMock.mock.calls[0][1] as Record<string, unknown>;
    expect(args).not.toHaveProperty("op_id");
    expect(args).toHaveProperty("opId", id);
  });
});
