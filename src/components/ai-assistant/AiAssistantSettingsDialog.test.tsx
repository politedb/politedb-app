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
  status: vi.fn(),
}));

vi.mock("src/lib/tauri/ai", () => ({
  aiProviderList: (...args: any[]) => mocks.list(...args),
  aiProviderSave: (...args: any[]) => mocks.save(...args),
  aiProviderDelete: vi.fn(),
  aiProviderListModels: (...args: any[]) => mocks.listModels(...args),
  aiProviderCancelListModels: (...args: any[]) =>
    mocks.cancelListModels(...args),
  aiProviderTestDraft: (...args: any[]) => mocks.testDraft(...args),
  aiOllamaStatus: (...args: any[]) => mocks.status(...args),
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
  mocks.status.mockImplementation(async (_config: any, requestId: string) => ({
    requestId,
    kind: "native",
    version: "0.40.4",
    trainedMax: 8192,
    effective: 8192,
  }));
});

describe("AiAssistantSettingsDialog", () => {
  it("ignores a model list that arrives after the URL changed, keeping edits", async () => {
    await openDialog();
    await settleAutoDiscovery();
    const pending = deferred<string[]>();
    mocks.listModels.mockReturnValue(pending.promise);

    fireEvent.click(screen.getByRole("button", { name: /Reload models/ }));
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

    fireEvent.click(screen.getByRole("button", { name: /Reload models/ }));
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

  it("a failed rollback also shows the context size that is on disk", async () => {
    mocks.save.mockRejectedValue("AI_PROVIDER_SAVE_ROLLBACK_FAILED");
    await openDialog();
    mocks.list.mockResolvedValue([{ ...LOCAL, contextSize: 8192 }]);
    fireEvent.input(screen.getByPlaceholderText("16384"), {
      target: { value: "32768" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        (screen.getByPlaceholderText("16384") as HTMLInputElement).value
      ).toBe("8192")
    );
    // The form now matches the disk: switching does not ask.
    fireEvent.click(screen.getByRole("button", { name: /OpenAI/ }));
    await waitFor(() =>
      expect(screen.queryByDisplayValue("My Ollama")).toBeNull()
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: /Reload models/ }));
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
        defaultModel: "gemini-flash-latest",
        models: ["gemini-flash-latest"],
        apiKeyRef: "politedb:ai:gemini-1:api_key",
        enabled: true,
      },
    ]);
    localStorage.setItem("politedb.ai.provider.selected", "gemini-1");
    render(<AiAssistantSettingsDialog open onClose={() => {}} />);
    await screen.findByDisplayValue("Google AI");

    const combo = screen.getByRole("combobox");
    fireEvent.focus(combo);
    fireEvent.input(combo, { target: { value: "flash" } });
    const option = await screen.findByRole("option", {
      name: "gemini-3.8-flash",
    });
    // Already-selected models are not suggested again.
    expect(
      screen.queryByRole("option", { name: "gemini-flash-latest" })
    ).not.toBeInTheDocument();
    fireEvent.mouseDown(option);

    expect(screen.getByText("gemini-3.8-flash")).toBeInTheDocument();
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

  it("has no agent opt-in", async () => {
    await openDialog();
    expect(
      screen.queryByRole("checkbox", { name: /AI agent/ })
    ).not.toBeInTheDocument();
  });

  it("has no column-details opt-out and discloses storage", async () => {
    await openDialog();
    expect(
      screen.getByText(
        /Chat history is stored on this device without encryption/
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /column comments/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Data access")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/sent to the selected provider/)
    ).not.toBeInTheDocument();
  });

  describe("Ollama context size and server status", () => {
    it("shows the effective agent context for a native server", async () => {
      await openDialog();
      await screen.findByText(
        "Ollama 0.40.4. Agent context: 8192 tokens (model max 8192)."
      );
      const [config, requestId] = mocks.status.mock.calls[0];
      expect(config.baseUrl).toBe("http://127.0.0.1:11434/v1");
      expect(requestId).toMatch(/^settings-.*:status:/);
    });

    it("validates the context size and clamps the shown value locally", async () => {
      mocks.status.mockImplementation(async (_c: any, requestId: string) => ({
        requestId,
        kind: "native",
        version: "0.40.4",
        trainedMax: 262144,
        effective: 16384,
      }));
      mocks.save.mockImplementation(async (config: any) => config);
      await openDialog();
      await screen.findByText(/Agent context: 16384 tokens/);
      const field = screen.getByPlaceholderText("16384");
      fireEvent.input(field, { target: { value: "4096" } });
      await screen.findByText(/Agent context: 4096 tokens/);
      // No server call per keystroke.
      expect(mocks.status).toHaveBeenCalledTimes(1);

      fireEvent.input(field, { target: { value: "100" } });
      await screen.findByRole("alert");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(mocks.save).not.toHaveBeenCalled();

      fireEvent.input(field, { target: { value: "8192" } });
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
      expect(mocks.save.mock.calls[0][0].contextSize).toBe(8192);
    });

    it("an empty context size saves as the default", async () => {
      mocks.list.mockResolvedValue([{ ...LOCAL, contextSize: 4096 }]);
      mocks.save.mockImplementation(async (config: any) => config);
      await openDialog();
      const field = await screen.findByDisplayValue("4096");
      fireEvent.input(field, { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
      expect(mocks.save.mock.calls[0][0].contextSize).toBeNull();
    });

    it("a URL edit clears the status and aborts its request in the backend", async () => {
      const pending = deferred<any>();
      mocks.status.mockReturnValueOnce(pending.promise);
      await openDialog();
      await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1));
      const requestId = mocks.status.mock.calls[0][1];
      await screen.findByText("Checking the server...");

      fireEvent.input(screen.getByDisplayValue("http://127.0.0.1:11434"), {
        target: { value: "http://127.0.0.1:11435" },
      });
      expect(mocks.cancelListModels).toHaveBeenCalledWith(requestId);
      // The late answer for the old URL is ignored.
      pending.resolve({ requestId, kind: "too_old", version: "0.1.0" });
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByText(/Update Ollama/)).toBeNull();
    });

    it("closing the dialog aborts a pending status request", async () => {
      const pending = deferred<any>();
      mocks.status.mockReturnValueOnce(pending.promise);
      const view = render(
        <AiAssistantSettingsDialog open onClose={() => {}} />
      );
      await screen.findByDisplayValue("My Ollama");
      await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1));
      const requestId = mocks.status.mock.calls[0][1];
      view.rerender(
        <AiAssistantSettingsDialog open={false} onClose={() => {}} />
      );
      await waitFor(() =>
        expect(mocks.cancelListModels).toHaveBeenCalledWith(requestId)
      );
      pending.resolve({ requestId, kind: "native", version: "0.40.4" });
    });

    it("changing the default model re-queries the status", async () => {
      mocks.list.mockResolvedValue([
        { ...LOCAL, models: ["qwen", "llama"], defaultModel: "qwen" },
      ]);
      await openDialog();
      await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: "llama" }));
      await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
      expect(mocks.status.mock.calls[1][0].defaultModel).toBe("llama");
    });

    it("removing the default model re-queries for the next one, and drops a late answer", async () => {
      mocks.list.mockResolvedValue([
        { ...LOCAL, models: ["qwen", "llama"], defaultModel: "qwen" },
      ]);
      const pending = deferred<any>();
      mocks.status.mockReturnValueOnce(pending.promise);
      await openDialog();
      await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1));
      const firstId = mocks.status.mock.calls[0][1];
      fireEvent.click(screen.getByRole("button", { name: "Remove qwen" }));
      await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
      expect(mocks.status.mock.calls[1][0].defaultModel).toBe("llama");
      expect(mocks.cancelListModels).toHaveBeenCalledWith(firstId);
      // qwen's late answer must not replace llama's status.
      pending.resolve({
        requestId: firstId,
        kind: "native",
        version: "0.40.4",
        trainedMax: 1111,
      });
      await screen.findByText(/model max 8192/);
      expect(screen.queryByText(/model max 1111/)).toBeNull();
    });

    it("removing the last model asks again with no model", async () => {
      mocks.status.mockImplementation(async (config: any, requestId: string) =>
        config.defaultModel
          ? { requestId, kind: "native", version: "0.40.4", trainedMax: 8192 }
          : { requestId, kind: "native_no_model", version: "0.40.4" }
      );
      await openDialog();
      await screen.findByText(/model max 8192/);
      fireEvent.click(screen.getByRole("button", { name: "Remove qwen" }));
      await screen.findByText(/Choose a model to see its context size/);
      expect(screen.queryByText(/model max 8192/)).toBeNull();
    });

    it("adding the first model asks for its status", async () => {
      mocks.list.mockResolvedValue([
        { ...LOCAL, models: [], defaultModel: "" },
      ]);
      mocks.status.mockImplementation(async (config: any, requestId: string) =>
        config.defaultModel
          ? { requestId, kind: "native", version: "0.40.4", trainedMax: 4096 }
          : { requestId, kind: "native_no_model", version: "0.40.4" }
      );
      await openDialog();
      await screen.findByText(/Choose a model to see its context size/);
      const picker = screen.getByRole("combobox");
      fireEvent.input(picker, { target: { value: "phi-4" } });
      fireEvent.keyDown(picker, { key: "Enter" });
      await screen.findByText(/model max 4096/);
      expect(
        mocks.status.mock.calls[mocks.status.mock.calls.length - 1][0]
          .defaultModel
      ).toBe("phi-4");
    });

    it("explains old, compatible and unreachable servers", async () => {
      for (const [kind, text] of [
        ["too_old", /Update Ollama to 0\.12\.6 or newer/],
        ["compatible", /Context size can't be set for this server/],
        ["unreachable", /Couldn't reach the server/],
        ["metadata_unavailable", /Couldn't read this model's context size/],
        ["native_no_model", /Choose a model to see its context size/],
      ] as const) {
        cleanup();
        mocks.status.mockImplementation(async (_c: any, requestId: string) => ({
          requestId,
          kind,
          version: "0.1.0",
        }));
        await openDialog();
        await screen.findByText(text);
      }
    });

    it("is not shown for cloud providers", async () => {
      mocks.list.mockResolvedValue([
        {
          id: "openai-1",
          kind: "openai",
          label: "My OpenAI",
          host: "https://api.openai.com",
          subPath: "/v1",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-5",
          models: ["gpt-5"],
          enabled: true,
          apiKeyRef: "k",
        },
      ]);
      localStorage.setItem("politedb.ai.provider.selected", "openai-1");
      render(<AiAssistantSettingsDialog open onClose={() => {}} />);
      await screen.findByDisplayValue("My OpenAI");
      expect(screen.queryByPlaceholderText("16384")).toBeNull();
      expect(mocks.status).not.toHaveBeenCalled();
    });
  });
});

