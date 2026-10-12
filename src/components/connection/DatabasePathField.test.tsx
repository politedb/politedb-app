import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pick: vi.fn(), message: vi.fn() }));

vi.mock("src/lib/tauri/fileAccess", () => ({
  fileAccessPickDatabase: (...a: any[]) => mocks.pick(...a),
}));
vi.mock("src/lib/system-dialog", () => ({
  showMessage: (...a: any[]) => mocks.message(...a),
  confirmDialog: vi.fn(),
}));

import { featuresFor } from "src/lib/distribution";
import { DatabasePathField } from "./DatabasePathField";

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DatabasePathField", () => {
  it("direct build keeps the typed path and adds Browse/New", async () => {
    const onChange = vi.fn();
    render(
      <DatabasePathField
        value="/tmp/a.db"
        onChange={onChange}
        features={featuresFor("direct")}
      />
    );
    expect(screen.getByDisplayValue("/tmp/a.db")).toBeTruthy();
    mocks.pick.mockResolvedValue("/tmp/new.db");
    fireEvent.click(screen.getByRole("button", { name: "New…" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("/tmp/new.db"));
    expect(mocks.pick).toHaveBeenCalledWith("create");
  });

  it("sandboxed build cannot type a path but can pick or use memory", async () => {
    const onChange = vi.fn();
    render(
      <DatabasePathField
        value="/Users/me/data/app.db"
        onChange={onChange}
        features={featuresFor("appstore")}
      />
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("app.db")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "In-memory" }));
    expect(onChange).toHaveBeenCalledWith(":memory:");

    mocks.pick.mockResolvedValue(null);
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(mocks.pick).toHaveBeenCalledWith("open"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("explains picker errors", async () => {
    mocks.pick.mockRejectedValue("FILE_ACCESS_FOLDER_TOO_BROAD");
    render(
      <DatabasePathField
        value=""
        onChange={vi.fn()}
        features={featuresFor("appstore")}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() =>
      expect(mocks.message.mock.calls[0][0]).toMatch(/whole disk/)
    );
  });
});
