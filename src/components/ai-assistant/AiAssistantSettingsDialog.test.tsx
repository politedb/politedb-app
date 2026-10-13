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

const LOCAL = {
  id: "ollama-1",
  kind: "ollama",
  label: "My Ollama",
  host: "http://127.0.0.1:11434",
  subPath: "/v1",
  baseUrl: "http://127.0.0.1:11434/v1",
  defaultModel: "qwen",
  models: ["qwen"],
  enabled: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function openDialog() {
  render(<AiAssistantSettingsDialog open onClose={() => {}} />);
  await screen.findByDisplayValue("My Ollama");
}

/** Local providers look up models on open; wait for that and start counting fresh. */
async function settleAutoDiscovery() {
  await waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  mocks.listModels.mockClear();
  mocks.cancelListModels.mockClear();
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem("politedb.ai.provider.selected", "ollama-1");
  mocks.list.mockResolvedValue([LOCAL]);
  mocks.legacyInfo.mockResolvedValue({ files: [] });
  mocks.cancelListModels.mockResolvedValue(undefined);
  mocks.listModels.mockResolvedValue([]);
});

describe("AiAssistantSettingsDialog", () => {
  it("ignores a model list that arrives after the URL changed, keeping edits", async () => {
    await openDialog();
    await settleAutoDiscovery();
    const pending = deferred<string[]>();
    mocks.listModels.mockReturnValue(pending.promise);

    fireEvent.click(screen.getByRole("button", { name: /Load models/ }));
    await waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
    fireEvent.change(screen.getByDisplayValue("http://127.0.0.1:11434"), {
      target: { value: "http://192.168.1.9:11434" },
    });
    expect(mocks.cancelListModels).toHaveBeenCalledTimes(1);
    pending.resolve(["stale-model"]);
    await new Promise((r) => setTimeout(r, 0));

    const combo = screen.getByRole("combobox");
    fireEvent.input(combo, { target: { value: "stale" } });
    expect(
      screen.queryByRole("option", { name: "stale-model" })
    ).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("http://192.168.1.9:11434")).toBeTruthy();
  });
  it("offers server models as suggestions without selecting them", async () => {
    await openDialog();
    await settleAutoDiscovery();
    mocks.listModels.mockResolvedValue(["llama3:8b", "qwen"]);

    fireEvent.click(screen.getByRole("button", { name: /Load models/ }));
    // Manual load opens the picker with the server's models.
    const option = await screen.findByRole("option", { name: "llama3:8b" });
    // Already-selected `qwen` is not offered again; nothing was added automatically.
    expect(
      screen.queryByRole("option", { name: "qwen" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove llama3:8b" })
    ).not.toBeInTheDocument();

    fireEvent.mouseDown(option);
    expect(
      screen.getByRole("button", { name: "Remove llama3:8b" })
    ).toBeInTheDocument();
  });
  it("saves offline setup without a model and without any network call", async () => {
    mocks.list.mockResolvedValue([
      { ...LOCAL, defaultModel: "", models: [], enabled: false },
    ]);
    mocks.save.mockImplementation(async (config: any) => config);
    await openDialog();
    await settleAutoDiscovery();

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
    mocks.list.mockResolvedValue([{ ...LOCAL, label: "On disk" }]);

    fireEvent.change(screen.getByDisplayValue("My Ollama"), {
      target: { value: "Edited" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByDisplayValue("On disk");
    expect(screen.getByText("AI_PROVIDER_SAVE_ROLLBACK_FAILED")).toBeTruthy();
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("looks up local models on open and shows guidance when the server is down", async () => {
    mocks.list.mockResolvedValue([{ ...LOCAL, models: [], defaultModel: "" }]);
    mocks.listModels.mockRejectedValue("AI_CHAT_REQUEST_FAILED: connect");
    await openDialog();

    await waitFor(() => expect(mocks.listModels).toHaveBeenCalledTimes(1));
    expect(mocks.listModels.mock.calls[0][1]).toEqual({ action: "keep" });
    await screen.findByText(/Couldn't reach the server/);
    // A silent lookup never shows the raw error.
    expect(
      screen.queryByText("AI_CHAT_REQUEST_FAILED: connect")
    ).not.toBeInTheDocument();
  });

  it("looks up models again after the server URL is edited", async () => {
    mocks.list.mockResolvedValue([{ ...LOCAL, models: [], defaultModel: "" }]);
    await openDialog();
    await settleAutoDiscovery();
    mocks.listModels.mockResolvedValue(["phi-4"]);
    const host = screen.getByDisplayValue("http://127.0.0.1:11434");
    // preact/compat maps onChange/onBlur to input/focusout; testing-library's
    // focusOut helper does not reach that listener, so dispatch a native event.
    fireEvent.input(host, { target: { value: "http://127.0.0.1:11435" } });
    await new Promise((r) => setTimeout(r, 0));
    host.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

    await waitFor(() => expect(mocks.listModels).toHaveBeenCalledTimes(1));
    expect(mocks.listModels.mock.calls[0][0].baseUrl).toBe(
      "http://127.0.0.1:11435/v1"
    );
    await screen.findByText(/1 model found on the server/);
  });
  it("scopes discovery cancellation to its own request id", async () => {
    await openDialog();
    await settleAutoDiscovery();
    const pending = deferred<string[]>();
    mocks.listModels.mockReturnValue(pending.promise);

    fireEvent.click(screen.getByRole("button", { name: /Load models/ }));
    await waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
    const requestId = mocks.listModels.mock.calls[0][2];
    expect(requestId).toMatch(/^settings-/);

    fireEvent.change(screen.getByDisplayValue("http://127.0.0.1:11434"), {
      target: { value: "http://10.0.0.2:11434" },
    });
    expect(mocks.cancelListModels).toHaveBeenLastCalledWith(requestId);
    const prefix = requestId.split(":")[0];
    expect(
      mocks.cancelListModels.mock.calls.every(([id]) =>
        String(id).startsWith(`${prefix}:`)
      )
    ).toBe(true);
    pending.resolve([]);
  });
  it("does not change the chat selection when deleting the selected provider", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.list.mockResolvedValueOnce([LOCAL]).mockResolvedValue([]);
    const selected = vi.fn();
    window.addEventListener("politedb-ai-provider-selected", selected);
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));

    window.removeEventListener("politedb-ai-provider-selected", selected);
    expect(selected).not.toHaveBeenCalled();
    expect(localStorage.getItem("politedb.ai.provider.selected")).toBe(
      "ollama-1"
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

  it("renders suggestions outside the dialog and Escape closes only the list", async () => {
    const onClose = vi.fn();
    mocks.list.mockResolvedValue([
      { ...LOCAL, kind: "openai", id: "openai-1", label: "OpenAI" },
    ]);
    localStorage.setItem("politedb.ai.provider.selected", "openai-1");
    render(<AiAssistantSettingsDialog open onClose={onClose} />);
    await screen.findByDisplayValue("OpenAI");

    const combo = screen.getByRole("combobox");
    fireEvent.focus(combo);
    fireEvent.input(combo, { target: { value: "gpt" } });
    const listbox = await screen.findByRole("listbox");
    // Portaled to <body>, so the dialog's overflow/scroll areas cannot clip it.
    expect(listbox.parentElement).toBe(document.body);
    expect(screen.getByRole("dialog").contains(listbox)).toBe(false);
    // The floating assistant ignores outside clicks only on marked popovers; without
    // this, picking a suggestion closed the whole assistant and the dialog.
    expect(listbox.getAttribute("data-ai-assistant-popover")).toBe("true");

    fireEvent.keyDown(combo, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("drops models found on the previous URL when the URL changes", async () => {
    mocks.list.mockResolvedValue([{ ...LOCAL, models: [], defaultModel: "" }]);
    mocks.listModels.mockResolvedValue(["old-server-model"]);
    await openDialog();
    await screen.findByText(/1 model found on the server/);

    fireEvent.input(screen.getByDisplayValue("http://127.0.0.1:11434"), {
      target: { value: "http://127.0.0.1:19999" },
    });
    await waitFor(() =>
      expect(
        screen.queryByText(/model found on the server/)
      ).not.toBeInTheDocument()
    );
    const combo = screen.getByRole("combobox");
    fireEvent.input(combo, { target: { value: "old" } });
    expect(
      screen.queryByRole("option", { name: "old-server-model" })
    ).not.toBeInTheDocument();
  });

  it("toggles the AI agent beta, off by default", async () => {
    await openDialog();
    const toggle = screen.getByRole("checkbox", { name: /AI agent \(beta\)/ });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    expect(localStorage.getItem("politedb.ai.agent.enabled")).toBe("1");
    fireEvent.click(toggle);
    expect(localStorage.getItem("politedb.ai.agent.enabled")).toBeNull();
  });

  it("lets the agent leave out column comments and defaults, and discloses storage", async () => {
    await openDialog();
    expect(
      screen.getByText(
        /Chat history is stored on this device without encryption/
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /column comments/ })
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /AI agent \(beta\)/ })
    );
    expect(
      screen.getByText(/sent to the selected provider/)
    ).toBeInTheDocument();
    const details = screen.getByRole("checkbox", { name: /column comments/ });
    expect((details as HTMLInputElement).checked).toBe(true);
    fireEvent.click(details);
    expect(localStorage.getItem("politedb.ai.agent.columnDetails")).toBe("0");
    fireEvent.click(details);
    expect(localStorage.getItem("politedb.ai.agent.columnDetails")).toBeNull();
  });
});
