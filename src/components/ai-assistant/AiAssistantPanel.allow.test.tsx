import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  grant: vi.fn(),
  submitQuestion: vi.fn(),
  cancel: vi.fn(),
  submitArgs: null as null | { onAgentProLocked?: () => void },
}));

vi.mock("src/lib/tauri/aiAgent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/tauri/aiAgent")>()),
  aiAgentDataAccessGrant: (...a: unknown[]) => mocks.grant(...a),
}));
vi.mock("src/components/ai-assistant/hooks/useAiAssistantSubmit", () => ({
  useAiAssistantSubmit: (args: any) => ({
    ...((mocks.submitArgs = args), {}),
    canSubmit: false,
    handleSubmit: vi.fn(),
    submitQuestion: mocks.submitQuestion,
    handleCancelSubmit: mocks.cancel,
  }),
}));
vi.mock("src/lib/tauri/ai", () => ({
  aiChatCancel: vi.fn(),
  aiLegacyModelInfo: vi.fn().mockResolvedValue({ files: [] }),
}));
vi.mock("@root/src/lib/ai-assistant/providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/ai-assistant/providers")>()),
  aiProviderList: vi.fn().mockResolvedValue([
    {
      id: "p1",
      kind: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt",
      models: ["gpt"],
      enabled: true,
    },
  ]),
  getSelectedAiProviderId: () => "p1",
  setSelectedAiProviderId: vi.fn(),
}));
// Card stand-in: one button that answers "Allow".
vi.mock("src/components/ai-assistant/AiAssistantMessageCard", () => ({
  AiAssistantMessageCard: ({ message, onAllowDataAccess }: any) =>
    message.role === "assistant" ? (
      <button onClick={() => void onAllowDataAccess?.("top customers?")}>
        allow-{message.id}
      </button>
    ) : null,
}));

vi.mock("src/components/common/Popover", () => ({
  Popover: ({ children, content, open }: any) => (
    <div>
      {children}
      {open ? content : null}
    </div>
  ),
}));

vi.mock("src/components/common/Button", () => ({
  Button: ({ children, loading, ...props }: any) => (
    <button {...props} disabled={props.disabled || loading}>
      {children}
    </button>
  ),
}));

vi.mock("src/components/icons", () => ({
  ArrowDown: () => <span>arrow-down</span>,
  ArrowRightIcon: () => <span>arrow-right</span>,
  BackupIcon: () => <span>backup</span>,
  ChatPlusIcon: () => <span>new-chat</span>,
  ChevronDownIcon: () => <span>chevron-down</span>,
  DownloadIcon: () => <span>download</span>,
  MinusIcon: () => <span>minus</span>,
  MoreVerticalIcon: () => <span>more</span>,
  VaultIcon: () => <span>vault</span>,
  PlayIcon: () => <span>play</span>,
  RefreshCwIcon: () => <span>refresh</span>,
  StopIcon: () => <span>stop</span>,
  Settings: () => <span>settings</span>,
  SettingsIcon: () => <span>settings</span>,
  ShareIcon: () => <span>share</span>,
  SparklesIcon: () => <span>sparkles</span>,
  XIcon: () => <span>x</span>,
}));

import { act } from "@testing-library/preact";
import type { LicenseState } from "src/lib/tauri";
import { useLicenseStore } from "src/stores/license";
import { useProUpgradeStore } from "src/stores/proUpgrade";
import { AiAssistantPanel } from "./AiAssistantPanel";

function setPro(pro_access: boolean) {
  useLicenseStore.setState({ state: { pro_access } as LicenseState });
}

function seedChat(scope: string) {
  localStorage.setItem(
    `politedb.ai.chat.${scope}`,
    JSON.stringify({
      activeSessionId: "s",
      sessions: [
        {
          id: "s",
          title: "t",
          createdAt: 1,
          updatedAt: 1,
          providerId: "p1",
          messages: [{ id: "m", role: "assistant", text: "allow?" }],
        },
      ],
    })
  );
}

