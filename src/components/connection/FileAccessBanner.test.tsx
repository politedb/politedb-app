import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ ensure: vi.fn(), message: vi.fn() }));

vi.mock("src/lib/file-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/file-access")>()),
  ensureFileAccess: (...a: any[]) => mocks.ensure(...a),
}));
vi.mock("src/lib/system-dialog", () => ({
  showMessage: (...a: any[]) => mocks.message(...a),
  confirmDialog: vi.fn(),
}));

import { FileAccessBanner } from "./FileAccessBanner";

const DB = { role: "database_folder" as const, path: "/Users/me/data/app.db" };
const KEY = { role: "ssh_key" as const, path: "/Users/me/.ssh/id" };

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FileAccessBanner", () => {
  it("does nothing until the user clicks Grant Access", async () => {
    const onGranted = vi.fn();
    mocks.ensure.mockResolvedValue(true);
    render(
      <FileAccessBanner
        error={{ code: "FILE_ACCESS_REQUIRED", role: "ssh_key" }}
        requests={[DB, KEY]}
        scope="tab-1:p1"
        onGranted={onGranted}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/SSH key/);
    expect(mocks.ensure).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Grant Access/ }));
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
    expect(mocks.ensure).toHaveBeenCalledWith([DB, KEY], {
      force: [KEY],
      confirm: false,
    });
  });

  it("does not reconnect when the user cancels", async () => {
    const onGranted = vi.fn();
    mocks.ensure.mockResolvedValue(false);
    render(
      <FileAccessBanner
        error={{ code: "FILE_ACCESS_REQUIRED", role: "database_folder" }}
        requests={[DB]}
        scope="tab-1:p1"
        onGranted={onGranted}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Grant Access/ }));
    await waitFor(() => expect(mocks.ensure).toHaveBeenCalled());
    expect(onGranted).not.toHaveBeenCalled();
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("ignores a grant that finishes after the tab was closed or switched", async () => {
    let resolve!: (v: boolean) => void;
    mocks.ensure.mockImplementation(() => new Promise((r) => (resolve = r)));
    const onGranted = vi.fn();
    const error = {
      code: "FILE_ACCESS_REQUIRED" as const,
      role: "database_folder" as const,
    };
    const view = render(
      <FileAccessBanner
        error={error}
        requests={[DB]}
        scope="tab-1:p1"
        onGranted={onGranted}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Grant Access/ }));
    await waitFor(() => expect(mocks.ensure).toHaveBeenCalledTimes(1));
    // Switched to another tab (same screen component, new scope).
    view.rerender(
      <FileAccessBanner
        error={error}
        requests={[DB]}
        scope="tab-2:p2"
        onGranted={onGranted}
      />
    );
    resolve(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(onGranted).not.toHaveBeenCalled();

    // Closed while the picker was open.
    fireEvent.click(screen.getByRole("button", { name: /Grant Access/ }));
    await waitFor(() => expect(mocks.ensure).toHaveBeenCalledTimes(2));
    view.unmount();
    resolve(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(onGranted).not.toHaveBeenCalled();
  });
});