describe("unsaved changes, results and Test", () => {
  const CLOUD = {
    id: "openai-1",
    kind: "openai",
    label: "Work OpenAI",
    host: "https://api.openai.com",
    subPath: "/v1",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    models: ["gpt-4.1-mini"],
    apiKeyRef: "politedb:ai:openai-1:api_key",
    enabled: true,
  };

  beforeEach(() => {
    mocks.list.mockResolvedValue([LOCAL, CLOUD]);
  });

  const rename = (value: string) =>
    fireEvent.input(screen.getByDisplayValue("My Ollama"), {
      target: { value },
    });

  it("asks in the dialog before switching provider, with Keep editing focused", async () => {
    await openDialog();
    rename("Renamed");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI/ }));
    const bar = await screen.findByRole("alertdialog");
    expect(bar).toHaveTextContent("Your changes to Renamed are not saved");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Keep editing" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByDisplayValue("Renamed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /OpenAI/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await screen.findByDisplayValue("Work OpenAI");
  });

  it("switches without asking when nothing changed", async () => {
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: /OpenAI/ }));
    await screen.findByDisplayValue("Work OpenAI");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does not count a blank name that saves as the same name", async () => {
    mocks.list.mockResolvedValue([{ ...LOCAL, label: "Ollama" }]);
    render(<AiAssistantSettingsDialog open onClose={() => {}} />);
    fireEvent.input(await screen.findByDisplayValue("Ollama"), {
      target: { value: "  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /OpenAI/ }));
    await waitFor(() =>
      expect(
        (screen.getAllByRole("textbox")[0] as HTMLInputElement).value
      ).toBe("OpenAI")
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks before closing with a typed API key; one question at a time", async () => {
    const onClose = vi.fn();
    render(<AiAssistantSettingsDialog open onClose={onClose} />);
    await screen.findByDisplayValue("My Ollama");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI/ }));
    await screen.findByDisplayValue("Work OpenAI");
    fireEvent.input(screen.getByPlaceholderText("Stored in OS keychain"), {
      target: { value: "sk-test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    await screen.findByRole("alertdialog");
    // Escape (or another close) while asking means Keep editing.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("an edit answers an open question with Keep editing", async () => {
    await openDialog();
    rename("Renamed");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI/ }));
    await screen.findByRole("alertdialog");
    fireEvent.input(screen.getByDisplayValue("Renamed"), {
      target: { value: "Renamed again" },
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByDisplayValue("Renamed again")).toBeInTheDocument();
  });

  it("Keep editing returns focus to where it was", async () => {
    await openDialog();
    rename("Renamed");
    const openai = screen.getByRole("button", { name: /OpenAI/ });
    openai.focus();
    fireEvent.click(openai);
    fireEvent.click(
      await screen.findByRole("button", { name: "Keep editing" })
    );
    await waitFor(() => expect(document.activeElement).toBe(openai));
  });

  it("nothing can be edited while a save is running", async () => {
    const pending = deferred<any>();
    mocks.save.mockReturnValue(pending.promise);
    await openDialog();
    rename("Renamed");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    expect(screen.getByDisplayValue("Renamed")).toBeDisabled();
    expect(screen.getByPlaceholderText("16384")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove qwen" })).toBeDisabled();
    mocks.list.mockResolvedValue([{ ...LOCAL, label: "Renamed" }, CLOUD]);
    pending.resolve({ ...LOCAL, label: "Renamed" });
    await waitFor(() =>
      expect(screen.getByDisplayValue("Renamed")).toBeEnabled()
    );
  });

  it("a model list arriving during Save opens nothing and adds nothing", async () => {
    await openDialog();
    await settleAutoDiscovery();
    const reload = deferred<string[]>();
    mocks.listModels.mockReturnValue(reload.promise);
    fireEvent.click(screen.getByRole("button", { name: "Reload models" }));
    await waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
    const discoveryId = mocks.listModels.mock.calls[0]![2];

    const save = deferred<any>();
    mocks.save.mockReturnValue(save.promise);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    // Saving drops the pending discovery.
    expect(mocks.cancelListModels).toHaveBeenCalledWith(discoveryId);

    reload.resolve(["new-model"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.queryByText("new-model")).toBeNull();
  });

  it("unmounting cancels a running test", async () => {
    mocks.testDraft.mockReturnValue(new Promise(() => {}));
    const view = render(<AiAssistantSettingsDialog open onClose={() => {}} />);
    await screen.findByDisplayValue("My Ollama");
    await settleAutoDiscovery();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await screen.findByRole("button", { name: "Cancel test" });
    const [, , requestId] = mocks.testDraft.mock.calls[0]!;
    view.unmount();
    expect(mocks.cancelListModels).toHaveBeenCalledWith(requestId);
  });

  it("cannot leave while a save is running", async () => {
    const pending = deferred<any>();
    mocks.save.mockReturnValue(pending.promise);
    const onClose = vi.fn();
    render(<AiAssistantSettingsDialog open onClose={onClose} />);
    await screen.findByDisplayValue("My Ollama");
    rename("Renamed");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(screen.getByRole("button", { name: /OpenAI/ }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Renamed")).toBeInTheDocument();
  });

  it("says a passing test of unsaved edits still needs Save", async () => {
    mocks.testDraft.mockResolvedValue(undefined);
    await openDialog();
    fireEvent.input(screen.getByDisplayValue("My Ollama"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Test passed. Save to keep these settings."
    );
    const [, , requestId] = mocks.testDraft.mock.calls[0]!;
    expect(requestId).toMatch(/^settings-.*:test:/);
  });

  it("explains a failed test and keeps the code; an edit clears it", async () => {
    mocks.testDraft.mockRejectedValue(
      "AI_CHAT_FAILED: 401 Unauthorized invalid_api_key"
    );
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("rejected the API key");
    expect(alert).toHaveTextContent(
      "AI_CHAT_FAILED: 401 Unauthorized invalid_api_key"
    );
    fireEvent.input(screen.getByDisplayValue("My Ollama"), {
      target: { value: "Renamed" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cancels a running test in the backend and ignores its late answer", async () => {
    const pending = deferred<void>();
    mocks.testDraft.mockReturnValue(pending.promise);
    await openDialog();
    await settleAutoDiscovery();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    const stop = await screen.findByRole("button", { name: "Cancel test" });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(stop);
    const [, , requestId] = mocks.testDraft.mock.calls[0]!;
    expect(mocks.cancelListModels).toHaveBeenCalledWith(requestId);
    expect(screen.getByRole("status")).toHaveTextContent("Test cancelled.");
    pending.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("status")).toHaveTextContent("Test cancelled.");
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
  });

  it("an invalid context size also cancels a running test", async () => {
    mocks.testDraft.mockReturnValue(new Promise(() => {}));
    await openDialog();
    await settleAutoDiscovery();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await screen.findByRole("button", { name: "Cancel test" });
    fireEvent.input(screen.getByPlaceholderText("16384"), {
      target: { value: "12" },
    });
    const [, , requestId] = mocks.testDraft.mock.calls[0]!;
    expect(mocks.cancelListModels).toHaveBeenCalledWith(requestId);
    expect(screen.getByRole("button", { name: "Test" })).toBeInTheDocument();
  });

  it("an edit during a test cancels it", async () => {
    mocks.testDraft.mockReturnValue(new Promise(() => {}));
    await openDialog();
    await settleAutoDiscovery();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await screen.findByRole("button", { name: "Cancel test" });
    fireEvent.input(screen.getByDisplayValue("My Ollama"), {
      target: { value: "Renamed" },
    });
    const [, , requestId] = mocks.testDraft.mock.calls[0]!;
    expect(mocks.cancelListModels).toHaveBeenCalledWith(requestId);
    expect(screen.getByRole("button", { name: "Test" })).toBeInTheDocument();
  });
});