function panel(scope: string, mode: string) {
  return (
    <AiAssistantPanel
      chatSessionKey={scope}
      engine="postgres"
      tables={[]}
      columnsByTable={{}}
      runtimeConnectionId="conn-1"
      querySafetyMode={mode as any}
    />
  );
}

/** A grant that finishes only when the test says so. */
function pendingGrant() {
  let finish: () => void = () => {};
  mocks.grant.mockImplementation(
    () => new Promise<void>((resolve) => (finish = resolve))
  );
  return () => finish();
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  setPro(true);
  useProUpgradeStore.setState({ feature: null });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("a pending Allow", () => {
  it("asks again when nothing changed meanwhile", async () => {
    seedChat("a");
    const finish = pendingGrant();
    render(panel("a", "default"));
    fireEvent.click(await screen.findByText("allow-m"));
    finish();
    await waitFor(() =>
      expect(mocks.submitQuestion).toHaveBeenCalledWith("top customers?")
    );
  });

  for (const next of ["lock", "production"]) {
    it(`does not ask again after the safety mode changed to ${next}`, async () => {
      seedChat("b");
      const finish = pendingGrant();
      const view = render(panel("b", "default"));
      fireEvent.click(await screen.findByText("allow-m"));
      view.rerender(panel("b", next));
      finish();
      await waitFor(() => expect(mocks.grant).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(mocks.submitQuestion).not.toHaveBeenCalled();
    });
  }

  it("does not ask again after the panel closed", async () => {
    seedChat("c");
    const finish = pendingGrant();
    const view = render(panel("c", "default"));
    fireEvent.click(await screen.findByText("allow-m"));
    view.unmount();
    finish();
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.submitQuestion).not.toHaveBeenCalled();
  });
});

describe("agent mode without Pro", () => {
  it("opens the upgrade dialog from a saved consent card instead of granting", async () => {
    setPro(false);
    seedChat("d");
    render(panel("d", "default"));
    fireEvent.click(await screen.findByText("allow-m"));
    await waitFor(() =>
      expect(useProUpgradeStore.getState().feature).toBe("ai-agent")
    );
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.submitQuestion).not.toHaveBeenCalled();
  });

  it("does not ask again when Pro ended while the grant was saving", async () => {
    seedChat("e");
    const finish = pendingGrant();
    render(panel("e", "default"));
    fireEvent.click(await screen.findByText("allow-m"));
    await waitFor(() => expect(mocks.grant).toHaveBeenCalled());
    act(() => setPro(false));
    finish();
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.submitQuestion).not.toHaveBeenCalled();
  });

  it("maps a backend Pro refusal to the upgrade dialog", async () => {
    seedChat("f");
    mocks.grant.mockRejectedValue(new Error("AI_AGENT_PRO_REQUIRED"));
    render(panel("f", "default"));
    fireEvent.click(await screen.findByText("allow-m"));
    await waitFor(() =>
      expect(useProUpgradeStore.getState().feature).toBe("ai-agent")
    );
    expect(mocks.submitQuestion).not.toHaveBeenCalled();
  });

  it("allows again only on an explicit click after upgrading", async () => {
    setPro(false);
    seedChat("g");
    render(panel("g", "default"));
    fireEvent.click(await screen.findByText("allow-m"));
    act(() => setPro(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.grant).not.toHaveBeenCalled();
    mocks.grant.mockResolvedValue(undefined);
    fireEvent.click(screen.getByText("allow-m"));
    await waitFor(() =>
      expect(mocks.submitQuestion).toHaveBeenCalledWith("top customers?")
    );
  });

  it("shows the upgrade hint once per chat and remembers a dismissal", async () => {
    setPro(false);
    seedChat("h");
    render(panel("h", "default"));
    await screen.findByText("allow-m");
    act(() => mocks.submitArgs?.onAgentProLocked?.());
    expect(await screen.findByText(/is a Pro feature/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText(/is a Pro feature/)).toBeNull();
    act(() => mocks.submitArgs?.onAgentProLocked?.());
    expect(screen.queryByText(/is a Pro feature/)).toBeNull();
    expect(localStorage.getItem("politedb.ai.agentProHint.dismissed")).toBe(
      "1"
    );
  });
});
