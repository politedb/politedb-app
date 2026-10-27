import { h } from "preact";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  secretsList: vi.fn(),
  secretsGet: vi.fn(),
  secretsSet: vi.fn(),
  secretsDelete: vi.fn(),
  aiProviderList: vi.fn(),
  profileList: vi.fn(),
  confirmDialog: vi.fn(),
}));
vi.mock("src/lib/tauri", () => ({
  secretsList: tauri.secretsList,
  secretsGet: tauri.secretsGet,
  secretsSet: tauri.secretsSet,
  secretsDelete: tauri.secretsDelete,
}));
vi.mock("src/lib/tauri/ai", () => ({ aiProviderList: tauri.aiProviderList }));
vi.mock("src/lib/tauri/profile", () => ({ profileList: tauri.profileList }));
vi.mock("src/lib/system-dialog", () => ({
  confirmDialog: tauri.confirmDialog,
}));

import { KeychainSection } from "./KeychainSection";

const dbKey = (id: string) => `politedb/profile/${id}/credential/database`;
const live = {
  id: "live",
  engine: "postgres",
  label: "Live DB",
  input: { postgres: { host: "db", port: 5432, database: "app" } },
};

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function renderSection() {
  return render(
    h(KeychainSection, {
      searchQuery: "",
      viewMode: "grid",
      sortMode: "label-asc",
      newSignal: 0,
      editorOpen: false,
      onEditorOpenChange: vi.fn(),
    })
  );
}

const card = (text: string) =>
  screen.getByText(text).closest('[role="button"]') as HTMLElement;

beforeEach(() => {
  (window as any).__TAURI_INTERNALS__ = {};
  Object.values(tauri).forEach((fn) => fn.mockReset());
  tauri.secretsList.mockResolvedValue([dbKey("live"), dbKey("gone")]);
  tauri.aiProviderList.mockResolvedValue([]);
  tauri.profileList.mockResolvedValue([live]);
  tauri.confirmDialog.mockResolvedValue(true);
  tauri.secretsDelete.mockResolvedValue(undefined);
});

afterEach(() => {
  delete (window as any).__TAURI_INTERNALS__;
});

describe("KeychainSection unused keys", () => {
  it("offers no cleanup while the owners cannot be loaded", async () => {
    tauri.profileList.mockRejectedValue(new Error("store locked"));
    renderSection();

    expect(
      await screen.findByText(/unused keys\s+cannot be identified/)
    ).toBeTruthy();
    expect(screen.queryByText(/^Unused \(/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete unused" })).toBeNull();
  });

  it("clears the warning when a later load succeeds", async () => {
    tauri.aiProviderList.mockRejectedValueOnce(new Error("offline"));
    renderSection();
    await screen.findByText(/cannot be identified/);

    await act(async () => {
      window.dispatchEvent(new Event("politedb-ai-providers-changed"));
    });

    await waitFor(() =>
      expect(screen.queryByText(/cannot be identified/)).toBeNull()
    );
    expect(screen.getByText("Unused (1)")).toBeTruthy();
  });

  it("deletes after confirming, then shows what the keychain holds", async () => {
    renderSection();
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete unused" })
    );

    // The delete rejects although one copy went: the list is read again.
    tauri.secretsDelete.mockRejectedValueOnce(new Error("alias lookup failed"));
    tauri.secretsList.mockResolvedValueOnce([dbKey("live")]);

    await screen.findByRole("status");
    expect(tauri.secretsDelete).toHaveBeenCalledWith(dbKey("gone"));
    expect(screen.getByRole("status").textContent).toContain(
      "Could not delete 1 key: alias lookup failed"
    );
    expect(screen.queryByText("Unused connection key")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("starts no read while a cleanup is running", async () => {
    const del = deferred();
    tauri.secretsDelete.mockReturnValue(del.promise);
    renderSection();
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete unused" })
    );
    await waitFor(() => expect(tauri.secretsDelete).toHaveBeenCalled());

    fireEvent.dblClick(card("Live DB"));
    expect(tauri.secretsGet).not.toHaveBeenCalled();

    await act(async () => del.resolve());
  });
});

describe("KeychainSection storage note", () => {
  it("says where keys are stored once for the page, not per group", async () => {
    renderSection();
    // Two groups: a used database key and an unused one.
    await screen.findByText("Unused (1)");
    expect(screen.getAllByText(/^Stored securely in /)).toHaveLength(1);
  });
});
