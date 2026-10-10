import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  listModels: vi.fn(),
  cancelListModels: vi.fn(),
  testDraft: vi.fn(),
  legacyInfo: vi.fn(),
}));

vi.mock("src/lib/tauri/ai", () => ({
  aiProviderList: (...args: any[]) => mocks.list(...args),
  aiProviderSave: (...args: any[]) => mocks.save(...args),
  aiProviderDelete: vi.fn(),
  aiProviderListModels: (...args: any[]) => mocks.listModels(...args),
  aiProviderCancelListModels: (...args: any[]) =>
    mocks.cancelListModels(...args),
  aiProviderTestDraft: (...args: any[]) => mocks.testDraft(...args),
  aiLegacyModelInfo: (...args: any[]) => mocks.legacyInfo(...args),
  aiLegacyModelDelete: vi.fn(),
}));

vi.mock("src/components/common/Button", () => ({
  Button: ({ children, loading, ...props }: any) => (
    <button {...props} disabled={props.disabled || loading}>
      {children}
    </button>
  ),
}));

import { AiAssistantSettingsDialog } from "./AiAssistantSettingsDialog";

const LM_STUDIO = {
  id: "lmstudio-1",
  kind: "local_openai_compatible",
  label: "LM Studio",
  host: "http://127.0.0.1:1234",
  subPath: "/v1",
  baseUrl: "http://127.0.0.1:1234/v1",
  defaultModel: "qwen",
  models: ["qwen"],
  apiKeyRef: "politedb:ai:lmstudio-1:api_key",
  enabled: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function openDialog() {
  render(<AiAssistantSettingsDialog open onClose={() => {}} />);
  await screen.findByDisplayValue("LM Studio");
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem("politedb.ai.provider.selected", "lmstudio-1");
  mocks.list.mockResolvedValue([LM_STUDIO]);
  mocks.legacyInfo.mockResolvedValue({ files: [] });
  mocks.cancelListModels.mockResolvedValue(undefined);
});

describe("AiAssistantSettingsDialog", () => {
  it("never sends the stored key when the form removes it (Load models / Test)", async () => {
    mocks.listModels.mockResolvedValue(["qwen"]);
    mocks.testDraft.mockResolvedValue(undefined);
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Remove stored key" }));
    fireEvent.click(screen.getByRole("button", { name: /Load models/ }));
    await waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
    expect(mocks.listModels.mock.calls[0][1]).toEqual({ action: "remove" });

    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(mocks.testDraft).toHaveBeenCalled());
    expect(mocks.testDraft.mock.calls[0][1]).toEqual({ action: "remove" });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("ignores a model list that arrives after the URL changed, keeping edits", async () => {
    const pending = deferred<string[]>();
    mocks.listModels.mockReturnValue(pending.promise);
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: /Load models/ }));
    await waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
    const cancelsBeforeEdit = mocks.cancelListModels.mock.calls.length;

    fireEvent.change(screen.getByDisplayValue("http://127.0.0.1:1234"), {
      target: { value: "http://192.168.1.9:1234" },
    });
    // The URL edit cancels the backend request and invalidates its result.
    expect(mocks.cancelListModels.mock.calls.length).toBe(
      cancelsBeforeEdit + 1
    );
    pending.resolve(["stale-model"]);

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("stale-model")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("http://192.168.1.9:1234")).toBeTruthy();
  });

  it("merges a discovered list into models added while it was loading", async () => {
    const pending = deferred<string[]>();
    mocks.listModels.mockReturnValue(pending.promise);
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: /Load models/ }));
    await waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
    const combo = screen.getByRole("combobox");
    fireEvent.input(combo, { target: { value: "typed-model" } });
    fireEvent.keyDown(combo, { key: "Enter" });
    pending.resolve(["server-model"]);

    await screen.findByText("server-model");
    expect(screen.getByText("typed-model")).toBeInTheDocument();
    expect(screen.getByText("qwen")).toBeInTheDocument();
  });

  it("saves offline setup without a model and without any network call", async () => {
    mocks.list.mockResolvedValue([
      { ...LM_STUDIO, defaultModel: "", models: [], enabled: false },
    ]);
    mocks.save.mockImplementation(async (config: any) => config);
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const [config, keyChange] = mocks.save.mock.calls[0];
    expect(config.defaultModel).toBe("");
    expect(config.enabled).toBe(false);
    expect(keyChange).toEqual({ action: "keep" });
    expect(mocks.listModels).not.toHaveBeenCalled();
    expect(mocks.testDraft).not.toHaveBeenCalled();
  });

  it("reloads the provider from disk when the save rollback failed", async () => {
    mocks.save.mockRejectedValue("AI_PROVIDER_SAVE_ROLLBACK_FAILED");
    await openDialog();
    mocks.list.mockResolvedValue([{ ...LM_STUDIO, label: "On disk" }]);

    fireEvent.change(screen.getByDisplayValue("LM Studio"), {
      target: { value: "Edited" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByDisplayValue("On disk");
    expect(screen.getByText("AI_PROVIDER_SAVE_ROLLBACK_FAILED")).toBeTruthy();
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("does not re-add a model removed while discovery was running", async () => {
    const pending = deferred<string[]>();
    mocks.listModels.mockReturnValue(pending.promise);
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: /Load models/ }));
    await waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Remove qwen" }));
    pending.resolve(["qwen", "llama3:8b"]);

    await screen.findByText("llama3:8b");
    expect(screen.queryByText("qwen")).not.toBeInTheDocument();
  });

  it("scopes discovery cancellation to its own request id", async () => {
    const pending = deferred<string[]>();
    mocks.listModels.mockReturnValue(pending.promise);
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: /Load models/ }));
    await waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
    const requestId = mocks.listModels.mock.calls[0][2];
    expect(requestId).toMatch(/^settings-/);

    fireEvent.change(screen.getByDisplayValue("http://127.0.0.1:1234"), {
      target: { value: "http://10.0.0.2:1234" },
    });
    expect(mocks.cancelListModels).toHaveBeenLastCalledWith(requestId);
    expect(
      mocks.cancelListModels.mock.calls.every(([id]) => id === requestId)
    ).toBe(true);
    pending.resolve([]);
  });

  it("does not change the chat selection when deleting the selected provider", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.list.mockResolvedValueOnce([LM_STUDIO]).mockResolvedValue([]);
    const selected = vi.fn();
    window.addEventListener("politedb-ai-provider-selected", selected);
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));

    window.removeEventListener("politedb-ai-provider-selected", selected);
    expect(selected).not.toHaveBeenCalled();
    expect(localStorage.getItem("politedb.ai.provider.selected")).toBe(
      "lmstudio-1"
    );
  });

  it("suggests models for the provider and adds the picked one", async () => {
    mocks.list.mockResolvedValue([
      {
        id: "gemini-1",
        kind: "gemini",
        label: "Google AI",
        host: "https://generativelanguage.googleapis.com",
        subPath: "/v1beta",
        defaultModel: "gemini-2.5-flash",
        models: ["gemini-2.5-flash"],
        apiKeyRef: "politedb:ai:gemini-1:api_key",
        enabled: true,
      },
    ]);
    localStorage.setItem("politedb.ai.provider.selected", "gemini-1");
    render(<AiAssistantSettingsDialog open onClose={() => {}} />);
    await screen.findByDisplayValue("Google AI");

    const combo = screen.getByRole("combobox");
    fireEvent.focus(combo);
    fireEvent.input(combo, { target: { value: "pro" } });
    const option = await screen.findByRole("option", {
      name: "gemini-2.5-pro",
    });
    // Already-selected models are not suggested again.
    expect(
      screen.queryByRole("option", { name: "gemini-2.5-flash" })
    ).not.toBeInTheDocument();
    fireEvent.mouseDown(option);

    expect(screen.getByText("gemini-2.5-pro")).toBeInTheDocument();
    expect((combo as HTMLInputElement).value).toBe("");
  });

  it("adds a custom id with Enter and supports keyboard selection", async () => {
    await openDialog();
    const combo = screen.getByRole("combobox");
    fireEvent.focus(combo);
    fireEvent.input(combo, { target: { value: "my-finetune:latest" } });
    expect(
      screen.getByRole("option", { name: 'Add "my-finetune:latest"' })
    ).toBeInTheDocument();
    fireEvent.keyDown(combo, { key: "ArrowDown" });
    fireEvent.keyDown(combo, { key: "Enter" });
    expect(screen.getByText("my-finetune:latest")).toBeInTheDocument();

    fireEvent.keyDown(combo, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
